/**
 * Real-app builds: the six named apps from the apps pack build and verify, the output is
 * deterministic, and the source map is path-independent. These RUN whenever the sibling
 * apps checkout exists; they are `ignore`d only when it is absent.
 */
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0";
import { describeApp, describeExec } from "@w6w/runtime";
import { type ModelProviderMeta, parseAppArtifactManifest, verifySha256 } from "@w6w/types";
import { buildApp, computeSourceDigest } from "../mod.ts";

const APPS = fromFileUrl(new URL("../../../../apps/apps/", import.meta.url));
const haveApps = (() => {
  try {
    return Deno.statSync(APPS).isDirectory;
  } catch {
    return false;
  }
})();

const SIX = ["apify", "gotify", "webex", "hubspot", "aws/s3", "salesforce"];

async function inTmp<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = await Deno.makeTempDir({ prefix: "w6w-build-test-" });
  try {
    return await fn(tmp);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

async function infoModules(file: string): Promise<{ dependencies?: unknown[] }[]> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", "--no-config", "--no-lock", file],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(out.code, 0);
  return JSON.parse(new TextDecoder().decode(out.stdout)).modules;
}

for (const name of SIX) {
  Deno.test({
    name: `real app ${name}: builds, verifies, describes identically to its source`,
    ignore: !haveApps,
    fn: () =>
      inTmp(async (tmp) => {
        const appDir = join(APPS, name);
        const r = await buildApp(appDir, join(tmp, "out"));
        const manifestText = await Deno.readTextFile(join(r.outDir, "manifest.json"));
        const parsed = parseAppArtifactManifest(JSON.parse(manifestText));
        assert(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
        const art = parsed.value;
        const js = await Deno.readFile(join(r.outDir, "app.js"));
        assert(await verifySha256(js, art.exec.sha256));
        assertEquals(art.exec.sha256, r.execSha256);
        assertEquals(art.exec.bytes, js.length);

        const mods = await infoModules(join(r.outDir, "app.js"));
        assertEquals(mods.length, 1);
        assertEquals((mods[0].dependencies ?? []).length, 0);

        const code = new TextDecoder().decode(js);
        const fromExec = await describeExec(code);
        const fromSource = await describeApp(join(appDir, "index.ts"), appDir);
        assertEquals(fromExec, fromSource);

        assertEquals(r.digestVersion, 2);
        assertEquals(r.sourceDigest, await computeSourceDigest(appDir));
        assertEquals(art.sourceDigest, r.sourceDigest);
        assert(!manifestText.includes("./assets/"), "an ./assets/ ref survived");
        assert(!("assetsRoot" in art.manifest));
        assert(!manifestText.includes("assetsRoot"));
      }),
  });
}

Deno.test({
  name: "determinism: apify twice is byte-identical; minify changes the exec sha",
  ignore: !haveApps,
  fn: () =>
    inTmp(async (tmp) => {
      const a = await buildApp(join(APPS, "apify"), join(tmp, "a"));
      const b = await buildApp(join(APPS, "apify"), join(tmp, "b"));
      for (const f of ["app.js", "manifest.json"]) {
        assertEquals(
          await Deno.readFile(join(a.outDir, f)),
          await Deno.readFile(join(b.outDir, f)),
        );
      }
      assertEquals(a.digest, b.digest);
      const plain = await buildApp(join(APPS, "gotify"), join(tmp, "p"), { minify: false });
      const min = await buildApp(join(APPS, "gotify"), join(tmp, "m"));
      assertNotEquals(plain.execSha256, min.execSha256);
      const text = await Deno.readTextFile(join(plain.outDir, "app.js"));
      assert(!text.includes(await Deno.realPath(join(APPS, "gotify"))), "realpath leaked");
      assertEquals(
        JSON.parse(await Deno.readTextFile(join(plain.outDir, "manifest.json")))
          .buildInfo.minify,
        false,
      );
    }),
});

Deno.test({
  name: "sourcemap: same exec sha, app-relative sources, identical at two out-root depths",
  ignore: !haveApps,
  fn: () =>
    inTmp(async (tmp) => {
      const appDir = join(APPS, "gotify");
      const without = await buildApp(appDir, join(tmp, "n"));
      const a = await buildApp(appDir, join(tmp, "a"), { sourcemap: true });
      const deepRoot = join(tmp, "x", "y", "z", "b");
      const b = await buildApp(appDir, deepRoot, { sourcemap: true });
      assertEquals(a.execSha256, without.execSha256);
      const mapA = await Deno.readFile(join(a.outDir, "app.js.map"));
      assertEquals(mapA, await Deno.readFile(join(b.outDir, "app.js.map")));
      const map = JSON.parse(new TextDecoder().decode(mapA));
      assert(map.sources.length > 0);
      for (const s of map.sources as string[]) {
        assert(!s.startsWith("/"), s);
        assert(!s.includes(tmp) && !s.includes(deepRoot), s);
      }
      assert(map.sources.includes("index.ts"));
      const art = JSON.parse(await Deno.readTextFile(join(a.outDir, "manifest.json")));
      assertEquals(art.buildInfo.sourcemap, true);
      assertEquals(art.map.bytes, mapA.length);
      const noMap = JSON.parse(await Deno.readTextFile(join(without.outDir, "manifest.json")));
      assertEquals(noMap.buildInfo.sourcemap, false);
      assertEquals("map" in noMap, false);
    }),
});

// --- modelProvider round-trip (generated app; no apps checkout needed) ---

const MODEL_PROVIDER = {
  modelTypes: ["llm", "image-generation"],
  modelFamilies: ["diffusion"],
} as const satisfies ModelProviderMeta;

async function writeDemoApp(dir: string, modelProvider?: unknown): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@w6w-fixtures/demo",
      version: "1.0.0",
      description: "fixture",
      license: "MIT",
      author: { name: "w6w" },
      categories: ["developer-tools"],
      w6w: {
        id: "io.test.demo",
        displayName: "Demo",
        appearance: { icon: { url: "https://cdn.example.invalid/i.png" } },
        entry: "./index.ts",
        ...(modelProvider === undefined ? {} : { modelProvider }),
      },
    }),
  );
  await Deno.writeTextFile(join(dir, "deno.json"), "{}");
  await Deno.writeTextFile(join(dir, "index.ts"), "export default { actions: [] };\n");
}

