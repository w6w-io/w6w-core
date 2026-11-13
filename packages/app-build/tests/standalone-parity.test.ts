/**
 * Cross-mode parity (ruling R6): the SAME authored app, built once with
 * `resolution: "sibling"` (its `deno.json` maps `@w6w/types` to a `../types` directory) and
 * once with `resolution: "registry"` (the same `deno.json` carrying the pinned P3 specifiers,
 * resolved through the local JSR mirror in `tests/jsr-mirror.ts`), must produce:
 *
 * - byte-equal `app.js`;
 * - the same `execSha256`;
 * - the same registry content digest;
 * - a DIFFERENT `sourceDigest` — the two `deno.json` files differ, and the source tree is what
 *   the source digest covers.
 *
 * Only the `deno.json` differs between the two fixtures, so anything else that differs is a
 * resolution leak. The mirrors and caches are per-test temp dirs: no network, no shared cache.
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.0";
import { join } from "jsr:@std/path@^1.0.0";
import { sha256HexBytes } from "@w6w/types";
import { buildApp, type BuildResult, P3_SPECS } from "../mod.ts";
import { startMirror } from "./jsr-mirror.ts";

/** `core/packages` — holds the lane's `types` package, the sibling fixture's `../types`. */
const PACKAGES_DIR = join(import.meta.dirname!, "..", "..");

/** The one authored module, identical in both fixtures. It really pulls `@w6w/types` in. */
const INDEX = `import { DIGEST_VERSION } from "@w6w/types";

const ping = {
  key: "ping",
  type: "perform",
  title: "Ping",
  execute: () => ({ digestVersion: DIGEST_VERSION }),
};

const app = { actions: [ping] };

export default app;
`;

/** `package.json`, identical in both fixtures. */
const PACKAGE_JSON = JSON.stringify({
  name: "@w6w-fixtures/parity-demo",
  version: "1.0.0",
  description: "fixture",
  license: "MIT",
  author: { name: "w6w" },
  categories: ["developer-tools"],
  w6w: {
    id: "io.test.parity-demo",
    displayName: "Parity Demo",
    appearance: { icon: { url: "https://cdn.example.invalid/i.png" } },
    entry: "./index.ts",
  },
});

/** Sibling mode: `@w6w/types` is the lane's own package one directory above the app. */
const SIBLING_DENO_JSON = JSON.stringify(
  {
    imports: { "@w6w/types": "../types/mod.ts" },
  },
  null,
  2,
) + "\n";

/** Registry mode: exactly the pinned P3 specifiers, exact versions only. */
const REGISTRY_DENO_JSON = JSON.stringify({ imports: { ...P3_SPECS } }, null, 2) + "\n";

const HEX64 = /^[0-9a-f]{64}$/;

/** Copy `dir` into `dest` recursively (regular files only — the sources have no symlinks). */
async function copyTree(dir: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(dir)) {
    const from = join(dir, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory) await copyTree(from, to);
    else if (entry.isFile) await Deno.copyFile(from, to);
  }
}

/**
 * Stage `@w6w/types` as `dest` (`{deno.json, mod.ts, src/}`) — the same file set the JSR mirror
 * serves, so sibling mode and registry mode compile byte-identical sources.
 */
async function stageSiblingTypes(dest: string): Promise<void> {
  const pkg = join(PACKAGES_DIR, "types");
  await Deno.mkdir(dest, { recursive: true });
  await Deno.copyFile(join(pkg, "deno.json"), join(dest, "deno.json"));
  await Deno.copyFile(join(pkg, "mod.ts"), join(dest, "mod.ts"));
  await copyTree(join(pkg, "src"), join(dest, "src"));
}

/** Write one fixture app (`dir`) with `denoJson` plus the shared authored files. */
async function stageApp(dir: string, denoJson: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "package.json"), PACKAGE_JSON);
  await Deno.writeTextFile(join(dir, "deno.json"), denoJson);
  await Deno.writeTextFile(join(dir, "index.ts"), INDEX);
}

/** A short, human-usable measurement of where two bundles diverge. */
function measure(sibling: Uint8Array, registry: Uint8Array): string {
  const decoder = new TextDecoder();
  const common = Math.min(sibling.length, registry.length);
  let at = -1;
  for (let i = 0; i < common; i++) {
    if (sibling[i] !== registry[i]) {
      at = i;
      break;
    }
  }
  const sizes = `sibling ${sibling.length} B, registry ${registry.length} B`;
  if (at < 0) return `common ${common} B prefix identical, then length differs (${sizes})`;
  const around = (bytes: Uint8Array) =>
    JSON.stringify(decoder.decode(bytes.subarray(Math.max(0, at - 40), at + 60)));
  return `first difference at byte ${at} (${sizes}): sibling ${around(sibling)} vs registry ${
    around(registry)
  }`;
}

