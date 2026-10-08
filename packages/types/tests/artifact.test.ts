import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1.0.0";
import {
  blobKeyExec,
  blobKeyMap,
  parseAppArtifactManifest,
  sha256HexBytes,
  sourceDigestOf,
  verifySha256,
} from "../mod.ts";

const H = "a".repeat(64);
const enc = (s: string) => new TextEncoder().encode(s);

function valid(withMap = false): Record<string, unknown> {
  const a: Record<string, unknown> = {
    artifactVersion: 1,
    id: "io.w6w.x",
    version: "1.0.0",
    manifest: { id: "io.w6w.x", version: "1.0.0", name: "x" },
    actions: [{ key: "act" }],
    auth: [{ auth: { key: "k" }, hooks: ["sign", "refresh"] }],
    healthChecks: [{ check: { key: "h" }, hasHook: true }],
    triggers: [{ trigger: { key: "t" }, hooks: ["poll"] }],
    interfaces: [],
    exec: { sha256: H, bytes: 10, format: "esm" },
    sourceDigest: H,
    buildInfo: { builder: "b", denoVersion: "2.8.2", minify: false, sourcemap: withMap },
  };
  if (withMap) a.map = { sha256: H, bytes: 5 };
  return a;
}

Deno.test("parse: accepts a complete literal, with and without map", () => {
  for (const m of [false, true]) {
    const r = parseAppArtifactManifest(valid(m));
    assert(r.ok, JSON.stringify(r));
    if (r.ok) assertEquals(r.value.id, "io.w6w.x");
  }
});

Deno.test("parse: total over non-objects", () => {
  for (const v of [null, undefined, 1, "s", [], {}]) {
    const r = parseAppArtifactManifest(v);
    assertFalse(r.ok);
  }
});

// One case per rule: each mutates exactly one thing and names the field.
const rules: [string, (a: Record<string, unknown>) => void, string][] = [
  ["artifactVersion", (a) => a.artifactVersion = 2, "artifactVersion"],
  ["unknown top key", (a) => a.extra = 1, "extra"],
  ["id empty", (a) => a.id = "", "id"],
  ["version empty", (a) => a.version = "", "version"],
  ["id != manifest.id", (a) => a.id = "other", "id: must equal"],
  ["version != manifest.version", (a) => a.version = "9", "version: must equal"],
  ["manifest not object", (a) => a.manifest = 1, "manifest"],
  [
    "manifest.assetsRoot",
    (a) => (a.manifest as Record<string, unknown>).assetsRoot = "/x",
    "assetsRoot",
  ],
  ["actions not array", (a) => a.actions = {}, "actions"],
  ["action without key", (a) => a.actions = [{ key: "" }], "actions[0].key"],
  ["auth entry not object", (a) => a.auth = [1], "auth[0]"],
  ["auth.auth not object", (a) => a.auth = [{ auth: 1, hooks: [] }], "auth[0].auth"],
  ["auth hook unknown", (a) => a.auth = [{ auth: {}, hooks: ["nope"] }], "auth[0].hooks"],
  ["auth unknown key", (a) => a.auth = [{ auth: {}, hooks: [], z: 1 }], "auth[0].z"],
  ["triggers not array", (a) => a.triggers = 1, "triggers"],
  [
    "trigger without key",
    (a) => a.triggers = [{ trigger: {}, hooks: [] }],
    "triggers[0].trigger.key",
  ],
  [
    "trigger hook unknown",
    (a) => a.triggers = [{ trigger: { key: "t" }, hooks: ["x"] }],
    "triggers[0].hooks",
  ],
  [
    "check without key",
    (a) => a.healthChecks = [{ check: {}, hasHook: true }],
    "healthChecks[0].check.key",
  ],
  [
    "hasHook not boolean",
    (a) => a.healthChecks = [{ check: { key: "h" }, hasHook: 1 }],
    "healthChecks[0].hasHook",
  ],
  ["interfaces not array", (a) => a.interfaces = {}, "interfaces"],
  [
    "exec sha uppercase",
    (a) => a.exec = { sha256: "A".repeat(64), bytes: 1, format: "esm" },
    "exec.sha256",
  ],
  ["exec bytes negative", (a) => a.exec = { sha256: H, bytes: -1, format: "esm" }, "exec.bytes"],
  ["exec bytes fractional", (a) => a.exec = { sha256: H, bytes: 1.5, format: "esm" }, "exec.bytes"],
  ["exec format", (a) => a.exec = { sha256: H, bytes: 1, format: "cjs" }, "exec.format"],
  ["exec unknown key", (a) => a.exec = { sha256: H, bytes: 1, format: "esm", z: 1 }, "exec.z"],
  ["exec missing key", (a) => a.exec = { sha256: H, bytes: 1 }, "exec.format"],
  ["map sha", (a) => {
    a.map = { sha256: "zz", bytes: 1 };
    (a.buildInfo as Record<string, unknown>).sourcemap = true;
  }, "map.sha256"],
  ["map bytes", (a) => {
    a.map = { sha256: H, bytes: -2 };
    (a.buildInfo as Record<string, unknown>).sourcemap = true;
  }, "map.bytes"],
  ["map unknown key", (a) => {
    a.map = { sha256: H, bytes: 1, z: 1 };
    (a.buildInfo as Record<string, unknown>).sourcemap = true;
  }, "map.z"],
  ["sourceDigest", (a) => a.sourceDigest = "short", "sourceDigest"],
  ["buildInfo not object", (a) => a.buildInfo = null, "buildInfo"],
  [
    "buildInfo.builder",
    (a) => (a.buildInfo as Record<string, unknown>).builder = "",
    "buildInfo.builder",
  ],
  [
    "buildInfo.denoVersion",
    (a) => (a.buildInfo as Record<string, unknown>).denoVersion = 2,
    "buildInfo.denoVersion",
  ],
  [
    "buildInfo.minify",
    (a) => (a.buildInfo as Record<string, unknown>).minify = "y",
    "buildInfo.minify",
  ],
  [
    "buildInfo.sourcemap type",
    (a) => (a.buildInfo as Record<string, unknown>).sourcemap = "y",
    "buildInfo.sourcemap",
  ],
  ["buildInfo unknown key", (a) => (a.buildInfo as Record<string, unknown>).z = 1, "buildInfo.z"],
  [
    "sourcemap true without map",
    (a) => (a.buildInfo as Record<string, unknown>).sourcemap = true,
    "buildInfo.sourcemap",
  ],
  ["map without sourcemap", (a) => a.map = { sha256: H, bytes: 1 }, "buildInfo.sourcemap"],
];
for (const [name, mutate, field] of rules) {
  Deno.test(`parse rejects: ${name}`, () => {
    const a = valid();
    mutate(a);
    const r = parseAppArtifactManifest(a);
    assertFalse(r.ok);
    assert(r.errors.some((e) => e.includes(field)), `no error naming ${field}: ${r.errors}`);
  });
}

