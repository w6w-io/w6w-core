import type { ActionDefinition } from "@w6w/types";

interface Input {
  bytes: unknown;
  contentType: string;
  filename: string;
}

/**
 * ROUND 1 / B2 — forwards `input.bytes` to `ctx.file.create` EXACTLY as
 * received, with no `new Uint8Array(...)` wrapping (unlike `create-file.ts`,
 * whose own coercion would turn any input into a real `Uint8Array` before it
 * ever reaches the proxy, defeating an adversarial test). Exists solely so
 * `file-capability.test.ts` can drive a non-`Uint8Array` value (e.g. a plain
 * string) all the way to `proxyFile.create`'s own runtime guard (B1) through
 * the real Deno Worker, never through a hand-written model of the channel.
 */
const createFileRaw: ActionDefinition<Input> = {
  key: "create-file-raw",
  type: "perform",
  title: "Create File (raw)",
  description:
    "Forwards bytes to ctx.file.create unmodified, for adversarial testing.",
  params: [
    { key: "bytes", label: "Bytes", type: "string", required: true },
    {
      key: "contentType",
      label: "Content Type",
      type: "string",
      required: true,
    },
    { key: "filename", label: "Filename", type: "string", required: true },
  ],
  output: [{ key: "ref", type: "object", label: "Minted FileRef" }],

  async execute(input, ctx) {
    if (!ctx.file) {
      throw new Error("ctx.file is not available in this context.");
    }
    const ref = await ctx.file.create(input.bytes as unknown as Uint8Array, {
      contentType: input.contentType,
      filename: input.filename,
    });
    return { ref };
  },
};

export default createFileRaw;
