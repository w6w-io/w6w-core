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

/** Ambient API available to every hook, injected by the runtime. */
export interface HookContext {
  /** Network access, mediated by the host (egress allowlist + signing). */
  fetch: typeof fetch;
  /** Structured logging routed back to the host. */
  log: (level: "debug" | "info" | "warn" | "error", message: string, data?: unknown) => void;
  /** The redacted Connection, when the invocation supplied one. Never contains the credential. */
  connection?: RedactedConnection;
}

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
