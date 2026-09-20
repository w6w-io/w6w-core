import type { ActionDefinition } from "@w6w/types";

interface Input {
  mode: "getter-ref" | "fake-u8" | "fake-u8-fetch";
}

/**
 * ROUND 2 / B4 — builds the evaluator's three proven B1 bypasses
 * (`artifacts/T1.2.1-r1-sandbox-escape.md` rows 1, 2, 6) INSIDE the worker
 * realm, the only place they can be built at all: a getter-based TOCTOU or a
 * fake-branded `Uint8Array` assembled host-side (e.g. in a test file's
 * `input`) is flattened to plain data by `structuredClone` before it ever
 * reaches the app, so a faithful reproduction has to be untrusted app code,
 * exactly like every other action in this fixture.
 */
const evil: ActionDefinition<Input> = {
  key: "evil",
  type: "perform",
  title: "Evil",
  description: "Reproduces the evaluator's proven B1 bypasses, for regression testing.",
  params: [{ key: "mode", label: "Mode", type: "string", required: true }],
  output: [{ key: "outcome", type: "string", label: "Outcome" }],

  async execute(input, ctx) {
    if (!ctx.file) throw new Error("ctx.file is not available in this context.");
    switch (input.mode) {
      // Row 1 — getter TOCTOU: `isFileRef`'s own read of `.id` sees a
      // string; a second read (the wire-forwarding line, and now
      // run-hook.ts's host-side re-check) would see a different value if
      // the getter could fire again post-clone.
      case "getter-ref": {
        let n = 0;
        const hostile = {
          kind: "file" as const,
          contentType: "text/plain",
          size: 1,
          filename: "a.txt",
          expiresAt: "2030-01-01T00:00:00Z",
          get id() {
            n++;
            return n === 1 ? "looks-like-a-string" : { path: "/etc/passwd", token: "hunter2" };
          },
        };
        const { ref, bytes } = await ctx.file.read(hostile as unknown as string);
        return { outcome: `RESOLVED ${ref.id} ${bytes.length}` };
      }
      // Row 2 — a non-typed-array object whose prototype IS
      // Uint8Array.prototype, so a same-realm `instanceof Uint8Array` is
      // true even though it has no `[[ViewedArrayBuffer]]` slot.
      case "fake-u8": {
        const fake = Object.create(Uint8Array.prototype) as Record<string, unknown>;
        fake.path = "/etc/passwd";
        fake.token = "hunter2";
        const ref = await ctx.file.create(fake as unknown as Uint8Array, {
          contentType: "text/plain",
          filename: "a.txt",
        });
        return { outcome: `RESOLVED ${ref.id}` };
      }
      // Row 6 — the same fake typed array as a ctx.fetch body: DC-5's
      // `coerceBody`'s own `instanceof`/`ArrayBuffer.isView` checks are
      // defeated the same way, one realm over.
      case "fake-u8-fetch": {
        const fake = Object.create(Uint8Array.prototype) as Record<string, unknown>;
        fake.path = "/etc/passwd";
        fake.token = "hunter2";
        const res = await ctx.fetch("https://example.test/u", {
          method: "POST",
          body: fake as unknown as Uint8Array,
        });
        return { outcome: `RESOLVED status=${res.status}` };
      }
      default:
        throw new Error(`unknown mode ${input.mode}`);
    }
  },
};

export default evil;
