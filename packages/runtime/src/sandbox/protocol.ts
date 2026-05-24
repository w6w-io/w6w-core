/**
 * Wire protocol between the host (run-hook.ts) and the sandbox worker
 * (worker.ts). All messages are structured-cloneable plain data.
 */
import type { Action, SignableRequest } from "@w6w/types";

/** A response carried back across the boundary after the host performs a fetch. */
export interface WireResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  /** Body bytes. Empty for no-body responses. */
  body: Uint8Array;
}

/** One action's extracted, serializable config plus the module it came from. */
export interface DescribedAction {
  path: string;
  definition: Action;
}

/** Host -> worker. */
export type HostMessage =
  // Import a module and call it: a plain hook function (no `method`) or an
  // action module's method (e.g. `method: "execute"`).
  | {
    type: "start";
    op: "call";
    hookPath: string;
    method?: string;
    input: unknown;
    connection?: unknown;
    /** When true, `ctx.fetch` proxies through the host; otherwise it throws. */
    enableFetch: boolean;
  }
  // Import action modules and return their config (everything except `execute`).
  | { type: "start"; op: "describe-actions"; paths: string[] }
  | { type: "fetch-response"; id: number; response: WireResponse }
  | { type: "fetch-error"; id: number; message: string };

/** Worker -> host. */
export type WorkerMessage =
  | { type: "log"; level: string; message: string; data?: unknown }
  | { type: "fetch"; id: number; request: SignableRequest }
  | { type: "result"; value: unknown }
  | { type: "error"; error: { name: string; message: string } };
