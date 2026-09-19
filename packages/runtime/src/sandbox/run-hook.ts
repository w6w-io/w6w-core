/**
 * Host side of the sandbox. Spawns a Deno Worker with a least-privilege
 * permission set, sends a start message, services any proxied `ctx.fetch`
 * calls, enforces a timeout, and resolves with the worker's result.
 *
 * Every worker is spawned with NO network permission. Network happens only on
 * the trusted host, via the `onFetch` callback the caller supplies — that is
 * where the egress allowlist is enforced and where `sign` runs.
 */
import type { InvocationContext, RedactedConnection, SignableRequest } from "@w6w/types";
import { W6WError } from "../errors.ts";
import type {
  DescribedApp,
  HostMessage,
  Selector,
  SocketRequest,
  SocketResult,
  WireResponse,
  WorkerMessage,
} from "./protocol.ts";

const NO_NET_PERMS = {
  net: false as const,
  env: false as const,
  write: false as const,
  run: false as const,
  ffi: false as const,
  sys: false as const,
  import: false as const,
};

export interface WorkerRunOptions {
  readScope: string;
  timeoutMs?: number;
  onLog?: (level: string, message: string, data?: unknown) => void;
  onFetch?: (request: SignableRequest) => Promise<WireResponse>;
  /**
   * Host-mediated socket proxy, servicing the worker's `ctx.socket` calls.
   * Absent, exactly like `onFetch`: every socket op the worker asks for
   * fails (never hangs, never silently no-ops) instead of reaching a real
   * socket the caller never agreed to open. Opening the actual OS
   * connection is this callback's owner's job (T1.2.2) — this seam only
   * proxies write/read/close to whatever the caller supplies.
   */
  onSocket?: (request: SocketRequest) => Promise<SocketResult>;
}

/**
 * Spawn a sandbox worker, drive one start message to completion, return its
 * result. Exported (alongside the convenience wrappers below) because
 * `describeApp` already needs to hand-build a `start` message directly —
 * and so does a test proving the `onSocket`-absent guard is live: `runHook`
 * always derives `enableSocket` from `!!opts.onSocket`, so nothing through
 * that convenience wrapper can ever decouple the two; only a caller driving
 * `runWorker` directly can construct that scenario.
 */
export function runWorker<T>(start: HostMessage, opts: WorkerRunOptions): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const worker = new Worker(import.meta.resolve("./worker.ts"), {
    type: "module",
    // @ts-ignore: `deno` worker options are Deno-specific, not in lib.dom.
    deno: { permissions: { read: [opts.readScope], ...NO_NET_PERMS } },
  });

  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new W6WError("hook_timeout", "execute", `Worker timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    const finish = (fn: () => void) => {
      clearTimeout(timer);
      worker.terminate();
      fn();
    };

    worker.onmessage = async (e: MessageEvent) => {
      const msg = e.data as WorkerMessage;
      switch (msg.type) {
        case "log":
          opts.onLog?.(msg.level, msg.message, msg.data);
          return;
        case "fetch": {
          if (!opts.onFetch) {
            worker.postMessage({ type: "fetch-error", id: msg.id, message: "fetch unavailable" });
            return;
          }
          try {
            const response = await opts.onFetch(msg.request);
            worker.postMessage({ type: "fetch-response", id: msg.id, response });
          } catch (err) {
            worker.postMessage({
              type: "fetch-error",
              id: msg.id,
              message: (err as Error)?.message ?? String(err),
            });
          }
          return;
        }
        case "socket-write": {
          if (!opts.onSocket) {
            worker.postMessage({
              type: "socket-write-error",
              id: msg.id,
              message: "socket unavailable",
            });
            return;
          }
          try {
            await opts.onSocket({ op: "write", bytes: msg.bytes });
            worker.postMessage({ type: "socket-write-response", id: msg.id });
          } catch (err) {
            worker.postMessage({
              type: "socket-write-error",
              id: msg.id,
              message: (err as Error)?.message ?? String(err),
            });
          }
          return;
        }
        case "socket-read": {
          if (!opts.onSocket) {
            worker.postMessage({
              type: "socket-read-error",
              id: msg.id,
              message: "socket unavailable",
            });
            return;
          }
          try {
            const result = await opts.onSocket({ op: "read", max: msg.max });
            const bytes = result.op === "read" ? result.bytes : null;
            worker.postMessage({ type: "socket-read-response", id: msg.id, bytes });
          } catch (err) {
            worker.postMessage({
              type: "socket-read-error",
              id: msg.id,
              message: (err as Error)?.message ?? String(err),
            });
          }
          return;
        }
        case "socket-close": {
          if (!opts.onSocket) {
            worker.postMessage({
              type: "socket-close-error",
              id: msg.id,
              message: "socket unavailable",
            });
            return;
          }
          try {
            await opts.onSocket({ op: "close" });
            worker.postMessage({ type: "socket-close-response", id: msg.id });
          } catch (err) {
            worker.postMessage({
              type: "socket-close-error",
              id: msg.id,
              message: (err as Error)?.message ?? String(err),
            });
          }
          return;
        }
        case "result":
          finish(() => resolvePromise(msg.value as T));
          return;
        case "error":
          finish(() =>
            reject(new W6WError("hook_failed", "execute", msg.error.message, msg.error))
          );
          return;
      }
    };

    worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      finish(() => reject(new W6WError("hook_crashed", "execute", e.message || "Worker crashed.")));
    };

    worker.postMessage(start);
  });
}

export interface RunHookOptions extends WorkerRunOptions {
  /** Absolute path to the app's entry module. */
  entryPath: string;
  /** Which callable inside the exported app object to run. */
  selector: Selector;
  /** Value passed as the call's first argument. */
  input: unknown;
  /** Redacted connection exposed via `ctx.connection`. Never the credential. */
  connection?: RedactedConnection | unknown;
  /** Read-only invocation metadata exposed via `ctx.invocation`. */
  invocation?: InvocationContext;
}

/** Import the entry module in the sandbox and call a located function. */
export function runHook<T = unknown>(opts: RunHookOptions): Promise<T> {
  return runWorker<T>({
    type: "start",
    op: "call",
    entryPath: opts.entryPath,
    selector: opts.selector,
    input: opts.input,
    connection: opts.connection,
    invocation: opts.invocation,
    enableFetch: !!opts.onFetch,
    enableSocket: !!opts.onSocket,
  }, opts);
}

/** Import the entry module in the sandbox and extract its serializable app config. */
export function describeApp(
  entryPath: string,
  readScope: string,
  timeoutMs?: number,
): Promise<DescribedApp> {
  return runWorker<DescribedApp>(
    { type: "start", op: "describe-app", entryPath },
    { readScope, timeoutMs },
  );
}
