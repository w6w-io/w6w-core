import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import type { AppManifest } from "../mod.ts";
import {
  canonicalJson,
  DIGEST_VERSION,
  digestDescription,
  digestDescriptionVersioned,
  sha256Hex,
  sha256HexBytes,
} from "../mod.ts";

// Same literal the registry's interfaces.test.ts pins (the re-export's proof).
const manifest = {
  id: "io.w6w.fixture",
  manifestVersion: "1",
  name: "fixture",
  displayName: "Fixture",
  version: "1.0.0",
  categories: ["developer-tools"],
} as unknown as AppManifest;
const V1 = "e2b38f28e9cfcdd6fe2f00cbc788d22ca9498dd3572e118c3228ada51a2a9e1d";
const V2 = "ac727b6aae4a6d16f7e161c33d8f7d63f1733584efffded95a1f797d79281814";
const base = { manifest, actions: [], auth: [] };

Deno.test("digest v1 pin: no exec is byte-identical to the registry's literal", async () => {
  assertEquals(await digestDescription(base), V1);
});

Deno.test("digest v2 pin: exec changes the digest to the rehearsed literal", async () => {
  assertEquals(await digestDescription({ ...base, exec: "a".repeat(64) }), V2);
});

Deno.test("digestDescriptionVersioned: version 1 without exec, 2 with it", async () => {
  assertEquals(await digestDescriptionVersioned(base), { digest: V1, digestVersion: 1 });
  assertEquals(
    await digestDescriptionVersioned({ ...base, exec: "a".repeat(64) }),
    { digest: V2, digestVersion: 2 },
  );
});

Deno.test("digest: malformed exec throws TypeError from both functions", async () => {
  for (const exec of ["", "A".repeat(64), "a".repeat(63)]) {
    await assertRejects(() => digestDescription({ ...base, exec }), TypeError);
    await assertRejects(() => digestDescriptionVersioned({ ...base, exec }), TypeError);
  }
});

Deno.test("DIGEST_VERSION is 2", () => {
  assertEquals(DIGEST_VERSION, 2);
});

Deno.test("assetsRoot is dropped before digesting", async () => {
  const withRoot = { ...base, manifest: { ...manifest, assetsRoot: "/abs" } as AppManifest };
  assertEquals(await digestDescription(withRoot), V1);
});

Deno.test("canonicalJson sorts keys and drops undefined", () => {
  assertEquals(canonicalJson({ b: 1, a: [{ d: undefined, c: 2 }] }), '{"a":[{"c":2}],"b":1}');
});

Deno.test("sha256HexBytes: 'abc' vector; sha256Hex(text) delegates", async () => {
  const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assertEquals(await sha256HexBytes(new TextEncoder().encode("abc")), abc);
  assertEquals(await sha256Hex("abc"), abc);
});
