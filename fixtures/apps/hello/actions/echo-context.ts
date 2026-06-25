import type { ActionDefinition } from "@w6w/types";

/**
 * Echoes the read-only invocation metadata the runtime injects as
 * `ctx.invocation`. Used by the runtime tests to assert the host-issued
 * context (invocationId, runId, stepId, trigger) reaches the action — and that
 * it is plain data, never an authority.
 */
const echoContext: ActionDefinition = {
  key: "echo-context",
  type: "read",
  title: "Echo Context",
  description: "Returns the injected ctx.invocation metadata.",
  params: [],
  output: [{ key: "invocation", type: "object", label: "Invocation context" }],

  execute(_input, ctx) {
    return { invocation: ctx.invocation ?? null };
  },
};

export default echoContext;
