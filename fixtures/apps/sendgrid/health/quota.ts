import type { HealthCheckDefinition } from "@w6w/types";

/**
 * `credential: "signed"` (the default for kind `quota`) — the credential goes
 * on the wire, injected by `sign` exactly as for an Action.
 */
const quota: HealthCheckDefinition = {
  key: "quota",
  title: "API quota",
  kind: "quota",
  severity: "informational",

  async check(_input, ctx) {
    const display = (ctx.connection?.display ?? {}) as { apiBase?: string };
    const res = await ctx.fetch(`${display.apiBase ?? "https://api.sendgrid.com"}/v3/user/credits`);
    if (!res.ok) return { state: "unknown", message: `returned ${res.status}` };
    const body = await res.json() as { remain?: number; total?: number };
    return {
      state: "ok",
      quota: [{ id: "credits", remaining: body.remain, limit: body.total, unit: "requests" }],
    };
  },
};

export default quota;
