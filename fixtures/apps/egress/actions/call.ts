import type { ActionDefinition } from "@w6w/types";

interface Input {
  url: string;
}

/**
 * Fetches `input.url` through the runtime's egress path and returns the
 * final response's status and body — so a redirect test can prove the
 * *final* hop's response reached the caller, not just that something
 * resolved.
 */
const call: ActionDefinition<Input> = {
  key: "call",
  type: "perform",
  title: "Call",
  description: "Fetch a URL through the runtime's egress path.",
  params: [
    { key: "url", label: "URL", type: "string", required: true },
  ],
  output: [
    { key: "status", type: "number", label: "HTTP status" },
    { key: "body", type: "string", label: "Response body" },
  ],

  async execute(input, ctx) {
    const res = await ctx.fetch(input.url);
    return { status: res.status, body: await res.text() };
  },
};

export default call;