interface Ctx {
  sibling: BuildResult;
  registry: BuildResult;
  mirrorUrl: string;
  /** The fixture root: `<tmp>/sibling` and `<tmp>/registry` are the two app dirs. */
  tmp: string;
}

/**
 * Stage the two fixtures, start the mirror, point `JSR_URL`/`DENO_DIR` at this test's own dirs
 * (a fresh cache per build), run `fn`, then restore the environment and delete everything.
 */
async function withParity(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const mirror = await startMirror();
  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "w6w-parity-test-" }));
  const saved = { jsr: Deno.env.get("JSR_URL"), denoDir: Deno.env.get("DENO_DIR") };
  try {
    await stageSiblingTypes(join(tmp, "types"));
    await stageApp(join(tmp, "sibling"), SIBLING_DENO_JSON);
    await stageApp(join(tmp, "registry"), REGISTRY_DENO_JSON);
    Deno.env.set("JSR_URL", mirror.url);

    // Each build gets its own DENO_DIR: nothing is shared between the two modes but the sources.
    Deno.env.set("DENO_DIR", join(tmp, "deno-sibling"));
    const sibling = await buildApp(join(tmp, "sibling"), join(tmp, "out-sibling"), {
      resolution: "sibling",
    });
    Deno.env.set("DENO_DIR", join(tmp, "deno-registry"));
    const registry = await buildApp(join(tmp, "registry"), join(tmp, "out-registry"), {
      resolution: "registry",
    });

    await fn({ sibling, registry, mirrorUrl: mirror.url, tmp });
  } finally {
    for (const [key, value] of [["JSR_URL", saved.jsr], ["DENO_DIR", saved.denoDir]] as const) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await mirror.close();
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

Deno.test("5: cross-mode parity — same authored .ts, byte-equal app.js and equal digests", async () => {
  await withParity(async ({ sibling, registry, mirrorUrl, tmp }) => {
    // The premise: the authored files are the same bytes in both fixtures, only deno.json differs.
    for (const name of ["index.ts", "package.json"]) {
      assertEquals(
        await Deno.readFile(join(tmp, "sibling", name)),
        await Deno.readFile(join(tmp, "registry", name)),
        `${name} must be the same authored bytes in both fixtures`,
      );
    }
    assertNotEquals(
      await Deno.readTextFile(join(tmp, "sibling", "deno.json")),
      await Deno.readTextFile(join(tmp, "registry", "deno.json")),
      "the two fixtures must differ in deno.json (that is what sourceDigest covers)",
    );

    assertEquals(sibling.id, "io.test.parity-demo");
    assertEquals(registry.id, sibling.id);
    assertEquals(registry.version, sibling.version);

    const siblingJs = await Deno.readFile(join(sibling.outDir, "app.js"));
    const registryJs = await Deno.readFile(join(registry.outDir, "app.js"));

    // The core claim: how the app's `@w6w/*` imports resolved leaves no trace in the bundle.
    assert(
      siblingJs.length === registryJs.length &&
        siblingJs.every((byte, i) => byte === registryJs[i]),
      `cross-mode parity broken: ${measure(siblingJs, registryJs)}`,
    );

    const code = new TextDecoder().decode(registryJs);
    assert(!code.includes("jsr:"), "a jsr: specifier survived bundling");
    assert(!code.includes(mirrorUrl), "a mirror URL survived bundling");

    // Equal exec hash, stated twice: from the two builds, and against the bytes on disk.
    assertEquals(registry.execSha256, sibling.execSha256);
    assert(HEX64.test(sibling.execSha256), `execSha256 is not 64 hex: ${sibling.execSha256}`);
    assertEquals(sibling.execSha256, await sha256HexBytes(siblingJs));
    assertEquals(registry.execSha256, await sha256HexBytes(registryJs));

    // Equal registry content digest: the artifact an author would register is the same one.
    assertEquals(registry.digest, sibling.digest);
    assertEquals(sibling.digestVersion, 2);
    assertEquals(registry.digestVersion, 2);

    // The source digests MUST differ: the two deno.json files differ, and only they do.
    assert(HEX64.test(sibling.sourceDigest), `sourceDigest is not 64 hex: ${sibling.sourceDigest}`);
    assertNotEquals(registry.sourceDigest, sibling.sourceDigest);

    // The manifests carry the same exec and the differing source digests.
    const siblingManifest = JSON.parse(
      await Deno.readTextFile(join(sibling.outDir, "manifest.json")),
    );
    const registryManifest = JSON.parse(
      await Deno.readTextFile(join(registry.outDir, "manifest.json")),
    );
    assertEquals(registryManifest.exec.sha256, siblingManifest.exec.sha256);
    assertEquals(siblingManifest.sourceDigest, sibling.sourceDigest);
    assertEquals(registryManifest.sourceDigest, registry.sourceDigest);
  });
});
