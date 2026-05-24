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
  Invocation,
  SignableRequest,
} from "@w6w/types";
import { redact } from "@w6w/types";
import type { LoadedApp, LoadedAuth } from "./loader.ts";
import { resolveParams } from "./resolve.ts";
import { runHook } from "./sandbox/run-hook.ts";
import type { WireResponse } from "./sandbox/protocol.ts";
import { W6WError } from "./errors.ts";

export interface AppDescription {
  app: AppManifest;
  actions: Action[];
  auth: Auth[];
}

export interface InvokeOptions {
  /** The full Connection, including its opaque credential. Held by the host; never exposed to the action. */
  connection?: Connection;
  timeoutMs?: number;
  onLog?: (level: string, message: string, data?: unknown) => void;
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
  };
}

/** Pick the LoadedAuth a Connection refers to (by `auth` key), else the app's sole auth. */
function authFor(app: LoadedApp, connection: Connection): LoadedAuth | undefined {
  return app.auths.find((a) => a.auth.key === connection.auth) ?? app.auths[0];
}

/** Perform a request on the host: enforce the allowlist, then fetch. */
async function hostFetch(allowlist: string[], req: SignableRequest): Promise<WireResponse> {
  let host: string;
  try {
    host = new URL(req.url).hostname;
  } catch {
    throw new W6WError("invalid_request_url", "execute", `Hook produced an invalid URL: ${req.url}`);
  }
  if (!allowlist.includes(host)) {
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
 * Execute an Action, following the Invocation RFC's resolution sequence:
 * resolve action -> (connection lifecycle gates: later slice) -> resolve params
 * -> invoke `execute` in the sandbox, signing outbound requests.
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

  // 2. Resolve Connection.
  //    TODO(slice): apply the lifecycle gates (pending/needs_refresh/broken/
  //    revoked) from the Connection RFC. For now the host supplies a resolved
  //    Connection and we split it: redacted projection for the action, raw
  //    credential reserved for `sign`.
  const connection = opts.connection;
  const auth = connection ? authFor(app, connection) : undefined;
  const canSign = !!auth?.hooks.has("sign");
  const redacted = connection ? redact(connection) : undefined;

  // 3. Resolve params.
  const resolved = resolveParams(loaded.definition.params ?? [], invocation.params ?? {});

  // 4. Build the signing fetch handler the action's ctx.fetch routes through.
  const onFetch = async (request: SignableRequest): Promise<WireResponse> => {
    let signed = request;
    if (canSign && auth && connection) {
      // `sign` runs in its own worker with NO network, and is the only code
      // given the credential. It returns the request with auth injected.
      signed = await runHook<SignableRequest>({
        entryPath: app.entryPath,
        selector: { kind: "auth", key: auth.auth.key, hook: "sign" },
        input: { request, credential: connection.credential },
        readScope: app.dir,
        timeoutMs: opts.timeoutMs,
        // no onFetch -> the sign worker cannot make network calls.
      });
    }
    return hostFetch(app.netAllowlist, signed);
  };

  // 5. Invoke the action's `execute` in the sandbox.
  const value = await runHook({
    entryPath: app.entryPath,
    selector: { kind: "action", key: loaded.definition.key },
    input: resolved,
    readScope: app.dir,
    connection: redacted,
    timeoutMs: opts.timeoutMs,
    onLog: opts.onLog,
    onFetch,
  });

  return { value };
}
