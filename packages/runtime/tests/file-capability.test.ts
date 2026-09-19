/**
 * T1.2.1 — the `ctx.file` proxy pair (A1-A3, A6) and DC-5's binary-safe
 * `ctx.fetch` body (A4), plus the two live A5 decision sites this suite can
 * exercise directly (`egress.ts`'s capture placeholder, `overrides.ts`'s
 * loud-failure guard). Runs the REAL Deno Worker sandbox against the REAL
 * `core/fixtures/apps/file/` via `runHook` — not a hand-written model of the
 * message channel. Every assertion is on the artefact handed to the host-side
 * stub, or on an independent literal, never on a value the code under test
 * produced and then re-decoded.
 */
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { applyOverrides, loadApp, runHook, W6WError } from "../mod.ts";
import { egressInfo } from "../src/egress.ts";
import type { WireResponse } from "../src/sandbox/protocol.ts";
import type { FileRef, RequestOverrides, SignableRequest } from "@w6w/types";

const FILE_DIR = fromFileUrl(new URL("../../../fixtures/apps/file", import.meta.url));

/** A payload no UTF-8 decoder round-trips: a NUL, 0xFF, 0xFE, and a lone
 * high-surrogate UTF-8 sequence (U+D800, invalid per strict UTF-8), mixed
 * with a few printable bytes so a naive "it's basically text" path doesn't
 * accidentally look correct too. */
const BINARY_PAYLOAD = [0x00, 0xff, 0xfe, 0xed, 0xa0, 0x80, 0x41, 0x42, 0x43];

const FILE_REF_KEYS = ["contentType", "expiresAt", "filename", "id", "kind", "size"].sort();

/** Host-side byte store standing in for the real T2.1.1 persistence — the
 * only substitute the test plan allows, and every assertion below is on what
 * IT was handed, never on a value read back out of it. */
