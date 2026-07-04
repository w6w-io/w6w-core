/**
 * Trigger — an app-declared surface that emits events to subscribed workflows.
 * See rfcs/trigger.md. Parallels Action; where Action is a callable the workflow
 * invokes, Trigger is a source the workflow subscribes to.
 */
import type { Param } from "./param.ts";
import type { Output } from "./action.ts";
import type { HandleIngestHook, OnSubscribeHook, OnUnsubscribeHook } from "./hooks.ts";

/**
 * The lifecycle hook names a trigger may declare, in a fixed order so
 * `describeApp` can report which are actually present without reflecting on the
 * module. Kept small — non-hook fields (params, output, requiresAuth) come off
 * the serializable Trigger config.
 */
export const TRIGGER_HOOK_KINDS = ["onSubscribe", "onUnsubscribe", "handleIngest"] as const;
export type TriggerHookKind = typeof TRIGGER_HOOK_KINDS[number];

/**
 * A Trigger's serializable configuration — its metadata minus the hook
 * functions. This is what `describe()` returns and what the editor / host
 * renders.
 */
export interface Trigger {
  /** Machine name. Unique within the App. Lowercase, kebab-case. */
  key: string;
  title: string;
  description?: string;
  /** Configuration collected when a subscription is created. Reuses the full Param model. */
  params?: Param[];
  /** Shape of one normalized event (drives editor autocomplete for downstream steps). */
  output?: Output;
  /** Example event matching `output`. Used by the editor for previews. */
  sample?: unknown;
  /**
   * When the enclosing App declares Auth methods, set `false` to opt this
   * Trigger out of requiring a Connection (a generic "receive HTTPS" trigger
   * that just needs a URL). Defaults to `true` when the App has auth, `false`
   * when it doesn't.
   */
  requiresAuth?: boolean;
}

/**
 * A trigger module's default export: config and behavior co-located.
 * `handleIngest` is the only required hook; `onSubscribe` / `onUnsubscribe`
 * are optional for triggers with no third-party setup step.
 *
 * ```ts
 * const newMessage: TriggerDefinition = {
 *   key: "new-message", title: "New Message",
 *   params: [...],
 *   onSubscribe(input, ctx) { ... },      // register the webhook with Slack
 *   onUnsubscribe(state, ctx) { ... },    // tear down
 *   handleIngest({ raw }, ctx) { ... },   // parse raw → 0..N events
 * };
 * export default newMessage;
 * ```
 */
export interface TriggerDefinition<
  P = Record<string, unknown>,
  E = unknown,
  S = unknown,
> extends Trigger {
  onSubscribe?: OnSubscribeHook<P, S>;
  onUnsubscribe?: OnUnsubscribeHook<P, S>;
  handleIngest: HandleIngestHook<P, S, E>;
}
