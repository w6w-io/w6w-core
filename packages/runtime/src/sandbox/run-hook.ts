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

/**
 * Exported (it was module-private before this node) so a test can call
 * `runWorker` below directly with its own hand-built `start` message —
 * the only way to exercise the `onSocket`-absent guard, since `runHook`'s
 * own derivation ties `enableSocket` to `onSocket`'s presence 1:1.
 */
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
          // ROUND 2 / B3: `worker.ts` runs in the SAME Deno Worker realm as
          // the untrusted app module, so its own `instanceof`/`ArrayBuffer.
          // isView` checks resolve against globals that module can rewrite
          // (a fake-branded Uint8Array, a hijacked Symbol.hasInstance) — not
          // a boundary. This is the one point running on the value AFTER it
          // has crossed `structuredClone`, in the host realm the app cannot
          // reach or rewrite, so it is where DC-5's binary-safe body contract
          // is actually enforced before a forged value can reach `onFetch`
          // (and, downstream, the credential-bearing `sign` hook).
          const b = msg.request.body;
          if (
            !(b == null || typeof b === "string" ||
              (ArrayBuffer.isView(b) && b instanceof Uint8Array))
          ) {
            worker.postMessage({
              type: "fetch-error",
              id: msg.id,
              message: "malformed fetch body",
            });
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
        case "file-read": {
          if (!opts.onFileRead) {
            worker.postMessage({ type: "file-error", id: msg.id, message: "file unavailable" });
            return;
          }
          // ROUND 2 / B3: the actual boundary for A3's "onFileRead receives
          // only the id string" — see the fetch case's comment above for why
          // it cannot live in `worker.ts`. A getter-based TOCTOU (`isFileRef`
          // reads `.id` once, sees a string; a second read sees an object)
          // defeats any worker-side check because both reads happen in the
          // same realm as the getter itself; `msg.ref` here is the value
          // AFTER `structuredClone`, which evaluates a getter exactly once
          // and freezes the result, so there is no second read left to lie to.
          if (typeof msg.ref !== "string") {
            worker.postMessage({ type: "file-error", id: msg.id, message: "malformed file-read" });
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
          // ROUND 2 / B3: the actual boundary for A3's "onFileCreate
          // receives a real Uint8Array" — a fake-branded object
          // (`Object.create(Uint8Array.prototype)`) passes a same-realm
          // `instanceof Uint8Array` inside the worker but has no
          // `[[ViewedArrayBuffer]]` slot, so it arrives here (past
          // `structuredClone`) as a plain object — `ArrayBuffer.isView`
          // (checked FIRST, on the internal slot, not the prototype chain)
          // correctly reports `false` for it, closing the hole a worker-side
          // `instanceof` check alone could not.
          if (!ArrayBuffer.isView(msg.bytes) || !(msg.bytes instanceof Uint8Array)) {
            worker.postMessage({
              type: "file-error",
              id: msg.id,
              message: "malformed file-create",
            });
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
    enableSocket: !!opts.onSocket,
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
