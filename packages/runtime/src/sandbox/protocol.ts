/**
 * Wire protocol between the host (run-hook.ts) and the sandbox worker
 * (worker.ts). All messages are structured-cloneable plain data.
 */
import type {
  Action,
  AuthHookKind,
  FileRef,
  HealthCheck,
  InterfaceConformance,
  SignableRequest,
  Trigger,
  TriggerHookKind,
} from "@w6w/types";

/** A response carried back across the boundary after the host performs a fetch. */
export interface WireResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Body bytes. Empty for no-body responses. */
  body: Uint8Array;
}

/** One auth method's extracted config plus the names of the hooks it actually defines. */
export interface DescribedAuth {
  auth: import("@w6w/types").Auth;
  hooks: AuthHookKind[];
}

/** One trigger's extracted config plus the names of the hooks it actually defines. */
export interface DescribedTrigger {
  trigger: Trigger;
  hooks: TriggerHookKind[];
}

/**
 * One socket operation the worker asks the host to perform, passed to the
 * host's `onSocket` callback. Not itself a wire message — `run-hook.ts`
 * builds one of these from the `id`-bearing `socket-write`/`socket-read`/
 * `socket-close` `WorkerMessage` it just received, so the callback (like
 * `onFetch`) never has to think about request-id correlation.
 */
export type SocketRequest =
  | { op: "write"; bytes: Uint8Array }
  | { op: "read"; max?: number }
  | { op: "close" };

/**
 * The result of one socket operation, returned by the host's `onSocket`
 * callback. Its own shape, deliberately not `WireResponse` — a socket reply
 * carries no HTTP status/headers, and each op's payload differs (only `read`
 * carries bytes), so reusing the HTTP-status-shaped type would either lie
 * about unused fields or force every op through one over-general shape.
 */
export type SocketResult =
  | { op: "write" }
  | { op: "read"; bytes: Uint8Array | null }
  | { op: "close" };

/** A health check's config plus whether it actually carries a probe. */
export interface DescribedHealthCheck {
  check: HealthCheck;
  /** False for an `unavailable` declaration, which has nothing to run. */
  hasHook: boolean;
}

/** The app's behavior, extracted from the entry module as serializable data. */
export interface DescribedApp {
  actions: Action[];
  auth: DescribedAuth[];
  triggers: DescribedTrigger[];
  healthChecks: DescribedHealthCheck[];
  interfaces: InterfaceConformance[];
}

/** Addresses a callable inside the app object exported by the entry module. */
export type Selector =
  | { kind: "action"; key: string }
  | { kind: "auth"; key: string; hook: AuthHookKind }
  | { kind: "trigger"; key: string; hook: TriggerHookKind }
  | { kind: "health"; key: string };

/** Host -> worker. */
export type HostMessage =
  // Import the entry module and call a located function (action.execute / auth.<hook>).
  | {
    type: "start";
    op: "call";
    entryPath: string;
    selector: Selector;
    input: unknown;
    connection?: unknown;
    /** Read-only invocation metadata surfaced to the hook as `ctx.invocation`. */
    invocation?: unknown;
    /** When true, `ctx.fetch` proxies through the host; otherwise it throws. */
    enableFetch: boolean;
    /**
     * When true, `ctx.socket` is a live `SocketHandle` proxying through the
     * host; otherwise it is `undefined` (never a throwing stub — see
     * `HookContext.socket`'s doc comment in `@w6w/types`).
     */
    enableSocket: boolean;
    /** When true, `ctx.file` proxies through the host; otherwise both methods reject. */
    enableFile: boolean;
  }
  // Import the entry module and return its actions/auth config (no functions).
  | { type: "start"; op: "describe-app"; entryPath: string }
  | { type: "fetch-response"; id: number; response: WireResponse }
  | { type: "fetch-error"; id: number; message: string }
  // Socket replies. There is no "socket-open" request/reply pair: the host
  // opens the stream (and runs the handshake) before `execute()` ever runs,
  // so the worker only ever asks to write/read/close a stream it was handed
  // — it can never pick or redirect the destination, unlike `ctx.fetch`
  // where the URL comes from the (untrusted) action itself.
  | { type: "socket-write-response"; id: number }
  | { type: "socket-write-error"; id: number; message: string }
  | { type: "socket-read-response"; id: number; bytes: Uint8Array | null }
  | { type: "socket-read-error"; id: number; message: string }
  | { type: "socket-close-response"; id: number }
  | { type: "socket-close-error"; id: number; message: string }
  | { type: "file-read-response"; id: number; ref: FileRef; bytes: Uint8Array }
  | { type: "file-create-response"; id: number; ref: FileRef }
  | { type: "file-error"; id: number; message: string };

/** Worker -> host. */
export type WorkerMessage =
  | { type: "log"; level: string; message: string; data?: unknown }
  | { type: "fetch"; id: number; request: SignableRequest }
  // Socket requests: write bytes, read up to `max` bytes (host-chosen
  // default when absent), or close. Each carries its own correlation `id`
  // (shared with `fetch`'s counter — see `worker.ts`'s single `nextId`) so a
  // reply can never be delivered to the wrong pending call even when a hook
  // interleaves `ctx.fetch` and `ctx.socket` calls.
  | { type: "socket-write"; id: number; bytes: Uint8Array }
  | { type: "socket-read"; id: number; max?: number }
  | { type: "socket-close"; id: number }
  | { type: "result"; value: unknown }
  | { type: "error"; error: { name: string; message: string } }
  | { type: "file-read"; id: number; ref: string }
  | { type: "file-create"; id: number; bytes: Uint8Array; contentType: string; filename: string };
