/**
 * Action — a single operation a user can perform through an App.
 * See rfcs/action.md.
 */
import type { Param } from "./param.ts";
import type { ActionExecuteHook } from "./hooks.ts";

export type ActionType = "read" | "search" | "perform";

export interface OutputField {
  /** Machine name. Dot notation for nested paths (`message.id`). */
  key: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  label: string;
}

/** Output shape declared by a hook when it depends on configuration. */
export interface DynamicOutput {
  source: string;
}

export type Output = OutputField[] | DynamicOutput;

/**
 * An Action's serializable configuration — its metadata minus the `execute`
 * function. This is what `describe()` returns and what the editor/host renders.
 * It is the `ActionDefinition` with `execute` stripped (functions don't
 * serialize and never leave the sandbox).
 */
export interface Action {
  /** Machine name. Unique within the App. Lowercase, kebab-case. */
  key: string;
  type: ActionType;
  title: string;
  description?: string;
  /** Inputs collected from the user. */
  params?: Param[];
  output?: Output;
  /** Whether a `perform` action is safe to retry. (Action RFC open question; reserved.) */
  idempotent?: boolean;
}

/**
 * An action module's default export: config and behavior co-located (n8n-style).
 * One `.ts` file per action — no separate manifest or execute file.
 *
 * ```ts
 * const sendMessage: ActionDefinition<Input, Output> = {
 *   key: "send-message", type: "perform", title: "Send Message",
 *   params: [...],
 *   execute(input, ctx) { ... },
 * };
 * export default sendMessage;
 * ```
 */
export interface ActionDefinition<P = Record<string, unknown>, O = unknown> extends Action {
  execute: ActionExecuteHook<P, O>;
}

export function isDynamicOutput(o: Output | undefined): o is DynamicOutput {
  return !!o && !Array.isArray(o) && typeof (o as DynamicOutput).source === "string";
}