Deno.test("modelProvider: build manifest.json -> artifact parse keeps it deep-equal; absent stays absent", async () => {
  await inTmp(async (tmp) => {
    const withDir = join(tmp, "with");
    const withoutDir = join(tmp, "without");
    await writeDemoApp(withDir, MODEL_PROVIDER);
    await writeDemoApp(withoutDir);

    const a = await buildApp(withDir, join(tmp, "out-a"));
    const aText = await Deno.readTextFile(join(a.outDir, "manifest.json"));
    const aRaw = JSON.parse(aText);
    assertEquals(aRaw.manifest.modelProvider, MODEL_PROVIDER);
    const aParsed = parseAppArtifactManifest(aRaw);
    assert(aParsed.ok, aParsed.ok ? "" : aParsed.errors.join("; "));
    assertEquals(aParsed.value.manifest.modelProvider, MODEL_PROVIDER);

    const b = await buildApp(withoutDir, join(tmp, "out-b"));
    const bText = await Deno.readTextFile(join(b.outDir, "manifest.json"));
    const bRaw = JSON.parse(bText);
    assertEquals("modelProvider" in bRaw.manifest, false);
    assert(!bText.includes("modelProvider"), "absent key leaked as text");
    const bParsed = parseAppArtifactManifest(bRaw);
    assert(bParsed.ok, bParsed.ok ? "" : bParsed.errors.join("; "));
    assertEquals("modelProvider" in bParsed.value.manifest, false);

    // The manifest is inside the artifact digest: adding the field changes it.
    assertNotEquals(a.digest, b.digest);
  });
});

Deno.test("modelProvider: removing it restores the original build digest", async () => {
  await inTmp(async (tmp) => {
    const dir = join(tmp, "app");
    await writeDemoApp(dir);
    const before = await buildApp(dir, join(tmp, "o1"));
    await writeDemoApp(dir, MODEL_PROVIDER);
    const during = await buildApp(dir, join(tmp, "o2"));
    await writeDemoApp(dir);
    const after = await buildApp(dir, join(tmp, "o3"));
    assertNotEquals(during.digest, before.digest);
    assertEquals(after.digest, before.digest);
  });
});
