/**
 * Runtime façade — the two capabilities the lib core exposes over a LoadedApp:
 *   describe()  -> the app's public manifest (App + Actions + Auth)
 *   invoke()    -> run an Action through the Invocation resolution sequence
 *
 * Credential handling lives here. The host passes the full Connection (with its
 * opaque credential) into invoke(). The runtime:
 *   - exposes only the REDACTED connection to the action hook;
 *   - routes every outbound request the action makes through the `sign` hook,
 *     which runs in its own network-less worker and is the only code given the
 *     credential;
 *   - performs the real network call itself, after an egress allowlist check.
 */
import type {
  Action,
  AppManifest,
  Auth,
  Connection,
  ConnectionBinding,
  FileRef,
  HealthCheck,
  InterfaceConformance,
  Invocation,
  RedactedConnection,
  RequestOverrides,
  ResolvedAuthorization,
  ResolveFieldsInput,
  ResolveFieldsOutput,
  SignableRequest,
  Trigger,
  TriggerHookKind,
} from "@w6w/types";
import { redact } from "@w6w/types";
import { hookSource } from "./loader.ts";
import type { LoadedApp, LoadedAuth } from "./loader.ts";
import { applyOverrides, dedupeSignedHeaders, selectsRequest } from "./overrides.ts";
import { resolveParams } from "./resolve.ts";
import { runHook } from "./sandbox/run-hook.ts";
import type { WireResponse } from "./sandbox/protocol.ts";
import { egressFailure, type EgressInfo, egressInfo } from "./egress.ts";
import { credentialError, W6WError } from "./errors.ts";
import {
  type CredentialPurpose,
  type CredentialResolver,
  pickDerivedToken,
} from "./authorization.ts";
import { RESOLVE_FIELDS_TIMEOUT_MS, sanitizeResolveFieldsOutput } from "./resolve-fields.ts";
import { openConnectionSocket, type SocketSession } from "./socket.ts";

export type { EgressInfo };
export { DEFAULT_EGRESS_BODY_LIMIT } from "./egress.ts";

export interface AppDescription {
  app: AppManifest;
  actions: Action[];
  auth: Auth[];
  triggers: Trigger[];
  /** Declared, promoted and derived checks — the whole health surface. */
  health: HealthCheck[];
  /** This app's Interface conformance assertions. */
  interfaces: InterfaceConformance[];
}

export interface InvokeOptions {
  /** The full Connection, including its opaque credential. Held by the host; never exposed to the action. */
  connection?: Connection;
  timeoutMs?: number;
  onLog?: (level: string, message: string, data?: unknown) => void;
  /**
   * Observability hook: called once per outbound request the action/trigger
   * makes — including requests that failed before a response (`status: 0` and
   * `error` set).
   */
  onEgress?: (info: EgressInfo) => void;
  /**
   * Capture the full URL, headers and bodies of each outbound request on
   * `onEgress` (credentials redacted). Off by default: the record then carries
   * only the metering fields.
   */
  captureEgress?: boolean;
  /** Per-body cap for `captureEgress`, in bytes. Defaults to 32 KiB. */
  egressBodyLimit?: number;
  /**
   * Host-mediated `ctx.file.read`/`ctx.file.create` implementations. Both must
   * be supplied for `ctx.file` to be enabled in the sandbox (DC-3: a
   * conforming host implements the whole two-method capability or none of
   * it). The `sign` hook never receives either — same reason it gets no
   * `onFetch` today (below, `signingFetch`'s `runHook` call for `sign`).
   */
  onFileRead?: (refId: string) => Promise<{ ref: FileRef; bytes: Uint8Array }>;
  onFileCreate?: (
    input: { bytes: Uint8Array; contentType: string; filename: string },
  ) => Promise<FileRef>;
  /**
   * Replace the `sign` hook AND host egress as ONE unit (rfcs/hook-runtime.md
   * `ctx.fetch` steps 1-2: "the host" is both the spoke, which owns step 1, and
   * this transport's implementer — the hub — which owns step 1 again plus
   * step 2's `sign`). When set, `signingFetch` hands it the request
   * post-override and pre-sign-checked, but UNSIGNED — the transport is the
   * only thing that touches the wire, so no local `sign` hook runs and no
   * local host egress happens. Every other credential-bearing path is refused
   * while this is set: a Connection carrying a credential, a `needs_refresh`
   * Connection (`refresh` never runs), and a Connection with a socket
   * `target` (no connect is attempted). Unset, behaviour is unchanged.
   */
  egressTransport?: (request: SignableRequest) => Promise<WireResponse>;
  /**
   * The host's owner of the credential source and its refresh. When set,
   * `prepareAuthorization` asks it for the Connection's authorization instead of
   * reading `connection.credential`, and core never runs the Auth `refresh`
   * hook. Unset, behaviour is unchanged. Never consulted under `egressTransport`.
   */
  credentialResolver?: CredentialResolver;
}

export interface InvokeResult {
  value: unknown;
}

