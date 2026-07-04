/**
 * Hook contracts — the I/O shapes every hook file must satisfy.
 *
 * NOTE: There is no Hook Runtime RFC yet (the ROADMAP calls it the missing
 * linchpin). These types are the first concrete draft of that contract,
 * derived from the I/O shapes the Action, Auth, and Param RFCs already imply.
 * Decisions encoded here (default export, the `HookContext` ambient API, the
 * error shape) must be backported into a Hook Runtime RFC.
 */
import type { Option } from "./param.ts";
import type { OutputField } from "./action.ts";
import type { RedactedConnection } from "./connection.ts";
import type { InvocationContext } from "./invocation.ts";

/** Ambient API available to every hook, injected by the runtime. */
export interface HookContext {
  /** Network access, mediated by the host (egress allowlist + signing). */
  fetch: typeof fetch;
  /** Structured logging routed back to the host. */
  log: (level: "debug" | "info" | "warn" | "error", message: string, data?: unknown) => void;
  /** The redacted Connection, when the invocation supplied one. Never contains the credential. */
  connection?: RedactedConnection;
  /**
   * Read-only, host-issued metadata about the call this hook is part of:
   * `invocationId` (use as an idempotency key for `perform` actions), `runId`
   * and `stepId` (for log correlation), and `trigger` (e.g. skip real
   * side-effects when it is `"editor"` or `"test"`). Pure data — never an
   * authority. Present for action `execute`; absent for standalone auth hooks.
   */
  invocation?: InvocationContext;
  /**
   * Non-portable, host-provided capabilities (see {@link HostExtensions}).
   * Empty in the reference runtime — a host fills it via declaration merging.
   * Anything an app reads from `ctx.host` ties it to that host: it will not run
   * on a host that does not provide the same extension. Host extensions are
   * still bound by credential isolation — they MUST be host-mediated (the host
   * performs the privileged work), never tokens handed into the sandbox.
   */
  host?: HostExtensions;
}

/**
 * The extension point for host-specific `ctx.host` capabilities. Intentionally
 * empty in `@w6w/types` so the core model stays vendor-neutral and portable. A
 * host augments it from its own codebase via TypeScript declaration merging —
 * which is why this is an `interface`, not a `type`:
 *
 * ```ts
 * // In the host's own code (NOT in @w6w/types):
 * declare module "@w6w/types" {
 *   interface HostExtensions {
 *     // Host-mediated fetch to internal services; auth injected on the host,
 *     // never in the sandbox. Reads like `ctx.fetch` but for internal egress.
 *     cohostFetch: typeof fetch;
 *   }
 * }
 * ```
 *
 * After merging, `ctx.host?.cohostFetch` is fully typed inside that host and
 * absent everywhere else. The leading `host.` at every call site marks code
 * that has left portable territory.
 */
// deno-lint-ignore no-empty-interface
export interface HostExtensions {}

/** Result returned by a validation hook. */
export type ValidationResult = { ok: true } | { ok: false; message: string };

/** Action `execute` — does the work. Input is resolved params, output is the action's `output`. */
export type ActionExecuteHook<P = Record<string, unknown>, O = unknown> = (
  input: P,
  ctx: HookContext,
) => O | Promise<O>;

/** Param `options.source` — populate choices dynamically. */
export type OptionsSourceHook = (
  input: { form: Record<string, unknown>; dependsOn: Record<string, unknown> },
  ctx: HookContext,
) => Option[] | Promise<Option[]>;

/** Param `validation.hook` — custom validation beyond declarative rules. */
export type ValidationHook = (
  input: { value: unknown; form: Record<string, unknown> },
  ctx: HookContext,
) => ValidationResult | Promise<ValidationResult>;

/** Action dynamic `output.source` — declare output fields from configuration. */
export type OutputSourceHook = (
  input: { form: Record<string, unknown> },
  ctx: HookContext,
) => OutputField[] | Promise<OutputField[]>;

/**
 * A serializable HTTP request, as seen by the `sign` hook. Plain data so it can
 * cross the sandbox boundary; the hook mutates it (typically adding auth) and
 * returns it.
 */
export interface SignableRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | null;
}

/**
 * Auth `sign` — the ONLY hook that receives the unredacted credential. It runs
 * in an isolated, network-less context: it transforms the outbound request
 * (e.g. injects an Authorization header) but cannot itself reach the network,
 * so it can never exfiltrate the credential it holds.
 */
export type SignHook = (
  input: { request: SignableRequest; credential: unknown },
  ctx: HookContext,
) => SignableRequest | Promise<SignableRequest>;

/** A generic hook signature; specific kinds narrow `input`/`output`. */
export type Hook<I = unknown, O = unknown> = (input: I, ctx: HookContext) => O | Promise<O>;

/** Auth `exchange` — turn auth code / form input into the stored opaque credential. */
export type ExchangeHook = (
  input: { fields?: Record<string, unknown>; code?: string; redirectUri?: string },
  ctx: HookContext,
) => unknown | Promise<unknown>;

/** Auth `refresh` — produce a fresh credential from the current one. */
export type RefreshHook = (
  input: { credential: unknown },
  ctx: HookContext,
) => unknown | Promise<unknown>;

/** Auth `afterConnect` — fetch display data for the connection label. */
export type AfterConnectHook = (
  input: { credential: unknown },
  ctx: HookContext,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

/**
 * Trigger `onSubscribe` — called when a subscription is created. Sets up the
 * third-party (register a webhook, seed a poll cursor) and returns opaque state
 * the host persists on the subscription.
 */
export type OnSubscribeHook<P = Record<string, unknown>, S = unknown> = (
  input: { params: P; subscriptionId: string; callbackUrl: string; hostUrl: string },
  ctx: HookContext,
) => S | Promise<S>;

/**
 * Trigger `onUnsubscribe` — called on subscription delete. Tears down any
 * third-party resources allocated by `onSubscribe`.
 */
export type OnUnsubscribeHook<P = Record<string, unknown>, S = unknown> = (
  input: { params: P; state: S; subscriptionId: string },
  ctx: HookContext,
) => void | Promise<void>;

/**
 * Trigger `handleIngest` — the transport-agnostic ingest hook. Converts a raw
 * inbound payload (HTTPS body, Kafka value, poll result) into zero or more
 * normalized events the host persists and dispatches to subscribed workflows.
 * Returning `[]` acknowledges the delivery but produces nothing to dispatch —
 * the right choice for pings and duplicates.
 */
export type HandleIngestHook<P = Record<string, unknown>, S = unknown, E = unknown> = (
  input: { raw: unknown; params: P; state: S; subscriptionId: string },
  ctx: HookContext,
) => E[] | Promise<E[]>;
