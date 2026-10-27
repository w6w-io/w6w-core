import type { ActionDefinition } from "@w6w/types";

interface Input {
  url: string;
}

/** Fetches `input.url` through the signed egress path and reports the status. */
const whoami: ActionDefinition<Input> = {
  key: "whoami",
  type: "perform",
  title: "Who am I",
  description: "Fetch a URL through the signed egress path.",
  params: [
    { key: "url", label: "URL", type: "string", required: true },
  ],
  output: [
    { key: "status", type: "number", label: "HTTP status" },
  ],

  async execute(input, ctx) {
    const res = await ctx.fetch(input.url);
    return { status: res.status };
  },
};

export default whoami;
