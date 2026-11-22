/**
 * Trigger — an app-declared surface that emits events to subscribed workflows.
 * See rfcs/trigger.md. Parallels Action; where Action is a callable the workflow
 * invokes, Trigger is a source the workflow subscribes to.
 */
import type { Param, ParamDefinition } from "./param.ts";
import type { Output } from "./action.ts";
import type { TriggerProtocol } from "./trigger-protocol.ts";
import type {
  HandleIngestHook,
  OnSubscribeHook,
  OnUnsubscribeHook,
  ParseOutputHook,
  PollHook,
  ResolveFieldsHook,
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
  "resolveFields",
] as const;
export type TriggerHookKind = typeof TRIGGER_HOOK_KINDS[number];

/**
 * The trigger forms. `webhook` triggers register with the third party
 * (`onSubscribe` / `onUnsubscribe`) and receive calls; `poll` triggers are
 * checked by the host on an interval via `poll`; `protocol` triggers are
 * registered by the host with the partner's API and fired by signed requests
 * (rfcs/trigger-protocol.md).
 */
export type TriggerType = "webhook" | "poll" | "protocol";

/**
 * How a webhook trigger's receive URL reaches the vendor. Authored, webhook form only
 * (rfcs/trigger.md, Amendment 2026-11-22).
 *
 * `"manual"`: the vendor has no registration API (or the app does not use one), so the USER adds
 * the URL in the vendor's own settings. The host mints the URL with the trigger's subscription and
 * shows it in the trigger's editor, before publish, with `instructions` — and says plainly that the
 * trigger fires nothing until the URL has been added there. The URL stays the same while the
 * trigger's params or connection change, so a URL already pasted keeps working.
 */
export interface WebhookSetup {
  registration: "manual";
  /**
   * Where in the vendor the URL goes, and anything else to set there (events to tick, the
   * signing secret to copy back). Plain text; newlines separate steps. Shown under the URL.
   */
  instructions?: string;
}

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
   * Authored. `"w6w-protocol"` marks a trigger delivered by the trigger protocol;
   * absent means webhook or poll. Unlike `type` the loader preserves it.
   */
  delivery?: "w6w-protocol";
  /** Authored, with `delivery: "w6w-protocol"`: the partner events this trigger delivers. */
  protocol?: TriggerProtocol;
  /**
   * Authored, webhook form only: how the receive URL is registered with the vendor. Absent means
   * the app registers it itself (`onSubscribe`) or the trigger is not a webhook. A poll or protocol
   * trigger that declares it is refused at load.
   */
  webhook?: WebhookSetup;
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
> extends Omit<Trigger, "params"> {
  /** The Trigger's params; a param's `parse` runs before every hook that receives `params`. */
  params?: ParamDefinition[];
  onSubscribe?: OnSubscribeHook<P, S>;
  onUnsubscribe?: OnUnsubscribeHook<P, S>;
  handleIngest?: HandleIngestHook<P, S, E>;
  poll?: PollHook<P, S, E>;
  parseOutput?: ParseOutputHook<E>;
  /**
   * Editor-time options for params with `options: { source: "resolveFields" }`, exactly as on an
   * Action: the host calls it while the subscription is being configured (never on delivery).
   */
  resolveFields?: ResolveFieldsHook;
}
