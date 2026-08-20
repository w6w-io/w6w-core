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
  HealthCheck,
  Invocation,
  RedactedConnection,
  SignableRequest,
  Trigger,
  TriggerHookKind,
} from "@w6w/types";
import { redact } from "@w6w/types";
import type { LoadedApp, LoadedAuth } from "./loader.ts";
import { resolveParams } from "./resolve.ts";
import { runHook } from "./sandbox/run-hook.ts";
import type { WireResponse } from "./sandbox/protocol.ts";
import { egressFailure, type EgressInfo, egressInfo } from "./egress.ts";
import { W6WError } from "./errors.ts";

export type { EgressInfo };
export { DEFAULT_EGRESS_BODY_LIMIT } from "./egress.ts";

export interface AppDescription {
  app: AppManifest;
  actions: Action[];
  auth: Auth[];
  triggers: Trigger[];
  /** Declared, promoted and derived checks — the whole health surface. */
  health: HealthCheck[];
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
}

export interface InvokeResult {
  value: unknown;
}

/** Return the app's public description. */
export function describe(app: LoadedApp): AppDescription {
  return {
    app: app.manifest,
    actions: [...app.actions.values()].map((a) => a.definition),
    auth: app.auths.map((a) => a.auth),
    triggers: [...app.triggers.values()].map((t) => t.trigger),
    health: [...app.healthChecks.values()].map((h) => h.check),
  };
}

/** Pick the LoadedAuth a Connection refers to (by `auth` key), else the app's sole auth. */
function authFor(app: LoadedApp, connection: Connection): LoadedAuth | undefined {
  return app.auths.find((a) => a.auth.key === connection.auth) ?? app.auths[0];
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

/** Perform a request on the host: enforce the allowlist, then fetch. */
async function hostFetch(allowlist: string[], req: SignableRequest): Promise<WireResponse> {
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
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body ?? undefined,
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return {
    status: res.status,
    statusText: res.statusText,
    headers,
    body: new Uint8Array(await res.arrayBuffer()),
  };
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
): (request: SignableRequest) => Promise<WireResponse> {
  const canSign = !!auth?.hooks.has("sign");
  return async (request: SignableRequest): Promise<WireResponse> => {
    let signed = request;
    if (canSign && auth) {
      // `sign` runs in its own worker with NO network, and is the only code
      // given the (live, post-refresh) credential. It injects auth.
      signed = await runHook<SignableRequest>({
        entryPath: app.entryPath,
        selector: { kind: "auth", key: auth.auth.key, hook: "sign" },
        input: { request, credential },
        readScope: app.dir,
        timeoutMs: opts.timeoutMs,
        // no onFetch -> the sign worker cannot make network calls.
      });
    }
    const capture = { capture: opts.captureEgress, bodyLimit: opts.egressBodyLimit, durationMs: 0 };
    const egressStart = Date.now();
    try {
      const res = await hostFetch(allowlist, signed);
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

interface ResolvedConnection {
  /** The live credential to feed `sign` (post-refresh if it was stale). */
  credential: unknown;
  /** The redacted projection exposed to the action. */
  redacted: RedactedConnection;
}

/**
 * Apply the Connection lifecycle gates from the Invocation + Connection RFCs.
 * Throws (phase `auth`) for non-live states; for `needs_refresh`, runs the Auth
 * `refresh` hook and proceeds with the new credential, or transitions to broken.
 */
async function resolveConnection(
  app: LoadedApp,
  conn: Connection,
  auth: LoadedAuth | undefined,
  opts: InvokeOptions,
): Promise<ResolvedConnection> {
  switch (conn.state) {
    case "connected":
      return { credential: conn.credential, redacted: redact(conn) };
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
    case "needs_refresh": {
      if (!auth?.hooks.has("refresh")) {
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
          entryPath: app.entryPath,
          selector: { kind: "auth", key: auth.auth.key, hook: "refresh" },
          input: { credential: conn.credential },
          readScope: app.dir,
          timeoutMs: opts.timeoutMs,
          onFetch: (req) => hostFetch(app.netAllowlist, req),
        });
      } catch (e) {
        throw new W6WError("connection_broken", "auth", `Refresh failed: ${(e as Error).message}`);
      }
      const refreshed: Connection = { ...conn, credential, state: "connected" };
      return { credential, redacted: redact(refreshed) };
    }
    default:
      throw new W6WError(
        "connection_broken",
        "auth",
        `Unknown connection state "${(conn as Connection).state}".`,
      );
  }
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
}

/**
 * Run one of an Auth method's credential-bearing lifecycle hooks — `test`,
 * `afterConnect`, `refresh` or `revoke` — in the same least-privilege sandbox
 * `invoke` uses, with host-mediated, allowlist-enforced egress. This is the
 * `resolveConnection` `needs_refresh` branch's mechanism, generalized by hook
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
  if (!auth.hooks.has(hook)) {
    throw new W6WError(
      "hook_not_declared",
      "auth",
      `Auth "${auth.auth.key}" does not declare hook "${hook}".`,
    );
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
  try {
    return await runHook<T>({
      entryPath: app.entryPath,
      selector: { kind: "auth", key: auth.auth.key, hook },
      input: { credential },
      readScope: app.dir,
      timeoutMs: opts.timeoutMs,
      onLog: opts.onLog,
      onFetch: async (req) => {
        try {
          return await hostFetch(app.netAllowlist, req);
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
 * resolve action -> resolve connection (lifecycle gates + refresh) -> resolve
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
  if (opts.connection) {
    ({ credential, redacted } = await resolveConnection(app, opts.connection, auth, opts));
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
  const onFetch = signingFetch(app, auth, credential, opts);

  // 5. Invoke the action's `execute` in the sandbox.
  const value = await runHook({
    entryPath: app.entryPath,
    selector: { kind: "action", key: loaded.definition.key },
    input: resolved,
    readScope: app.dir,
    connection: redacted,
    invocation: invocation.context,
    timeoutMs: opts.timeoutMs,
    onLog: opts.onLog,
    onFetch,
  });

  return { value };
}

// ── Trigger hook invocation ────────────────────────────────────────────────

/**
 * Run one of a trigger's lifecycle hooks in the sandbox. Auth is handled the
 * same way as for actions: the trigger sees a redacted connection; outbound
 * fetches route through the auth `sign` hook when the app declares one.
 *
 * Callers:
 *   - server's TriggerManager.subscribe   → invokeTriggerHook(kind="onSubscribe")
 *   - server's HTTPS webhook adapter      → invokeTriggerHook(kind="handleIngest")
 *   - server's TriggerManager.unsubscribe → invokeTriggerHook(kind="onUnsubscribe")
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
  if (opts.connection) {
    ({ credential, redacted } = await resolveConnection(app, opts.connection, auth, opts));
  }
  const onFetch = signingFetch(app, auth, credential, opts);

  return await runHook({
    entryPath: app.entryPath,
    selector: { kind: "trigger", key: opts.triggerKey, hook: opts.hook },
    input: opts.input,
    readScope: app.dir,
    connection: redacted,
    timeoutMs: opts.timeoutMs,
    onLog: opts.onLog,
    onFetch,
  });
}