function makeFileStore() {
  const store = new Map<string, { ref: FileRef; bytes: Uint8Array }>();

  const onFileCreate = (
    input: { bytes: Uint8Array; contentType: string; filename: string },
  ): Promise<FileRef> => {
    assert(input.bytes instanceof Uint8Array, "onFileCreate must receive a real Uint8Array");
    const ref: FileRef = {
      kind: "file",
      id: crypto.randomUUID(),
      contentType: input.contentType,
      size: input.bytes.length,
      filename: input.filename,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    store.set(ref.id, { ref, bytes: input.bytes });
    return Promise.resolve(ref);
  };

  const onFileRead = (refId: string): Promise<{ ref: FileRef; bytes: Uint8Array }> => {
    assertEquals(typeof refId, "string", "onFileRead must receive only the id string");
    const hit = store.get(refId);
    if (!hit) return Promise.reject(new Error("unknown_file"));
    return Promise.resolve(hit);
  };

  return { onFileCreate, onFileRead, store };
}

// ── A1 / DC-3 — the capability surface ──────────────────────────────────────

Deno.test("A1: Object.keys(ctx.file) is exactly ['read', 'create']", async () => {
  const app = await loadApp(FILE_DIR);
  const { onFileCreate, onFileRead } = makeFileStore();
  const result = await runHook<{ keys: string[] }>({
    entryPath: app.entryPath,
    selector: { kind: "action", key: "capabilities" },
    input: {},
    readScope: app.dir,
    onFileRead,
    onFileCreate,
  });
  assertEquals(result.keys, ["read", "create"]);
});

// ── A2 — no capability means a refusal, not a crash ─────────────────────────

// The exact substring proxyFile's OWN guard throws — asserted, not just "some
// W6WError" — so a deleted worker-side guard (which still ends up rejecting,
// via run-hook.ts's separate host-side "file unavailable" guard) is caught:
// that path produces a DIFFERENT message than this one.
const NO_CAPABILITY = "File capability is not available";

Deno.test("A2: ctx.file.read rejects when the host supplies neither callback", async () => {
  const app = await loadApp(FILE_DIR);
  await assertRejects(
    () =>
      runHook({
        entryPath: app.entryPath,
        selector: { kind: "action", key: "read-file" },
        input: { ref: "whatever" },
        readScope: app.dir,
      }),
    W6WError,
    NO_CAPABILITY,
  );
});

Deno.test("A2: ctx.file.create rejects when the host supplies neither callback", async () => {
  const app = await loadApp(FILE_DIR);
  await assertRejects(
    () =>
      runHook({
        entryPath: app.entryPath,
        selector: { kind: "action", key: "create-file" },
        input: { bytes: [1, 2, 3], contentType: "text/plain", filename: "a.txt" },
        readScope: app.dir,
      }),
    W6WError,
    NO_CAPABILITY,
  );
});

Deno.test("A2: supplying only one of the two callbacks still leaves ctx.file rejecting", async () => {
  // DC-3: a conforming host implements the whole two-method capability or
  // none of it — `enableFile` requires BOTH callbacks, not just one.
  const app = await loadApp(FILE_DIR);
  const { onFileCreate } = makeFileStore();
  await assertRejects(
    () =>
      runHook({
        entryPath: app.entryPath,
        selector: { kind: "action", key: "read-file" },
        input: { ref: "whatever" },
        readScope: app.dir,
        onFileCreate, // onFileRead deliberately omitted
      }),
    W6WError,
    NO_CAPABILITY,
  );
});

// ── A3 — bytes survive the round trip, including non-UTF-8 bytes ───────────

Deno.test("A3: create -> read round-trips binary bytes byte-identically", async () => {
  const app = await loadApp(FILE_DIR);
  const { onFileCreate, onFileRead } = makeFileStore();

  const created = await runHook<{ ref: FileRef }>({
    entryPath: app.entryPath,
    selector: { kind: "action", key: "create-file" },
    input: { bytes: BINARY_PAYLOAD, contentType: "application/octet-stream", filename: "p.bin" },
    readScope: app.dir,
    onFileRead,
    onFileCreate,
  });

  // No extra field (M4: a stray `url` on the response) survives onto the
  // FileRef the app receives — exactly the six pinned fields, nothing else.
  assertEquals(Object.keys(created.ref).sort(), FILE_REF_KEYS);
  assertEquals(created.ref.size, BINARY_PAYLOAD.length);

  const read = await runHook<{ ref: FileRef; bytes: number[] }>({
    entryPath: app.entryPath,
    selector: { kind: "action", key: "read-file" },
    input: { ref: created.ref.id },
    readScope: app.dir,
    onFileRead,
    onFileCreate,
  });

  assertEquals(read.bytes, BINARY_PAYLOAD);
  assertEquals(Object.keys(read.ref).sort(), FILE_REF_KEYS);
});

// ── A4 / DC-5 — the outgoing ctx.fetch body is binary-safe ──────────────────

Deno.test("A4: a Uint8Array ctx.fetch body reaches onFetch as real bytes, not a digit list", async () => {
  const app = await loadApp(FILE_DIR);
  let captured: SignableRequest | undefined;
  const emptyResponse: WireResponse = {
    status: 200,
    statusText: "OK",
    headers: {},
    body: new Uint8Array(),
  };

  const result = await runHook<{ status: number }>({
    entryPath: app.entryPath,
    selector: { kind: "action", key: "send-binary" },
    input: { url: "https://example.test/upload", bytes: BINARY_PAYLOAD },
    readScope: app.dir,
    onFetch: (request) => {
      captured = request;
      return Promise.resolve(emptyResponse);
    },
  });

  assertEquals(result.status, 200);
  assert(captured, "onFetch must have been called");
  assert(captured!.body instanceof Uint8Array, "SignableRequest.body must be a real Uint8Array");
  assertEquals(Array.from(captured!.body as Uint8Array), BINARY_PAYLOAD);
});

// ── A5 site 1 (egress.ts:107) — a binary body is never decoded into capture ─

Deno.test("A5: the egress capture of a binary body is a byte-count placeholder, never the bytes", () => {
  const req: SignableRequest = {
    url: "https://example.test/upload",
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(BINARY_PAYLOAD),
  };
  const res: WireResponse = { status: 200, statusText: "OK", headers: {}, body: new Uint8Array() };

  const info = egressInfo(req, res, { capture: true, durationMs: 1 });

  assertEquals(info.requestBody, `[binary ${BINARY_PAYLOAD.length} bytes]`);
  // Never a lossy decode of the raw bytes into the capture surface.
  assert(!info.requestBody?.includes("�"), "capture must not contain a decoded replacement char");
});

// ── A5 site 3 (overrides.ts:351-355) — an override on a binary body fails loudly ─

Deno.test("A5: a body override on a binary request fails loudly, without corrupting the bytes", () => {
  const request: SignableRequest = {
    url: "https://example.test/upload",
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(BINARY_PAYLOAD),
  };
  const overrides: RequestOverrides = { body: { foo: "bar" } };

  const err = assertThrows(() => applyOverrides(request, overrides), W6WError);
  assert(err.message.toLowerCase().includes("binary"), err.message);
});
