import type { HealthCheckDefinition } from "@w6w/types";

/**
 * `credential: "context"` — needs the Connection to know WHICH host to call,
 * but no credential to interpret the answer. `sign` must not run.
 */
const reachable: HealthCheckDefinition = {
  key: "reachable",
  title: "API reachable",
  kind: "dependency",
  scope: "connection",
  credential: "context",

  async check(_input, ctx) {
    const display = (ctx.connection?.display ?? {}) as { apiBase?: string };
    if (!display.apiBase) return { state: "unknown", message: "connection records no apiBase" };
    const res = await ctx.fetch(`${display.apiBase}/health`);
    return res.ok ? { state: "ok" } : { state: "down", message: `returned ${res.status}` };
  },
};

export default reachable;
