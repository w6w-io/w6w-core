/**
 * Wire protocol between the host (run-hook.ts) and the sandbox worker
 * (worker.ts). All messages are structured-cloneable plain data.
 */
import type { Action, AuthHookKind, SignableRequest } from "@w6w/types";

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

/** The app's behavior, extracted from the entry module as serializable data. */
export interface DescribedApp {
  actions: Action[];
  auth: DescribedAuth[];
}

/** Addresses a callable inside the app object exported by the entry module. */
export type Selector =
  | { kind: "action"; key: string }
  | { kind: "auth"; key: string; hook: AuthHookKind };

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
    /** When true, `ctx.fetch` proxies through the host; otherwise it throws. */
    enableFetch: boolean;
  }
  // Import the entry module and return its actions/auth config (no functions).
  | { type: "start"; op: "describe-app"; entryPath: string }
  | { type: "fetch-response"; id: number; response: WireResponse }
  | { type: "fetch-error"; id: number; message: string };

/** Worker -> host. */
export type WorkerMessage =
  | { type: "log"; level: string; message: string; data?: unknown }
  | { type: "fetch"; id: number; request: SignableRequest }
  | { type: "result"; value: unknown }
  | { type: "error"; error: { name: string; message: string } };
