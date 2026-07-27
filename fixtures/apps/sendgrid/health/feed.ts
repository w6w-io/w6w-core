import type { HealthCheckDefinition } from "@w6w/types";

/**
 * A feed-backed check: the host fetches and parses the declared Atom/RSS
 * document, so the hook receives entries rather than XML.
 *
 * `credential` is `none` (the default for `kind: "service"`), which the `feed`
 * posture rule requires — a status host must never see a credential. The feed's
 * host is added to this hook's allowlist implicitly, so it is NOT restated in
 * `network.allow`.
 *
 * The hook reads `latest`, not `entries`: a feed is a log of updates, and the
 * newest entry for a resolved incident still carries that incident's original
 * title. `latest` is the fold onto one entry per incident.
 */
const feed: HealthCheckDefinition = {
  key: "feed",
  title: "Platform status (feed)",
  kind: "service",
  covers: ["*"],
  feed: { url: "https://status.example.test/feed.rss", format: "auto", limit: 25 },
  minIntervalSeconds: 120,

  check({ feed }, _ctx) {
    // A feed that could not be read says nothing about the vendor.
    if (!feed || feed.error) {
      return { state: "unknown", message: feed?.error ?? "no feed supplied" };
    }
    const open = feed.latest.filter((e) => !/^\s*status:\s*resolved/i.test(e.summary));
    if (open.length === 0) return { state: "ok", ttlSeconds: 120 };
    return {
      state: "degraded",
      message: open.map((e) => e.title).join("; "),
      ttlSeconds: 120,
    };
  },
};

export default feed;
