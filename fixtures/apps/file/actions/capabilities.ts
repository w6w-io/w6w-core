import type { ActionDefinition } from "@w6w/types";

/**
 * Returns `Object.keys(ctx.file)` exactly as the host built it — proves the
 * capability surface is exactly `read`/`create` (DC-3), never a third method,
 * and that `ctx.file` is a present object, not an absent field (A1).
 */
const capabilities: ActionDefinition = {
  key: "capabilities",
  type: "read",
  title: "Capabilities",
  description: "Returns Object.keys(ctx.file).",
  params: [],
  output: [{ key: "keys", type: "array", label: "ctx.file keys" }],

  execute(_input, ctx) {
    return { keys: Object.keys(ctx.file ?? {}) };
  },
};

export default capabilities;
