import type { ActionDefinition } from "@w6w/types";

interface Input {
  bytes: number[];
  contentType: string;
  filename: string;
}

/**
 * Calls `ctx.file.create` with a real `Uint8Array` built from the plain-number
 * array carried in `input` (params can only carry JSON-serializable data —
 * the wire's own binary safety is `ctx.file`'s, not the Action param surface's).
 */
const createFile: ActionDefinition<Input> = {
  key: "create-file",
  type: "perform",
  title: "Create File",
  description: "Stores bytes through ctx.file.create and returns the minted FileRef.",
  params: [
    { key: "bytes", label: "Bytes", type: "array", item: { type: "number" }, required: true },
    { key: "contentType", label: "Content Type", type: "string", required: true },
    { key: "filename", label: "Filename", type: "string", required: true },
  ],
  output: [{ key: "ref", type: "object", label: "Minted FileRef" }],

  async execute(input, ctx) {
    if (!ctx.file) throw new Error("ctx.file is not available in this context.");
    const ref = await ctx.file.create(new Uint8Array(input.bytes), {
      contentType: input.contentType,
      filename: input.filename,
    });
    return { ref };
  },
};

export default createFile;
