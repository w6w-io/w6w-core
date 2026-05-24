/**
 * Host side of the sandbox. Spawns a Deno Worker with a least-privilege
 * permission set scoped to one hook execution, sends the input, services any
 * proxied `ctx.fetch` calls, enforces a timeout, and resolves with the result.
 *
 * Every worker is spawned with NO network permission. Network happens only on
 * the trusted host, via the `onFetch` callback the caller supplies — that is
 * where the egress allowlist is enforced and where `sign` runs.
 */
import type { RedactedConnection, SignableRequest } from "@w6w/types";
import { W6WError } from "../errors.ts";
import type { WireResponse, WorkerMessage } from "./protocol.ts";

export interface RunHookOptions {
  /** Absolute path to the hook module. */
  hookPath: string;
  /** Value passed as the hook's first argument. */
  input: unknown;
  /** Directory the worker may read (the app root). */
  readScope: string;
  /** Redacted connection exposed via `ctx.connection`. Never contains the credential. */
  connection?: RedactedConnection | unknown;
  /** Hard timeout in milliseconds. Default 30s. */
  timeoutMs?: number;
  /** Sink for `ctx.log` calls. */
  onLog?: (level: string, message: string, data?: unknown) => void;
  /**
   * Handler for the hook's `ctx.fetch`. When provided, `ctx.fetch` is enabled
   * and every request is routed here (sign + allowlist + real network). When
   * omitted, `ctx.fetch` throws inside the worker.
   */
  onFetch?: (request: SignableRequest) => Promise<WireResponse>;
}

const NO_NET_PERMS = {
  net: false as const,
  env: false as const,
  write: false as const,
  run: false as const,
  ffi: false as const,
  sys: false as const,
  import: false as const,
};

export function runHook<T = unknown>(opts: RunHookOptions): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const worker = new Worker(import.meta.resolve("./worker.ts"), {
    type: "module",
    // @ts-ignore: `deno` worker options are Deno-specific, not in lib.dom.
    deno: { permissions: { read: [opts.readScope], ...NO_NET_PERMS } },
  });

  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new W6WError("hook_timeout", "execute", `Hook timed out after ${timeoutMs}ms.`));
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

    worker.postMessage({
      type: "start",
      hookPath: opts.hookPath,
      input: opts.input,
      connection: opts.connection,
      enableFetch: !!opts.onFetch,
    });
  });
}