/** Return the app's public description. */
export function describe(app: LoadedApp): AppDescription {
  return {
    app: app.manifest,
    actions: [...app.actions.values()].map((a) => {
      const appPorts = app.manifest.ports;
      const actionPorts = a.definition.ports;
      if (appPorts === undefined && actionPorts === undefined) return a.definition;
      // Field-wise fold (action wins); a copy — never mutate the loaded definition.
      return { ...a.definition, ports: { ...appPorts, ...actionPorts } };
    }),
    auth: app.auths.map((a) => a.auth),
    triggers: [...app.triggers.values()].map((t) => t.trigger),
    health: [...app.healthChecks.values()].map((h) => h.check),
    interfaces: app.interfaces,
  };
}

/**
 * Pick the LoadedAuth a Connection refers to, by `auth` key. Strict: a key the
 * app does not declare throws `auth_not_found` rather than falling back to some
 * other auth, because signing a Connection with a different auth method's hooks
 * is a credential-confusion bug, not a convenience. The message names keys and
 * ids only, never a credential.
 */
export function authFor(app: LoadedApp, connection: Connection): LoadedAuth {
  const found = app.auths.find((a) => a.auth.key === connection.auth);
  if (!found) {
    throw credentialError(
      "auth_not_found",
      `Connection "${connection.id}" names auth "${connection.auth}", which app ` +
        `"${app.manifest.id}" does not declare.`,
    );
  }
  return found;
}

/**
 * Does `host` satisfy one entry of `w6w.network.allow`?
 *
 * Exact hostnames are the norm. Two wildcard forms exist because a whole class
 * of SaaS APIs is addressed by a *per-tenant* host that no manifest can
 * enumerate ahead of time — `acme.zendesk.com`, `acme.myshopify.com`,
 * `acme.my.salesforce.com`, or a self-hosted WordPress at an arbitrary domain:
 *
 *   - `"*.zendesk.com"` — any subdomain, at any depth, of `zendesk.com`. The
 *     apex itself is NOT matched: it is a different host and should be listed
 *     separately if the app really calls it.
 *   - `"*"` — any host. This opts the app out of egress restriction entirely,
 *     so it is only appropriate for apps whose endpoint is a user-supplied URL
 *     (self-hosted installs). Hosts SHOULD surface it prominently at install.
 *
 * Matching is case-insensitive; hostnames from `URL` are already lowercased.
 */
export function hostAllowed(allowlist: readonly string[], host: string): boolean {
  for (const entry of allowlist) {
    if (entry === "*") return true;
    const pattern = entry.toLowerCase();
    if (pattern === host) return true;
    if (pattern.startsWith("*.") && host.endsWith(pattern.slice(1))) return true;
  }
  return false;
}

/** Redirect statuses `hostFetch` will consider following on the SAME host. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Same-host redirects `hostFetch` follows before giving up on a loop. */
const MAX_SAME_HOST_REDIRECTS = 5;

/**
 * Perform a request on the host: enforce the allowlist, then fetch — in
 * manual-redirect mode, since "follow" cannot be selected per-host (the
 * option is chosen before the destination is known). Every redirect
 * therefore surfaces here first:
 *   - a redirect to a DIFFERENT hostname is refused outright, with the same
 *     `egress_denied` shape as the initial allowlist check. It is never
 *     followed and never re-checked against the allowlist — the rule is "the
 *     host changed", not "the new host happens to also be allowed".
 *   - a redirect to the SAME hostname is re-issued by this function itself,
 *     per the Fetch spec's method/body rules (`303`, or `301`/`302` with a
 *     non-`GET`/`HEAD` method, drop to `GET` with no body; `307`/`308`
 *     preserve both). Headers carry forward unchanged: same host, so the
 *     signed credential legitimately travels.
 * The loop is capped at `MAX_SAME_HOST_REDIRECTS` hops; past that it throws
 * `too_many_redirects` rather than let a self-redirecting host hang the
 * invocation until the timeout.
 *
 * `timeoutMs` mirrors `runHook`'s own default (`sandbox/run-hook.ts`, 30s) —
 * the sandboxed hook wrapping this call is already bounded, but this bare
 * `fetch` was not: a stalled third-party host (no error, just silence) hung
 * the whole invocation forever, with nothing to show for it since no promise
 * ever settled (surfaced by the repo-sync feature's "Sync now" never
 * resolving). The `AbortController`/timer spans the WHOLE redirect loop, not
 * one hop, so the 30s bound stays per request, as it was before redirects
 * were followed here.
 */
