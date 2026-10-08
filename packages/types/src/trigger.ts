/**
 * Trigger — an app-declared surface that emits events to subscribed workflows.
 * See rfcs/trigger.md. Parallels Action; where Action is a callable the workflow
 * invokes, Trigger is a source the workflow subscribes to.
 */
import type { Param } from "./param.ts";
import type { Output } from "./action.ts";
import type {
  HandleIngestHook,
  OnSubscribeHook,
  OnUnsubscribeHook,
  ParseOutputHook,
  PollHook,
} from "./hooks.ts";

/**
 * The lifecycle hook names a trigger may declare, in a fixed order so
 * `describeApp` can report which are actually present without reflecting on the
 * module. Kept small — non-hook fields (params, output, requiresAuth) come off
 * the serializable Trigger config.
 */
export const TRIGGER_HOOK_KINDS = [
  "onSubscribe",
  "onUnsubscribe",
  "handleIngest",
  "poll",
  "parseOutput",
] as const;
export type TriggerHookKind = typeof TRIGGER_HOOK_KINDS[number];

/**
 * The two trigger forms. `webhook` triggers register with the third party
 * (`onSubscribe` / `onUnsubscribe`) and receive calls; `poll` triggers are
 * checked by the host on an interval via `poll`.
 */
export type TriggerType = "webhook" | "poll";

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
  /**
   * The trigger's form. Host-derived, never authored: the loader sets it to
   * `"poll"` iff the module declares `poll`, else `"webhook"`, overwriting any
   * value the author wrote.
   */
  type?: TriggerType;
  /**
   * Vendor floor (ms) for a poll trigger's check interval. The host applies its
   * own floor on top; the larger wins.
   */
  minIntervalMs?: number;
}

/**
 * A trigger module's default export: config and behavior co-located.
 * Two forms (see rfcs/trigger.md): a webhook trigger declares `onSubscribe` +
 * `onUnsubscribe` (which MUST pair) and an optional `handleIngest`; a poll
 * trigger declares `poll` and MUST NOT declare `onSubscribe`. Any trigger may
 * declare `parseOutput`. A trigger with no hooks is a plain webhook receiver.
 *
 * ```ts
 * const newMessage: TriggerDefinition = {
 *   key: "new-message", title: "New Message",
 *   params: [...],
 *   onSubscribe(input, ctx) { ... },      // register the webhook with Slack
 *   onUnsubscribe(state, ctx) { ... },    // tear down
 *   handleIngest({ raw }, ctx) { ... },   // parse the whole call → 0..N events
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
  handleIngest?: HandleIngestHook<P, S, E>;
  poll?: PollHook<P, S, E>;
  parseOutput?: ParseOutputHook<E>;
}
