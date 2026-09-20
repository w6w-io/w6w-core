import type { ActionDefinition } from "@w6w/types";

interface Input {
  url: string;
  bytes: number[];
}

/**
 * POSTs a binary body through `ctx.fetch` — the DC-5 outgoing-body path
 * (`sandbox/worker.ts`'s `coerceBody`), exercised independently of `ctx.file`.
 * The test harness supplies `onFetch` directly (no real network call); this
 * action exists to prove the `SignableRequest` the host's `onFetch` receives
 * carries the real bytes, not a `String(Uint8Array)` digit list.
 */
const sendBinary: ActionDefinition<Input> = {
  key: "send-binary",
  type: "perform",
  title: "Send Binary",
  description: "POSTs a binary body through ctx.fetch.",
  params: [
    { key: "url", label: "URL", type: "string", required: true },
    { key: "bytes", label: "Bytes", type: "array", item: { type: "number" }, required: true },
  ],
  output: [{ key: "status", type: "number", label: "HTTP status" }],

  async execute(input, ctx) {
    const res = await ctx.fetch(input.url, { method: "POST", body: new Uint8Array(input.bytes) });
    return { status: res.status };
  },
};

export default sendBinary;
