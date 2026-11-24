/**
 * Action — a single operation a user can perform through an App.
 * See rfcs/action.md.
 */
import type { Param, ParamDefinition } from "./param.ts";
import type { ActionExecuteHook, ResolveFieldsHook } from "./hooks.ts";
import type { ActionHealthTag } from "./health.ts";

/**
 * What an action does. `control` marks an internal flow-control / pseudo-app
 * action (e.g. the `@w6w/control` if/foreach nodes) — see rfcs/node-types.md.
 */
export type ActionType = "read" | "search" | "perform" | "control";

export interface OutputField {
  /** Machine name. Dot notation for nested paths (`message.id`). */
  key: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "file";
  label: string;
  /**
   * The fields of ONE element. Valid only when `type` is `"array"`. Keys inside
   * use dot notation relative to the element (`id`, `owner.name`), not the array.
   */
  items?: OutputField[];
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
/** A port count: a non-negative integer, or `"many"` (unbounded). */
export type PortCount = number | "many";

/** How many inputs/outputs a node exposes. Absent fields fall back to defaults. */
export interface Ports {
  in?: PortCount;
  out?: PortCount;
}

export interface Action {
  /** Machine name. Unique within the App. Lowercase, kebab-case. */
  key: string;
  type: ActionType;
  title: string;
  description?: string;
  /** UI grouping hint. Actions sharing the same `resource` value are grouped together in the editor. */
  resource?: string;
  /** Inputs collected from the user. */
  params?: Param[];
  output?: Output;
  /** Example value matching `output`. Used by the editor for richer previews. Not validated. */
  sample?: unknown;
  /** Whether a `perform` action is safe to retry. Drives retry policy + Invocation dedupe. */
  idempotent?: boolean;
  /**
   * When the enclosing App declares Auth methods, set `false` to opt this Action
   * out of requiring a Connection (e.g. a public `health` endpoint). Defaults to
   * `true` when the App has auth, `false` when it doesn't.
   */
  requiresAuth?: boolean;
  /**
   * Promotes this Action into the App's health surface instead of duplicating
   * it as a standalone check — some Actions are already the right probe. Only
   * valid on a `read` Action whose params are all optional or defaulted, since
   * a host invokes it with `{}`.
   */
  healthCheck?: ActionHealthTag;
  /** Optional. Port counts for this Action; overrides the App's `ports` field-wise. */
  ports?: Ports;
  /**
   * How long `execute` may run, in milliseconds, when the host names no limit for the call.
   * For a vendor endpoint that is known to answer slowly (a large report, a heavily expanded
   * list). Whole number from {@link ACTION_TIMEOUT_MIN_MS} to {@link ACTION_TIMEOUT_MAX_MS}; a value
   * outside is clamped. A caller's own limit for the call (a workflow step's `timeoutMs`) wins.
   * Absent ⇒ {@link ACTION_TIMEOUT_DEFAULT_MS}. See rfcs/action.md §Amendment — 2026-11-24.
   */
  timeoutMs?: number;
  /**
   * Set by describe when the definition has a `resolveFields` function; never
   * authored by hand.
   */
  resolveFields?: true;
}

/**
 * How long an Action's `execute` (and each request it makes) runs when neither the caller nor the
 * Action names a limit. Generous on purpose: vendor list and report endpoints routinely take tens
 * of seconds, and a step that fails on a slow-but-healthy vendor is worse than one that waits.
 */
export const ACTION_TIMEOUT_DEFAULT_MS = 120_000;

/** The smallest limit a caller or an Action may set; a smaller one is raised to this. */
export const ACTION_TIMEOUT_MIN_MS = 1_000;

/**
 * The most a caller (a step's own `timeoutMs`) or an Action (`Action.timeoutMs`) may set; a
 * larger one is clamped. Below the 300 s request ceiling of the hosted API, so a synchronous call
 * that runs out of time reports the step's own `fetch_timeout` / `hook_timeout`, never a gateway
 * error.
 */
export const ACTION_TIMEOUT_MAX_MS = 280_000;

/**
 * A caller- or author-supplied limit, made safe: a whole number of milliseconds clamped to
 * `ACTION_TIMEOUT_MIN_MS..ACTION_TIMEOUT_MAX_MS`. Absent, non-numeric or not positive ⇒
 * `undefined` (no override — fall through to the next source).
 */
export function clampTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.max(Math.trunc(value), ACTION_TIMEOUT_MIN_MS), ACTION_TIMEOUT_MAX_MS);
}

/**
 * The `execute` limit an Action declares, clamped (see {@link clampTimeoutMs}). No usable
 * declaration ⇒ {@link ACTION_TIMEOUT_DEFAULT_MS}.
 */
export function actionTimeoutMs(action: Pick<Action, "timeoutMs">): number {
  return clampTimeoutMs(action.timeoutMs) ?? ACTION_TIMEOUT_DEFAULT_MS;
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
export interface ActionDefinition<P = Record<string, unknown>, O = unknown>
  extends Omit<Action, "resolveFields" | "params"> {
  /** The Action's params; a param may carry a `parse` the sandbox applies before `execute`. */
  params?: ParamDefinition[];
  execute: ActionExecuteHook<P, O>;
  /** Form-level options hook for params with `options: { source: "resolveFields" }`. */
  resolveFields?: ResolveFieldsHook;
}

export function isDynamicOutput(o: Output | undefined): o is DynamicOutput {
  return !!o && !Array.isArray(o) && typeof (o as DynamicOutput).source === "string";
}
