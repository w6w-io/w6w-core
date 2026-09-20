import type { ActionDefinition } from "@w6w/types";

interface Input {
  ref: string;
}

/**
 * Calls `ctx.file.read` with a bare ref id STRING (never an object carrying a
 * path/URL/credential — A3) and returns the bytes as a plain number array:
 * an action's output must be JSON-serializable, so the `Uint8Array` is
 * unpacked here, on the app side, not on the wire.
 */
const readFile: ActionDefinition<Input> = {
  key: "read-file",
  type: "read",
  title: "Read File",
  description: "Reads a FileRef's bytes through ctx.file.read.",
  params: [
    { key: "ref", label: "Ref", type: "string", required: true },
  ],
  output: [
    { key: "ref", type: "object", label: "Resolved FileRef" },
    { key: "bytes", type: "array", label: "Byte values" },
  ],

  async execute(input, ctx) {
    if (!ctx.file) throw new Error("ctx.file is not available in this context.");
    const { ref, bytes } = await ctx.file.read(input.ref);
    return { ref, bytes: Array.from(bytes) };
  },
};

export default readFile;