Deno.test("parse collects all errors, not just the first", () => {
  const a = valid();
  a.id = "";
  a.sourceDigest = "x";
  const r = parseAppArtifactManifest(a);
  assertFalse(r.ok);
  assert(r.errors.length >= 2);
});

Deno.test("sha256HexBytes / verifySha256", async () => {
  const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assertEquals(await sha256HexBytes(enc("abc")), abc);
  assert(await verifySha256(enc("abc"), abc));
  assertFalse(await verifySha256(enc("abc"), abc.slice(0, 63) + "0"));
  assertFalse(await verifySha256(enc("abc"), abc.toUpperCase()));
  assertFalse(await verifySha256(enc("abc"), "nope"));
});

Deno.test("blob keys", () => {
  assertEquals(blobKeyExec(H), `apps/exec/${H}.js`);
  assertEquals(blobKeyMap(H), `apps/map/${H}.js.map`);
  for (const f of [blobKeyExec, blobKeyMap]) {
    assertThrows(() => f("../x"), TypeError);
    assertThrows(() => f("A".repeat(64)), TypeError);
  }
});

Deno.test("sourceDigestOf: pinned values and order independence", async () => {
  const a = { path: "b.ts", bytes: enc("x") };
  const b = { path: "a/c.ts", bytes: enc("yz") };
  const want = "bed9ed2f89e7f33391dfd55133a0236452e2c5897792dce3a8a7b2d60ddf40b7";
  assertEquals(await sourceDigestOf([a, b]), want);
  assertEquals(await sourceDigestOf([b, a]), want);
  assertEquals(
    await sourceDigestOf([]),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

Deno.test("sourceDigestOf: length field separates (a,'bc') from (ab,'c')", async () => {
  const x = await sourceDigestOf([{ path: "a", bytes: enc("bc") }]);
  const y = await sourceDigestOf([{ path: "ab", bytes: enc("c") }]);
  assert(x.startsWith("e1cf9898"), x);
  assert(y.startsWith("7a4656db"), y);
});

Deno.test("sourceDigestOf: path rules throw", async () => {
  const f = (path: string) => ({ path, bytes: enc("") });
  for (const p of ["/abs", "a\\b", "", ".", "..", "a/../b", "a//b", "a/./b", "a/"]) {
    await assertRejects(() => sourceDigestOf([f(p)]), TypeError, undefined, `path ${p}`);
  }
  await assertRejects(() => sourceDigestOf([f("a"), f("a")]), TypeError);
});