async function hostFetch(
  allowlist: string[],
  req: SignableRequest,
  timeoutMs = 30_000,
): Promise<WireResponse> {
  let host: string;
  try {
    host = new URL(req.url).hostname;
  } catch {
    throw new W6WError(
      "invalid_request_url",
      "execute",
      `Hook produced an invalid URL: ${req.url}`,
    );
  }
  if (!hostAllowed(allowlist, host)) {
    throw new W6WError(
      "egress_denied",
      "execute",
      `Request to "${host}" is not in the app's network allowlist.`,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let currentUrl = req.url;
    let method = req.method;
    let body = req.body ?? undefined;
    let hop = 0;
    for (;;) {
      let res: Response;
      try {
        res = await fetch(currentUrl, {
          method,
          headers: req.headers,
          // A5 (runtime.ts:180): a Uint8Array body passes through to the real
          // fetch UNCHANGED — no stringify, no re-encode. Deno's own `lib`
          // types this call's `body` as `BufferSource | ... | string`, which
          // structurally includes `Uint8Array` at runtime (confirmed:
          // `fetch`'s body accepts a `Uint8Array` directly in Deno), but the
          // compiler's overload resolution here narrows on the union in a way
          // that rejects it type-only — the cast documents that mismatch
          // rather than papering over an actual behavior change.
          body: body as BodyInit | null | undefined,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new W6WError(
            "fetch_timeout",
            "execute",
            `Request to "${host}" timed out after ${timeoutMs}ms.`,
          );
        }
        throw err;
      }
      const location = res.headers.get("location");
      if (!REDIRECT_STATUSES.has(res.status) || !location) {
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = v));
        return {
          status: res.status,
          statusText: res.statusText,
          headers,
          body: new Uint8Array(await res.arrayBuffer()),
        };
      }
      // A redirect response body is never used; drain it before moving on.
      await res.body?.cancel();
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        throw new W6WError(
          "invalid_request_url",
          "execute",
          `Redirect from "${host}" carries an invalid Location: ${location}`,
        );
      }
      if (next.hostname !== host) {
        throw new W6WError(
          "egress_denied",
          "execute",
          `Redirect from "${host}" to "${next.hostname}" crosses hosts; refused.`,
        );
      }
      hop++;
      if (hop > MAX_SAME_HOST_REDIRECTS) {
        throw new W6WError(
          "too_many_redirects",
          "execute",
          `Exceeded ${MAX_SAME_HOST_REDIRECTS} same-host redirects from "${host}".`,
        );
      }
      const methodUpper = method.toUpperCase();
      const dropsBody = res.status === 303 ||
        ((res.status === 301 || res.status === 302) && methodUpper !== "GET" &&
          methodUpper !== "HEAD");
      if (dropsBody) {
        method = "GET";
        body = undefined;
      }
      currentUrl = next.toString();
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the fetch handler a hook's `ctx.fetch` routes through: run the auth
 * `sign` hook (network-less, the only code holding the credential), perform the
 * real request on the host, and report the result to `onEgress`.
 *
 * Shared by `invoke`, `invokeTriggerHook` and `checkHealth` so every surface
 * signs, enforces the allowlist and observes egress identically.
 *
 * `allowlist` is explicit rather than read off the app, because a health check
 * runs under a composed allowlist — the app's hosts plus its own — and that
 * widening is only ever granted to an UNSIGNED check. Passing `auth: undefined`
 * is how a caller says "do not sign this".
 */
export function signingFetch(
  app: LoadedApp,
  auth: LoadedAuth | undefined,
  credential: unknown,
  opts: InvokeOptions,
  allowlist: string[] = app.netAllowlist,
  overrides?: RequestOverrides,
): (request: SignableRequest) => Promise<WireResponse> {
  const canSign = !!auth?.hooks.has("sign");
  // Per-invocation counters, closed over so `target: "first"` / `"first-write"`
  // mean the first request of THIS invocation — the handler is built fresh for
  // each `invoke()`, so there is no state to leak between runs.
  let index = 0;
  let writeIndex = 0;
  return async (request: SignableRequest): Promise<WireResponse> => {
    // Caller overrides are merged BEFORE `sign` runs, but ordering alone does
    // not keep an override from riding beside auth: header keys are
    // case-sensitive in JS while Fetch comma-joins case variants, so an
    // override `Authorization` survives next to a `sign` that writes
    // `authorization`. The post-sign `dedupeSignedHeaders` below (case-
    // insensitive, signer's write wins) is what guarantees an override can add
    // a header but never hijack authentication.
    let outgoing = request;
    if (overrides && selectsRequest(overrides, request, { index, writeIndex })) {
      outgoing = applyOverrides(request, overrides);
    }
    index++;
    if (!["GET", "HEAD"].includes(request.method.toUpperCase())) writeIndex++;

    let signed = outgoing;
    // Pre-sign destination check (rfcs/hook-runtime.md `ctx.fetch` step 1, run
    // before step 2's signing): checked on `outgoing` — the post-override
    // request, never the raw `request` and never `signed` — so a `sign` hook
    // cannot rescue an off-allowlist destination by rewriting it, and its
    // worker is never even spawned for one. This is ADDITIONAL to, not a
    // replacement for, `hostFetch`'s own check below: that one still guards
    // the SIGNED request, in case `sign` itself rewrites the destination off
    // the allowlist.
    {
      let destHost: string;
      try {
        destHost = new URL(outgoing.url).hostname;
      } catch {
        throw new W6WError(
          "invalid_request_url",
          "execute",
          `Hook produced an invalid URL: ${outgoing.url}`,
        );
      }
      if (!hostAllowed(allowlist, destHost)) {
        throw new W6WError(
          "egress_denied",
          "execute",
          `Request to "${destHost}" is not in the app's network allowlist.`,
        );
      }
    }
    if (canSign && auth && !opts.egressTransport) {
      // `sign` runs in its own worker with NO network, and is the only code
      // given the (live, post-refresh) credential. It injects auth. Skipped
      // when `egressTransport` is set: that transport replaces `sign` AND
      // host egress as one unit, so no credential-bearing hook runs here.
      signed = await runHook<SignableRequest>({
        ...hookSource(app),
        selector: { kind: "auth", key: auth.auth.key, hook: "sign" },
        input: { request: outgoing, credential },
        timeoutMs: opts.timeoutMs,
        // no onFetch -> the sign worker cannot make network calls.
      });
    }
    // Unconditional: also covers callers that never pass overrides (the hub
    // signer hands in a spoke-merged request). When `sign` did not run,
    // `signed === outgoing` and this is a no-op.
    signed = dedupeSignedHeaders(outgoing, signed);
    const capture = { capture: opts.captureEgress, bodyLimit: opts.egressBodyLimit, durationMs: 0 };
    const egressStart = Date.now();
    try {
      const res = opts.egressTransport
        ? await opts.egressTransport(signed)
        : await hostFetch(allowlist, signed, opts.timeoutMs);
      opts.onEgress?.(
        egressInfo(signed, res, { ...capture, durationMs: Date.now() - egressStart }),
      );
      return res;
    } catch (err) {
      // A denied/failed request is still an egress event worth observing.
      opts.onEgress?.(
        egressFailure(signed, err, { ...capture, durationMs: Date.now() - egressStart }),
      );
      throw err;
    }
  };
}

/**
 * `runHook`'s worker boundary forwards only an Error's `.message` across
 * `postMessage`, dropping `.code` (the same problem `runAuthHook`'s
 * `deniedByAllowlist` flag already solves for the credential-lifecycle
 * hooks) — so a request this runtime's own `onFetch` denies itself (the
 * pre-sign check, `hostFetch`'s allowlist/redirect checks, or the hop cap)
 * comes back from `runHook` as a generic `hook_failed`, indistinguishable
 * from the hook's own business-logic failure. Wraps `onFetch` to remember
 * the last `W6WError` it raised, and returns an `unwrap` that restores it in
 * place of that generic wrapper — but only when the incoming `hook_failed`'s
 * message matches the remembered denial's message (`run-hook.ts` forwards
 * the underlying error's `.message` faithfully, so a genuine re-surfaced
 * denial and its remembered copy share the exact string). A no-op for any
 * other error, including a later, unrelated failure that merely happens to
 * reach `runHook` after an earlier denial the hook itself caught and
 * swallowed.
 */
function withDeniedUnwrap(
  onFetch: (request: SignableRequest) => Promise<WireResponse>,
): {
  onFetch: (request: SignableRequest) => Promise<WireResponse>;
  unwrap: (err: unknown) => never;
} {
  let denied: W6WError | undefined;
  return {
    onFetch: async (request: SignableRequest): Promise<WireResponse> => {
      try {
        return await onFetch(request);
      } catch (err) {
        if (err instanceof W6WError) denied = err;
        throw err;
      }
    },
    unwrap: (err: unknown): never => {
      if (
        denied && err instanceof W6WError && err.code === "hook_failed" &&
        err.message === denied.message
      ) {
        throw denied;
      }
      throw err;
    },
  };
}

export interface PrepareAuthorizationOptions {
  purpose: CredentialPurpose;
  credentialResolver?: CredentialResolver;
  egressTransport?: InvokeOptions["egressTransport"];
  timeoutMs?: number;
}

export interface PreparedAuthorization {
  /** What the host (or the legacy path) resolved for this preparation. */
  authorization: ResolvedAuthorization;
  /** Exactly what the `sign`/`handshake` hook receives as `credential`. */
  signCredential: unknown;
  /** The redacted projection exposed to the action. */
  redacted: RedactedConnection;
}

/**
 * The one host-realm seam every Connection's authorization passes through
 * (`invoke`, `invokeTriggerHook`, `invokeResolveFields`, a signed health check).
 * It runs on the HOST side of the worker boundary; what it returns as
 * `signCredential` is the only credential-bearing value placed in a `sign` or
 * `handshake` worker's input.
 *
 * Applies the Connection lifecycle gates first (`pending`/`revoked`/`broken`
 * throw their codes before any resolver is consulted). Then:
 *   - `egressTransport` set: the transport owns signing AND egress, so no
 *     credential-bearing path may run — the resolver is never called and the
 *     result is `{ kind: "none" }`;
 *   - a `credentialResolver`: it owns the source and refresh. For `connected` and
 *     `needs_refresh` it is called exactly once; core never reads
 *     `connection.credential` and never runs `refresh`;
 *   - neither: today's behaviour — the Connection's own opaque credential, with
 *     the in-core `needs_refresh` -> `refresh` arm for embedders without a server.
 */
export async function prepareAuthorization(
  app: LoadedApp,
  auth: LoadedAuth,
  connection: Connection,
  opts: PrepareAuthorizationOptions,
): Promise<PreparedAuthorization> {
  const conn = connection;
  if (opts.egressTransport) {
    // `egressTransport` replaces `sign` AND host egress as one unit; no
    // credential-bearing path may run under it. Strict `!== undefined` (not
    // `!= null`): a proxy-mode Connection OMITS the field entirely.
    if (conn.credential !== undefined) {
      throw new W6WError(
        "egress_transport_conflict",
        "auth",
        "egressTransport is set; the Connection must not carry a credential.",
      );
    }
    if (conn.state === "needs_refresh") {
      throw new W6WError(
        "egress_transport_conflict",
        "auth",
        "egressTransport is set; a needs_refresh Connection cannot run the refresh hook here.",
      );
    }
  }
  switch (conn.state) {
    case "connected":
      break;
    case "pending":
      throw new W6WError(
        "connection_pending",
        "auth",
        "Connection is pending; finish the auth flow.",
      );
    case "revoked":
      throw new W6WError("connection_revoked", "auth", "Connection was revoked; reconnect.");
    case "broken":
      throw new W6WError("connection_broken", "auth", "Connection is broken; reconnect.");
    case "needs_refresh":
      break;
    default:
      throw new W6WError(
        "connection_broken",
        "auth",
        `Unknown connection state "${(conn as Connection).state}".`,
      );
  }

  if (opts.egressTransport) {
    return { authorization: { kind: "none" }, signCredential: undefined, redacted: redact(conn) };
  }

  if (opts.credentialResolver) {
    const authorization = await opts.credentialResolver.prepare({
      connection: conn,
      authKey: auth.auth.key,
      purpose: opts.purpose,
    });
    // `redact` is an explicit pick that never touches `credential`; the state
    // is then pinned to what the action sees after a (resolver-owned) refresh.
    const redacted: RedactedConnection = { ...redact(conn), state: "connected" };
    switch (authorization.kind) {
      case "none":
        return { authorization, signCredential: undefined, redacted };
      case "legacyOpaque":
        return { authorization, signCredential: authorization.credential, redacted };
      case "derived": {
        // The DerivedToken and nothing else: not the wrapper, not any extra member.
        return {
          authorization,
          signCredential: pickDerivedToken(authorization.token),
          redacted,
        };
      }
      default:
        throw credentialError(
          "provider_unsupported",
          `Credential resolver returned an unsupported authorization kind ` +
            `"${(authorization as { kind: unknown }).kind}".`,
        );
    }
  }

  // Legacy path (no resolver), preserved verbatim.
  if (conn.state === "needs_refresh") {
    if (!auth.hooks.has("refresh")) {
      throw new W6WError(
        "connection_broken",
        "auth",
        "Connection needs refresh but its auth method has no `refresh` hook.",
      );
    }
    let credential: unknown;
    try {
      // `refresh` gets the old credential and an un-signed, host-mediated
      // fetch (to reach the token endpoint). On success it returns the new
      // credential; any failure transitions the connection to broken.
      credential = await runHook({
        ...hookSource(app),
        selector: { kind: "auth", key: auth.auth.key, hook: "refresh" },
        input: { credential: conn.credential },
        timeoutMs: opts.timeoutMs,
        onFetch: (req) => hostFetch(app.netAllowlist, req, opts.timeoutMs),
      });
    } catch (e) {
      throw new W6WError("connection_broken", "auth", `Refresh failed: ${(e as Error).message}`);
    }
    const refreshed: Connection = { ...conn, credential, state: "connected" };
    return {
      authorization: { kind: "legacyOpaque", source: "stored", credential, sourceRevision: null },
      signCredential: credential,
      redacted: redact(refreshed),
    };
  }
  return {
    authorization: {
      kind: "legacyOpaque",
      source: "stored",
      credential: conn.credential,
      sourceRevision: null,
    },
    signCredential: conn.credential,
    redacted: redact(conn),
  };
}

/**
 * The Auth hooks whose declared input is exactly `{ credential: unknown }`.
 * `sign` is excluded (network-less by RFC); `preflight` (input `unknown`) and
 * `exchange` (input `{fields?, code?, redirectUri?}`) take other shapes.
 */
export type CredentialHookKind = "test" | "afterConnect" | "refresh" | "revoke";

const CREDENTIAL_HOOK_KINDS: readonly CredentialHookKind[] = [
  "test",
  "afterConnect",
  "refresh",
  "revoke",
];

export interface RunAuthHookOptions {
  timeoutMs?: number;
  onLog?: (level: string, message: string, data?: unknown) => void;
  /**
   * Signed mode (D-A3) for a provider-derived auth: `test`/`afterConnect` run with
   * `credential: null` and a `ctx.fetch` signed by the auth's networkless `sign`
   * hook from `authorization`'s derived token, under the app's allowlist. The hook
   * input is `{ credential: null }` plus exactly `binding` / `credentialDisplay`
   * when present (absent keys omitted) — nothing else is ever forwarded.
   */
  signing?: {
    authorization: ResolvedAuthorization;
    binding?: ConnectionBinding;
    credentialDisplay?: Record<string, string>;
  };
}

/**
 * Run one of an Auth method's credential-bearing lifecycle hooks — `test`,
 * `afterConnect`, `refresh` or `revoke` — in the same least-privilege sandbox
 * `invoke` uses, with host-mediated, allowlist-enforced egress. This is the
 * `prepareAuthorization` `needs_refresh` branch's mechanism, generalized by hook
 * name so `afterConnect` and `test` don't need their own copy.
 *
 * `sign` is refused, at runtime as well as in the `CredentialHookKind` type: it
 * is the one Auth hook whose `ctx.fetch` is removed entirely (credential
 * isolation, see rfcs/hook-runtime.md "Credential isolation") — routing it
 * through here would hand it the host-mediated egress the spec forbids it.
 */
export async function runAuthHook<T = unknown>(
  app: LoadedApp,
  auth: LoadedAuth,
  hook: CredentialHookKind,
  credential: unknown,
  opts: RunAuthHookOptions = {},
): Promise<T> {
  // Runtime guard, not just a type: a JS caller (or a TS caller casting past
  // the type) must still be refused. `sign` is network-less by RFC.
  if (!CREDENTIAL_HOOK_KINDS.includes(hook)) {
    throw new W6WError(
      "invalid_credential_hook",
      "auth",
      `Auth "${auth.auth.key}" hook "${hook}" is not a credential-bearing hook ` +
        `runAuthHook can run — "sign" is network-less by RFC and never routes through here.`,
    );
  }
  const signing = opts.signing;
  if (signing) {
    // Signed mode exists for the hooks that only PROBE with the credential. A
    // `refresh`/`revoke` needs the credential source itself, which a derived
    // token is not — so they cannot run credential-less.
    if (hook !== "test" && hook !== "afterConnect") {
      throw new W6WError(
        "invalid_credential_hook",
        "auth",
        `Auth "${auth.auth.key}" hook "${hook}" cannot run in signed mode; ` +
          `only "test" and "afterConnect" can.`,
      );
    }
  }
  if (!auth.hooks.has(hook)) {
    throw new W6WError(
      "hook_not_declared",
      "auth",
      `Auth "${auth.auth.key}" does not declare hook "${hook}".`,
    );
  }
  if (signing) {
    // Checked before any worker spawns: a signed fetch needs a `sign` hook.
    if (!auth.hooks.has("sign")) {
      throw new W6WError(
        "hook_not_declared",
        "auth",
        `Auth "${auth.auth.key}" declares no "sign" hook, so hook "${hook}" cannot run signed.`,
      );
    }
    if (signing.authorization.kind !== "derived") {
      throw credentialError(
        "provider_unsupported",
        `Signed mode needs a derived authorization; got "${signing.authorization.kind}".`,
      );
    }
  }
  // Set from INSIDE our own `onFetch`, on the host side of the worker
  // boundary — the moment we observe hostFetch itself deny the request, not
  // by matching text after the fact. `runHook`'s worker boundary
  // (sandbox/run-hook.ts + worker.ts, out of scope here) forwards only an
  // Error's `.message` across `postMessage`, dropping `.code`, so a denied
  // fetch would otherwise come back re-wrapped as a generic `hook_failed`
  // indistinguishable from any other hook failure. This flag is set by code
  // we wrote, observing our own call to `hostFetch`, so it can never be
  // tripped by a hook's own unrelated error — including one that merely
  // happens to end with the same wording `hostFetch` uses.
  let deniedByAllowlist = false;
  // Signed mode: the hook's fetch goes through `signingFetch` with the derived
  // token (the pre-sign egress check and `sign` included), and the hook input
  // is rebuilt from scratch — the positional `credential` is never read.
  const doFetch = signing
    ? signingFetch(
      app,
      auth,
      pickDerivedToken(
        (signing.authorization as Extract<ResolvedAuthorization, { kind: "derived" }>).token,
      ),
      { timeoutMs: opts.timeoutMs, onLog: opts.onLog },
      app.netAllowlist,
    )
    : (req: SignableRequest) => hostFetch(app.netAllowlist, req, opts.timeoutMs);
  const hookInput: Record<string, unknown> = signing
    ? {
      credential: null,
      ...(signing.binding !== undefined ? { binding: signing.binding } : {}),
      ...(signing.credentialDisplay !== undefined
        ? { credentialDisplay: signing.credentialDisplay }
        : {}),
    }
    : { credential };
  try {
    return await runHook<T>({
      ...hookSource(app),
      selector: { kind: "auth", key: auth.auth.key, hook },
      input: hookInput,
      timeoutMs: opts.timeoutMs,
      onLog: opts.onLog,
      onFetch: async (req) => {
        try {
          return await doFetch(req);
        } catch (fetchErr) {
          if (fetchErr instanceof W6WError && fetchErr.code === "egress_denied") {
            deniedByAllowlist = true;
          }
          throw fetchErr;
        }
      },
    });
  } catch (err) {
    if (deniedByAllowlist && err instanceof W6WError && err.code === "hook_failed") {
      throw new W6WError("egress_denied", "auth", err.message, err.details);
    }
    throw err;
  }
}

/**
 * Execute an Action, following the Invocation RFC's resolution sequence:
 * resolve action -> prepare authorization (lifecycle gates + resolver/refresh) -> resolve
 * params -> invoke `execute` in the sandbox, signing outbound requests.
 */
export async function invoke(
  app: LoadedApp,
  invocation: Invocation,
  opts: InvokeOptions = {},
): Promise<InvokeResult> {
  // 1. Resolve Action.
  if (invocation.app !== app.manifest.id) {
    throw new W6WError(
      "unknown_app",
      "resolution",
      `Invocation targets "${invocation.app}" but this runtime loaded "${app.manifest.id}".`,
    );
  }
  const loaded = app.actions.get(invocation.action);
  if (!loaded) {
    throw new W6WError("unknown_action", "resolution", `Unknown action "${invocation.action}".`);
  }

  // 2. Resolve Connection — apply the lifecycle gates, refreshing if needed.
  const auth = opts.connection ? authFor(app, opts.connection) : undefined;
  let credential: unknown;
  let redacted: RedactedConnection | undefined;
  if (opts.connection && auth) {
    ({ signCredential: credential, redacted } = await prepareAuthorization(
      app,
      auth,
      opts.connection,
      {
        purpose: opts.connection.target ? "socket" : "invoke",
        credentialResolver: opts.credentialResolver,
        egressTransport: opts.egressTransport,
        timeoutMs: opts.timeoutMs,
      },
    ));
  } else if (invocation.connection) {
    throw new W6WError(
      "unknown_connection",
      "auth",
      `Invocation references connection "${invocation.connection}" but none was provided.`,
    );
  } else if (app.auths.length > 0) {
    throw new W6WError(
      "connection_required",
      "auth",
      `Action "${invocation.action}" requires a connection — the app declares auth.`,
    );
  }
  // 3. Resolve params.
  const resolved = resolveParams(loaded.definition.params ?? [], invocation.params ?? {});

  // 4. Build the signing fetch handler the action's ctx.fetch routes through.
  const { onFetch, unwrap } = withDeniedUnwrap(
    signingFetch(app, auth, credential, opts, app.netAllowlist, invocation.overrides),
  );

  // 5. Open ctx.socket when, and only when, the Connection carries a target
  // AND the App declares the `socket` capability (hook-runtime.md:144-146,
  // amended by T1.1.1 — `ctx.socket` is present "only ... when the App
  // declares the socket capability ... and the Connection carries a
  // target"): real connect/TLS (target-checked, DC-3), then the auth
  // `handshake` loop (DC-1) — both before `execute()` ever runs, so the
  // action always gets an already-open, already-authenticated stream, never
  // a bare `open()` to call itself (`SocketHandle` has none). Closed in the
  // `finally` below no matter how `execute` (or opening/handshaking itself)
  // turns out, so a socket can never outlive this invocation.
  //
  // `app.manifest.capabilities?.socket` is read ONLY at this one presence
  // gate — a target-bearing Connection on an App that never declared the
  // capability fails fast as `socket_unavailable` (hook-runtime.md:319),
  // before any DNS resolution or `Deno.connect` attempt. This is a distinct
  // decision from *which* targets are allowed: it never touches, and must
  // never be threaded into, `checkTarget`/`socket.ts`'s private-range
  // predicate (DC-5 stays: capability declaration is for publish-time
  // review, not target enforcement).
  let socket: SocketSession | undefined;

  // 6. Invoke the action's `execute` in the sandbox.
  let value: unknown;
  try {
    if (opts.connection?.target) {
      if (opts.egressTransport) {
        throw new W6WError(
          "egress_transport_conflict",
          "execute",
          `egressTransport is set; Connection "${opts.connection.id}" carries a socket ` +
            `target, which cannot run under it.`,
        );
      }
      if (!app.manifest.capabilities?.socket) {
        throw new W6WError(
          "socket_unavailable",
          "execute",
          `App "${app.manifest.id}" does not declare the "socket" capability; ` +
            `Connection "${opts.connection.id}" carries a target.`,
        );
      }
      socket = await openConnectionSocket(app, auth, opts.connection.target, credential, opts);
    }
    value = await runHook({
      ...hookSource(app),
      selector: { kind: "action", key: loaded.definition.key },
      input: resolved,
      connection: redacted,
      invocation: invocation.context,
      timeoutMs: opts.timeoutMs,
      onLog: opts.onLog,
      onFetch,
      onSocket: socket?.onSocket,
      onFileRead: opts.onFileRead,
      onFileCreate: opts.onFileCreate,
    });
  } catch (err) {
    unwrap(err);
  } finally {
    socket?.close();
  }

  return { value };
}

// ── Trigger hook invocation ────────────────────────────────────────────────

/**
 * Run one of a trigger's lifecycle hooks in the sandbox. Auth is handled the
 * same way as for actions: the trigger sees a redacted connection; outbound
 * fetches route through the auth `sign` hook when the app declares one.
 *
 * Hook-generic: any of the five `TRIGGER_HOOK_KINDS` the trigger declares.
 * Host callers:
 *   - registration (subscription create / publish) → "onSubscribe"
 *   - destroy (subscription delete / any dependency deleted) → "onUnsubscribe"
 *   - the HTTPS listener, per inbound call → "handleIngest" (input `raw` is the whole call)
 *   - the poll ticker, per due subscription → "poll"
 *   - the dispatcher, before starting a run → "parseOutput"
 */
export interface InvokeTriggerHookOptions extends InvokeOptions {
  triggerKey: string;
  hook: TriggerHookKind;
  input: unknown;
}

export async function invokeTriggerHook(
  app: LoadedApp,
  opts: InvokeTriggerHookOptions,
): Promise<unknown> {
  const trigger = app.triggers.get(opts.triggerKey);
  if (!trigger) {
    throw new W6WError(
      "unknown_trigger",
      "resolution",
      `Unknown trigger "${opts.triggerKey}" on app "${app.manifest.id}".`,
    );
  }
  if (!trigger.hooks.has(opts.hook)) {
    throw new W6WError(
      "hook_not_declared",
      "resolution",
      `Trigger "${opts.triggerKey}" does not declare hook "${opts.hook}".`,
    );
  }

  const auth = opts.connection ? authFor(app, opts.connection) : undefined;
  let credential: unknown;
  let redacted: RedactedConnection | undefined;
  if (opts.connection && auth) {
    ({ signCredential: credential, redacted } = await prepareAuthorization(
      app,
      auth,
      opts.connection,
      {
        purpose: "trigger",
        credentialResolver: opts.credentialResolver,
        egressTransport: opts.egressTransport,
        timeoutMs: opts.timeoutMs,
      },
    ));
  }
  const { onFetch, unwrap } = withDeniedUnwrap(signingFetch(app, auth, credential, opts));

  try {
    return await runHook({
      ...hookSource(app),
      selector: { kind: "trigger", key: opts.triggerKey, hook: opts.hook },
      input: opts.input,
      connection: redacted,
      timeoutMs: opts.timeoutMs,
      onLog: opts.onLog,
      onFetch,
      onFileRead: opts.onFileRead,
      onFileCreate: opts.onFileCreate,
    });
  } catch (err) {
    unwrap(err);
  }
}

// ── resolveFields hook invocation ──────────────────────────────────────────

/**
 * Run an Action's `resolveFields` hook (the editor-time option source) in the
 * sandbox, under the same signing and egress posture as `invoke`: the hook sees
 * a redacted connection, and its `ctx.fetch` is signed by the app's `sign` hook
 * and held to `network.allow`. It is a read for an editor, so it is handed no
 * socket, file capability or request overrides.
 *
 * Capped at `RESOLVE_FIELDS_TIMEOUT_MS`: a caller may lower `opts.timeoutMs`
 * but never raise it, and the clamp also bounds host egress. Every failure of
 * the hook call itself is re-thrown in phase `resolution` (code kept), and the
 * return is sanitised as untrusted on THIS side of the boundary.
 */
export async function invokeResolveFields(
  app: LoadedApp,
  actionKey: string,
  input: ResolveFieldsInput,
  opts: InvokeOptions = {},
): Promise<ResolveFieldsOutput> {
  const loaded = app.actions.get(actionKey);
  if (!loaded) {
    throw new W6WError("unknown_action", "resolution", `Unknown action "${actionKey}".`);
  }
  if (loaded.definition.resolveFields !== true) {
    throw new W6WError(
      "hook_not_declared",
      "resolution",
      `Action "${actionKey}" does not declare resolveFields.`,
    );
  }

  const auth = opts.connection ? authFor(app, opts.connection) : undefined;
  let credential: unknown;
  let redacted: RedactedConnection | undefined;
  if (opts.connection && auth) {
    ({ signCredential: credential, redacted } = await prepareAuthorization(
      app,
      auth,
      opts.connection,
      {
        purpose: "fields",
        credentialResolver: opts.credentialResolver,
        egressTransport: opts.egressTransport,
        timeoutMs: opts.timeoutMs,
      },
    ));
  } else if (app.auths.length > 0) {
    throw new W6WError(
      "connection_required",
      "auth",
      `Action "${actionKey}" requires a connection — the app declares auth.`,
    );
  }

  const timeoutMs = Math.min(
    opts.timeoutMs ?? RESOLVE_FIELDS_TIMEOUT_MS,
    RESOLVE_FIELDS_TIMEOUT_MS,
  );
  const { onFetch, unwrap } = withDeniedUnwrap(
    signingFetch(app, auth, credential, { ...opts, timeoutMs }),
  );

  let raw: unknown;
  try {
    raw = await runHook({
      ...hookSource(app),
      selector: { kind: "action", key: actionKey, hook: "resolveFields" },
      input,
      connection: redacted,
      timeoutMs,
      onLog: opts.onLog,
      onFetch,
    });
  } catch (err) {
    try {
      unwrap(err);
    } catch (e) {
      if (e instanceof W6WError) throw new W6WError(e.code, "resolution", e.message, e.details);
      throw e;
    }
  }
  return sanitizeResolveFieldsOutput(raw, input.fields);
}
