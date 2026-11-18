/**
 * `assembleApp` / `validateAssembled` — developer-built JS packaged without bundling. Every
 * fixture is generated in a temp dir: a `package.json` whose `w6w.entry` names `dist/app.js`, a
 * hand-written self-contained ESM bundle, and (per test) a source map. Each refusal asserts its
 * own `code` and that nothing exists under `outRoot` afterwards.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { dirname, join } from "jsr:@std/path@^1.0.0";
import { parseAppArtifactManifest } from "@w6w/types";
import { assembleApp, BuildError, validateAssembled } from "../assemble.ts";
import { moduleImports } from "../src/self-contained.ts";

const APP_JS = [
  "var ping = {",
  '  key: "ping", title: "Ping", description: "Ping the service.",',
  "  params: [],",
  '  output: [{ key: "ok", type: "boolean" }],',
  "  sample: { ok: true },",
  "  async execute() { return { ok: true }; }",
  "};",
  "var app = { actions: [ping] };",
  "export { app as default };",
  "",
].join("\n");

const MAP = JSON.stringify({
  version: 3,
  sources: ["../src/index.ts"],
  names: [],
  mappings: "AAAA",
});

function pkgJson(w6w: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "@w6w-fixtures/assembled",
    version: "1.0.0",
    description: "fixture",
    license: "MIT",
    author: { name: "w6w" },
    categories: ["developer-tools"],
    // A developer's tree legitimately lists its bundler; assembleApp does not refuse it.
    devDependencies: { esbuild: "0.28.2", typescript: "5.9.3" },
    w6w: {
      id: "io.test.assembled",
      displayName: "Assembled",
      appearance: { icon: { url: "https://cdn.example.invalid/i.png" } },
      entry: "./dist/app.js",
      ...w6w,
    },
    ...over,
  });
}

async function fixture(
  over: Record<string, string | null> = {},
): Promise<{ tmp: string; app: string; out: string }> {
  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "w6w-assemble-" }));
  const app = join(tmp, "app");
  const files: Record<string, string | null> = {
    "package.json": pkgJson(),
    "src/index.ts": "// the developer's source; never read\n",
    "dist/app.js": APP_JS,
    ...over,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    await Deno.mkdir(dirname(join(app, rel)), { recursive: true });
    await Deno.writeTextFile(join(app, rel), content);
  }
  return { tmp, app, out: join(tmp, "out") };
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(outDir: string) {
  const parsed = parseAppArtifactManifest(
    JSON.parse(await Deno.readTextFile(join(outDir, "manifest.json"))),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
}

async function refuse(code: string, files: Record<string, string | null>) {
  const { tmp, app, out } = await fixture(files);
  try {
    const err = await assertRejects(() => assembleApp(app, out), BuildError);
    assertEquals(err.code, code, err.message);
    assert(!(await exists(out)), "nothing may be written on refusal");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

Deno.test("assembleApp: success, no source map", async () => {
  const { tmp, app, out } = await fixture();
  try {
    const r = await assembleApp(app, out);
    assertEquals([r.id, r.version], ["io.test.assembled", "1.0.0"]);
    assertEquals(r.outDir, join(out, "io.test.assembled", "1.0.0"));
    assertEquals(await Deno.readTextFile(join(r.outDir, "app.js")), APP_JS); // byte-for-byte
    assert(!(await exists(join(r.outDir, "app.js.map"))));
    const m = await readManifest(r.outDir);
    assertEquals(m.actions.map((a) => a.key), ["ping"]);
    assertEquals(m.map, undefined);
    assertEquals(m.buildInfo.minify, false);
    assertEquals(m.buildInfo.sourcemap, false);
    assertEquals(m.buildInfo.denoVersion, Deno.version.deno); // running under Deno here
    assertEquals(m.exec.sha256, r.execSha256);
    assertEquals(m.sourceDigest, r.sourceDigest);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("assembleApp: map via trailing sourceMappingURL — comment stripped, sources app-relative", async () => {
  const { tmp, app, out } = await fixture({
    "dist/app.js": APP_JS + "//# sourceMappingURL=app.js.map\n",
    "dist/app.js.map": MAP,
  });
  try {
    const r = await assembleApp(app, out);
    assertEquals(await Deno.readTextFile(join(r.outDir, "app.js")), APP_JS);
    const map = JSON.parse(await Deno.readTextFile(join(r.outDir, "app.js.map")));
    assertEquals(map.sources, ["src/index.ts"]);
    const m = await readManifest(r.outDir);
    assertEquals(m.buildInfo.sourcemap, true);
    assert(m.map !== undefined && m.map.bytes > 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("assembleApp: a <entry>.map the JS does not name is stale, not packaged", async () => {
  const { tmp, app, out } = await fixture({ "dist/app.js.map": MAP });
  try {
    const r = await assembleApp(app, out);
    assertEquals(await Deno.readTextFile(join(r.outDir, "app.js")), APP_JS);
    assertEquals((await readManifest(r.outDir)).buildInfo.sourcemap, false);
    assert(!(await exists(join(r.outDir, "app.js.map"))));
    assertEquals((await readManifest(r.outDir)).map, undefined);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("assembleApp: comment naming a missing map is removed with a warning", async () => {
  const { tmp, app, out } = await fixture({
    "dist/app.js": APP_JS + "//# sourceMappingURL=gone.js.map\n",
  });
  try {
    const r = await assembleApp(app, out);
    assertEquals(await Deno.readTextFile(join(r.outDir, "app.js")), APP_JS);
    assertEquals((await readManifest(r.outDir)).buildInfo.sourcemap, false);
    assert((r.warnings ?? []).some((w) => w.includes("gone.js.map")), JSON.stringify(r.warnings));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("assembleApp: an inline data: map stays in the JS", async () => {
  const inline = APP_JS + "//# sourceMappingURL=data:application/json;base64," +
    btoa(MAP) + "\n";
  const { tmp, app, out } = await fixture({ "dist/app.js": inline });
  try {
    const r = await assembleApp(app, out);
    assertEquals(await Deno.readTextFile(join(r.outDir, "app.js")), inline);
    assertEquals((await readManifest(r.outDir)).buildInfo.sourcemap, false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("assembleApp: node_modules (with a .bin symlink) and dist/ do not trip the build", async () => {
  const { tmp, app, out } = await fixture({ "node_modules/esbuild/package.json": "{}" });
  try {
    await Deno.mkdir(join(app, "node_modules/.bin"));
    await Deno.symlink("../esbuild/package.json", join(app, "node_modules/.bin/esbuild"));
    const r1 = await assembleApp(app, out);
    // node_modules is outside the source digest: changing it changes nothing.
    await Deno.writeTextFile(join(app, "node_modules/esbuild/package.json"), "{ }");
    const r2 = await assembleApp(app, join(tmp, "out2"));
    assertEquals(r1.sourceDigest, r2.sourceDigest);
    assertEquals(r1.digest, r2.digest);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("refuse: .ts entry → entry_not_js", () =>
  refuse("entry_not_js", { "package.json": pkgJson({ entry: "./src/index.ts" }) }));

Deno.test("refuse: no entry declared falls back to ./index.ts → entry_not_js", () =>
  refuse("entry_not_js", { "package.json": pkgJson({ entry: undefined }) }));

Deno.test("refuse: entry not built yet → entry_missing", () =>
  refuse("entry_missing", { "dist/app.js": null }));

Deno.test("refuse: entry outside the app → entry_outside_app", () =>
  refuse("entry_outside_app", { "package.json": pkgJson({ entry: "../x.js" }) }));

Deno.test("refuse: static import → bundle_not_self_contained", () =>
  refuse("bundle_not_self_contained", {
    "dist/app.js": `import { z } from "zod";\n${APP_JS}`,
  }));

Deno.test("refuse: dynamic import → bundle_not_self_contained", () =>
  refuse("bundle_not_self_contained", {
    "dist/app.js": APP_JS + `export const lazy = () => import("./chunk.js");\n`,
  }));

Deno.test("refuse: export … from → bundle_not_self_contained", () =>
  refuse("bundle_not_self_contained", {
    "dist/app.js": APP_JS + `export * from "./more.js";\n`,
  }));

Deno.test("refuse: map is not JSON → sourcemap_invalid", () =>
  refuse("sourcemap_invalid", {
    "dist/app.js": APP_JS + "//# sourceMappingURL=app.js.map\n",
    "dist/app.js.map": "{not json",
  }));

Deno.test("refuse: map sources not strings → sourcemap_invalid", () =>
  refuse("sourcemap_invalid", {
    "dist/app.js": APP_JS + "//# sourceMappingURL=app.js.map\n",
    "dist/app.js.map": JSON.stringify({ version: 3, sources: [1], mappings: "" }),
  }));

Deno.test("refuse: entry that does not default-export an app → describe_failed", () =>
  refuse("describe_failed", { "dist/app.js": "export const x = 1;\n" }));

Deno.test("validateAssembled: ok, and a refusal as errors (nothing left behind)", async () => {
  const { tmp, app } = await fixture();
  try {
    assertEquals(await validateAssembled(app), {
      ok: true,
      id: "io.test.assembled",
      version: "1.0.0",
    });
    await Deno.writeTextFile(join(app, "package.json"), pkgJson({ entry: "./src/index.ts" }));
    const bad = await validateAssembled(app);
    assertEquals(bad.ok, false);
    if (!bad.ok) assertEquals(bad.errors.map((e) => e.code), ["entry_not_js"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("moduleImports: import forms found; strings, comments, regexes, import.meta ignored", () => {
  assertEquals(moduleImports(`import a from "a";`), ["static import"]);
  assertEquals(moduleImports(`import "side";`), ["static import"]);
  assertEquals(moduleImports(`import*as n from"n";`), ["static import"]);
  assertEquals(moduleImports(`x = await import(y);`), ["dynamic import()"]);
  assertEquals(moduleImports(`export{a as b}from"m";`), ["export … from"]);
  assertEquals(moduleImports(`export * as ns from 'm';`), ["export … from"]);
  for (
    const clean of [
      `const s = "import x from 'y'";`,
      'const t = `import(${a}) ${`nested import("z")`}`;',
      `// import x from "y"\n/* import("z") */ var a = 1;`,
      `const re = /import\\("x"\\)/g; const u = import.meta.url;`,
      `const o = { import: 1, from: "x" }; o.import(); a?.import();`,
      `const d = a / b / c; export { d as default };`,
    ]
  ) {
    assertEquals(moduleImports(clean), [], clean);
  }
});
