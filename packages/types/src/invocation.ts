/**
 * Invocation — the envelope used to call an Action.
 * See rfcs/invocation.md.
 */
import type { RequestOverrides } from "./overrides.ts";

export type InvocationTrigger = "workflow" | "editor" | "api" | "replay" | "test";

export interface InvocationContext {
  /** Unique per Invocation. Host-issued. */
  invocationId?: string;
  runId?: string;
  stepId?: string;
  trigger?: InvocationTrigger;
}

export interface Invocation {
  manifestVersion: string;
  /** The App declaring the Action. */
  app: string;
  /** Action `key` within the App. */
  action: string;
  /** Connection that supplies credentials. Required when the App declares any Auth. */
  connection?: string;
  /** Map of param `key` -> value. */
  params?: Record<string, unknown>;
  /**
   * Caller-supplied overrides applied to the outbound HTTP request, for
   * reaching a vendor field the Action does not declare. Merged at the wire,
   * just before the auth `sign` hook runs — NOT into `params`, which
   * `resolveParams` still restricts to the Action's declared surface. Fields
   * are named the way the VENDOR documents them, not the way the Action's form
   * does. See {@link RequestOverrides}.
   */
  overrides?: RequestOverrides;
  context?: InvocationContext;
}
