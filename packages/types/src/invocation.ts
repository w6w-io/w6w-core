/**
 * Invocation — the envelope used to call an Action.
 * See rfcs/invocation.md.
 */

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
  context?: InvocationContext;
}
