/**
 * `isFileRef` — the discriminator every consumer relies on to tell a FileRef
 * from a plain object. Every near-miss shape below must be rejected: only a
 * `kind: "file"` object carrying all five other fields with the right
 * primitive types is a FileRef.
 */
import { assert, assertFalse } from "jsr:@std/assert@^1.0.0";
import { type FileRef, isFileRef } from "../src/file.ts";

const complete: FileRef = {
  kind: "file",
  id: "3fa6b2c0-1a2b-4c3d-9e8f-0123456789ab",
  contentType: "text/plain",
  size: 42,
  filename: "notes.txt",
  expiresAt: "2026-09-20T00:00:00Z",
};

Deno.test("isFileRef: true for a complete, well-formed ref", () => {
  assert(isFileRef(complete));
});

Deno.test("isFileRef: false for a bare string", () => {
  assertFalse(isFileRef(complete.id));
});

Deno.test("isFileRef: false for null and undefined", () => {
  assertFalse(isFileRef(null));
  assertFalse(isFileRef(undefined));
});

Deno.test("isFileRef: false when `kind` is missing", () => {
  const { kind: _kind, ...rest } = complete;
  assertFalse(isFileRef(rest));
});

Deno.test("isFileRef: false when `kind` is a different discriminator", () => {
  assertFalse(isFileRef({ ...complete, kind: "document" }));
});

Deno.test("isFileRef: false when `size` is a numeric string", () => {
  assertFalse(isFileRef({ ...complete, size: "42" }));
});

Deno.test("isFileRef: false when `expiresAt` is missing", () => {
  const { expiresAt: _expiresAt, ...rest } = complete;
  assertFalse(isFileRef(rest));
});
