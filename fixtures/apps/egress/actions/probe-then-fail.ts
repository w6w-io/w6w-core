import type { ActionDefinition } from "@w6w/types";

interface Input {
  url: string;
}

/**
 * Mirrors a legitimate fallback pattern: probe `input.url` through the
 * runtime's egress path, swallow WHATEVER that probe throws (denied,
 * network error, anything), then fail for an unrelated reason of its own.
 * Exists to prove `withDeniedUnwrap`'s `unwrap` does not reclassify this
 * second, unrelated failure as the swallowed probe's `egress_denied` —
 * round 2's R7.
 */
const probeThenFail: ActionDefinition<Input> = {
  key: "probe-then-fail",
  type: "perform",
  title: "Probe then fail",
  description:
    "Fetch input.url, swallow any error, then throw an unrelated failure.",
  params: [
    { key: "url", label: "URL", type: "string", required: true },
  ],
  output: [
    { key: "status", type: "number", label: "HTTP status" },
  ],

  async execute(input, ctx) {
    try {
      await ctx.fetch(input.url);
    } catch {
      // Intentionally swallowed — the action falls through to different
      // logic on failure, a legitimate pattern (probe one endpoint, then
      // fall back). The real failure below is unrelated to this probe.
    }
    throw new Error("UNRELATED FAILURE");
  },
};

export default probeThenFail;
