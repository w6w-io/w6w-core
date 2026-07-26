import type { HealthCheckDefinition } from "@w6w/types";

/**
 * `credential: "none"` — no Connection, no `sign`, and a host OUTSIDE the app's
 * own allowlist. The extra host is granted only because the posture is unsigned.
 */
const service: HealthCheckDefinition = {
  key: "service",
  title: "Platform status",
  kind: "service",
  network: { allow: ["status.example.test"] },
  minIntervalSeconds: 60,

  async check(_input, ctx) {
    const res = await ctx.fetch("https://status.example.test/api/v2/status.json");
    if (!res.ok) return { state: "unknown", message: `status API returned ${res.status}` };
    const body = await res.json() as {
      status: { indicator: string };
      components?: Record<string, string>;
    };
    const map = (v: string) => v === "none" ? "ok" as const : v === "critical" ? "down" as const : "degraded" as const;
    return {
      state: map(body.status.indicator),
      // One call, several components — the point of a report over a boolean.
      components: Object.fromEntries(
        Object.entries(body.components ?? {}).map(([id, v]) => [id, { state: map(v) }]),
      ),
      ttlSeconds: 60,
    };
  },
};

export default service;
