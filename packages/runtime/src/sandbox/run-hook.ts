/**
 * Host side of the sandbox. Spawns a Deno Worker with a least-privilege
 * permission set, sends a start message, services any proxied `ctx.fetch`
 * calls, enforces a timeout, and resolves with the worker's result.
 *
 * Every worker is spawned with NO network permission. Network happens only on
 * the trusted host, via the `onFetch` callback the caller supplies — that is
 * where the egress allowlist is enforced and where `sign` runs.
 */
import type { FileRef, InvocationContext, RedactedConnection, SignableRequest } from "@w6w/types";
import { W6WError } from "../errors.ts";
import type {
  DescribedApp,
  HostMessage,
  Selector,
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

interface WorkerRunOptions {
  readScope: string;
  timeoutMs?: number;
  onLog?: (level: string, message: string, data?: unknown) => void;
  onFetch?: (request: SignableRequest) => Promise<WireResponse>;
  /**
   * Resolve a `FileRef.id` (or a bare ref id string) to its bytes, host-side.
   * `ctx.file.read` proxies through this. Both `onFileRead` and `onFileCreate`
   * must be supplied for the sandbox's `ctx.file` to be enabled at all — a
   * conforming host implements the whole two-method capability or none of it
   * (DC-3), never half.
   */
  onFileRead?: (refId: string) => Promise<{ ref: FileRef; bytes: Uint8Array }>;
  /** Store bytes and mint a `FileRef`, host-side. `ctx.file.create` proxies through this. */
  onFileCreate?: (
    input: { bytes: Uint8Array; contentType: string; filename: string },
  ) => Promise<FileRef>;
}

/** Spawn a sandbox worker, drive one start message to completion, return its result. */
function runWorker<T>(start: HostMessage, opts: WorkerRunOptions): Promise<T> {
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
        case "file-read": {
          if (!opts.onFileRead) {
            worker.postMessage({ type: "file-error", id: msg.id, message: "file unavailable" });
            return;
          }
          try {
            const { ref, bytes } = await opts.onFileRead(msg.ref);
            worker.postMessage({ type: "file-read-response", id: msg.id, ref, bytes });
          } catch (err) {
            worker.postMessage({
              type: "file-error",
              id: msg.id,
              message: (err as Error)?.message ?? String(err),
            });
          }
          return;
        }
        case "file-create": {
          if (!opts.onFileCreate) {
            worker.postMessage({ type: "file-error", id: msg.id, message: "file unavailable" });
            return;
          }
          try {
            const ref = await opts.onFileCreate({
              bytes: msg.bytes,
              contentType: msg.contentType,
              filename: msg.filename,
            });
            worker.postMessage({ type: "file-create-response", id: msg.id, ref });
          } catch (err) {
            worker.postMessage({
              type: "file-error",
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
    enableFile: !!(opts.onFileRead && opts.onFileCreate),
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
