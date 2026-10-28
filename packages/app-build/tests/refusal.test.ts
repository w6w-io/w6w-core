/**
 * Refusals, source digest and digest-equals-registry — every fixture is GENERATED in a temp
 * dir (no committed npm/remote-import fixtures). Each refusal asserts its own `code` and that
 * nothing exists under `outRoot` afterwards.
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { dirname, join } from "jsr:@std/path@^1.0.0";
import { hookSource, loadApp, loadedAppFromArtifact, runHook } from "@w6w/runtime";
import { digestDescriptionVersioned } from "@w6w/types";
import { buildApp, BuildError, computeSourceDigest } from "../mod.ts";

const INDEX = `export default { actions: [] };\n`;

function pkgJson(over: Record<string, unknown> = {}, w6w: Record<string, unknown> = {}) {
  return JSON.stringify({
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
      ...w6w,
    },
    ...over,
  });
}

/** Files of a valid minimal app; `over` entries replace/add (null deletes). Returns app + out dirs. */
async function fixture(
  over: Record<string, string | null> = {},
): Promise<{ tmp: string; app: string; out: string }> {
  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "w6w-refuse-" }));
  const app = join(tmp, "app");
  const files: Record<string, string | null> = {
    "package.json": pkgJson(),
    "deno.json": "{}",
    "index.ts": INDEX,
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

async function refuse(
  code: string,
  over: Record<string, string | null>,
  setup?: (f: { tmp: string; app: string }) => Promise<void>,
): Promise<void> {
  const f = await fixture(over);
  try {
    await setup?.(f);
    const err = await assertRejects(() => buildApp(f.app, f.out), BuildError);
    assertEquals(err.code, code, err.message);
    assertEquals(err.appDir, f.app);
    assertEquals(await exists(f.out), false, "refusal must leave nothing under outRoot");
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
}

Deno.test("a valid generated fixture builds (control for every refusal below)", async () => {
  const f = await fixture();
  try {
    const r = await buildApp(f.app, f.out);
    assertEquals(r.id, "io.test.demo");
    assert(await exists(join(r.outDir, "manifest.json")));
    assertEquals(r.outDir, join(f.out, "io.test.demo", "1.0.0"));
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});

Deno.test("refuse: import from ./tests/x.ts", () =>
  refuse("graph_tests", {
    "index.ts": `import { x } from "./tests/x.ts";\nexport default { actions: [], x };\n`,
    "tests/x.ts": "export const x = 1;\n",
  }));

Deno.test("refuse: npm: import", () =>
  refuse("graph_npm", {
    "index.ts": `import x from "npm:left-pad@1.3.0";\nexport default { actions: [], x };\n`,
  }));

Deno.test("refuse: https: import", () =>
  refuse("graph_remote", {
    "index.ts":
      `import x from "https://example.invalid/m.ts";\nexport default { actions: [], x };\n`,
  }));

Deno.test("refuse: jsr: import", () =>
  refuse("graph_jsr", {
    "index.ts": `import x from "jsr:@std/path@^1.0.0";\nexport default { actions: [], x };\n`,
  }));

Deno.test("refuse: module in a prefix-sharing sibling dir (../app-evil/m.ts)", () =>
  refuse("graph_outside_app", {
    "index.ts": `import { m } from "../app-evil/m.ts";\nexport default { actions: [], m };\n`,
    "../app-evil/m.ts": "export const m = 1;\n",
  }));

Deno.test("refuse: @w6w/types mapped to a dir without a @w6w/types deno.json", () =>
  refuse("types_root_invalid", {
    "deno.json": JSON.stringify({ imports: { "@w6w/types": "./fake/mod.ts" } }),
    "fake/mod.ts": "export {};\n",
    "fake/deno.json": JSON.stringify({ name: "@evil/types" }),
  }));

Deno.test("refuse: package.json dependencies", () =>
  refuse("npm_dependencies", {
    "package.json": pkgJson({ dependencies: { "left-pad": "1.3.0" } }),
  }));

Deno.test("refuse: a node_modules/ directory", () =>
  refuse("npm_dependencies", { "node_modules/x/index.js": "export {};\n" }));

Deno.test("refuse: missing w6w.id", () =>
  refuse("invalid_manifest", { "package.json": pkgJson({}, { id: undefined }) }));

Deno.test('refuse: id "../x"', () =>
  refuse("invalid_id", { "package.json": pkgJson({}, { id: "../x" }) }));

Deno.test("refuse: bad version", () =>
  refuse("invalid_version", { "package.json": pkgJson({ version: "1..0" }) }));

Deno.test("refuse: w6w.manifest set", () =>
  refuse("manifest_file_forbidden", { "package.json": pkgJson({}, { manifest: "./m.json" }) }));

Deno.test("refuse: entry ../x.ts", () =>
  refuse("entry_outside_app", {
    "package.json": pkgJson({}, { entry: "../x.ts" }),
    "../x.ts": INDEX,
  }));

Deno.test("refuse: entry missing", () =>
  refuse("entry_missing", { "package.json": pkgJson({}, { entry: "./nope.ts" }) }));

Deno.test("refuse: no deno.json", () => refuse("config_missing", { "deno.json": null }));

Deno.test("computeSourceDigest: tests/ is excluded; README.md and deno.lock are counted", async () => {
  const f = await fixture({
    "tests/a.test.ts": "export {};\n",
    "README.md": "# one\n",
    "deno.lock": "{}\n",
    "lib/util_test.ts": "export {};\n",
  });
  try {
    const base = await computeSourceDigest(f.app);
    await Deno.writeTextFile(join(f.app, "tests", "a.test.ts"), "export const changed = 1;\n");
    await Deno.writeTextFile(join(f.app, "lib", "util_test.ts"), "export const changed = 1;\n");
    await Deno.writeTextFile(join(f.app, "tests", "added.ts"), "export {};\n");
    assertEquals(await computeSourceDigest(f.app), base);
    await Deno.writeTextFile(join(f.app, "README.md"), "# two\n");
    const afterReadme = await computeSourceDigest(f.app);
    assertNotEquals(afterReadme, base);
    await Deno.writeTextFile(join(f.app, "deno.lock"), '{"v":1}\n');
    assertNotEquals(await computeSourceDigest(f.app), afterReadme);
    await Deno.symlink(join(f.app, "README.md"), join(f.app, "link.md"));
    const err = await assertRejects(() => computeSourceDigest(f.app), BuildError);
    assertEquals(err.code, "source_symlink");
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});

Deno.test("digest: a webhook-authored trigger with a poll hook digests as type poll", async () => {
  const index = `export default { actions: [], triggers: [{ key: "t", title: "T", type: "webhook",
    poll() { return { events: [], nextState: {} }; } }] };\n`;
  const f = await fixture({ "index.ts": index });
  try {
    const r = await buildApp(f.app, f.out);
    const art = JSON.parse(await Deno.readTextFile(join(r.outDir, "manifest.json")));
    assertEquals(art.triggers.length, 1);
    assertEquals(art.triggers[0].trigger.type, "webhook"); // the authored value is stored untouched
    assertEquals(art.triggers[0].hooks, ["poll"]);
    // Computed here, independently of the builder: the registry digests the HOST-derived type.
    const literal = (type: string) =>
      digestDescriptionVersioned({
        manifest: art.manifest,
        actions: art.actions,
        auth: [],
        triggers: [{ ...art.triggers[0].trigger, type }],
        health: [],
        interfaces: [],
        exec: r.execSha256,
      });
    const expected = await literal("poll");
    assertEquals(r.digest, expected.digest);
    assertEquals(r.digestVersion, 2);
    assertNotEquals(r.digest, (await literal("webhook")).digest);
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});

const FORM_PARAM = `{ key: "f", title: "F", type: "select", options: { source: "resolveFields" } }`;

Deno.test("refuse: fields_hook_invalid — a param opts in to resolveFields but the action has no function", () =>
  refuse("fields_hook_invalid", {
    "index.ts": `export default { actions: [{ key: "a", title: "A", params: [${FORM_PARAM}],
      execute() { return {}; } }] };\n`,
  }));

Deno.test("refuse: fields_hook_invalid — refreshOn names a param that is not in the form", () =>
  refuse("fields_hook_invalid", {
    "index.ts": `export default { actions: [{ key: "a", title: "A",
      params: [{ key: "f", title: "F", type: "select",
        options: { source: "resolveFields", refreshOn: ["missing"] } }],
      execute() { return {}; }, resolveFields() { return { fields: {} }; } }] };\n`,
  }));

Deno.test("fields_hook_invalid: a valid hook builds, the manifest action carries resolveFields: true", async () => {
  const f = await fixture({
    "index.ts": `export default { actions: [{ key: "a", title: "A", params: [${FORM_PARAM}],
      execute() { return {}; }, resolveFields() { return { fields: {} }; } }] };\n`,
  });
  try {
    const r = await buildApp(f.app, f.out);
    assertEquals("warnings" in r, false);
    const art = JSON.parse(await Deno.readTextFile(join(r.outDir, "manifest.json")));
    assertEquals(art.actions[0].resolveFields, true);
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});

Deno.test("fields_hook_invalid: a hook no param opts in to builds with a warning", async () => {
  const f = await fixture({
    "index.ts": `export default { actions: [{ key: "a", title: "A",
      execute() { return {}; }, resolveFields() { return { fields: {} }; } }] };\n`,
  });
  try {
    const r = await buildApp(f.app, f.out);
    assertEquals(r.warnings?.length, 1);
    assert(r.warnings![0].includes("actions[a]"), r.warnings![0]);
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});

Deno.test("shared includes: sibling apps build standalone code/assets, hash shared changes, and preserve identity", async () => {
  const f = await fixture({
    "package.json": pkgJson({}, {
      build: { include: ["../_shared"] },
      appearance: { icon: { svg: "../_shared/icon.svg" } },
    }),
    "index.ts": `import { answer } from "../_shared/value.ts";
export default { actions: [{ key: "answer", displayName: "Answer", execute() { return answer(); } }] };`,
    "../_shared/value.ts": "export function answer() { return 42; }",
    "../_shared/icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  try {
    const source = await loadApp(f.app);
    assertEquals(
      await runHook({
        ...hookSource(source),
        selector: { kind: "action", key: "answer" },
        input: {},
      }),
      42,
    );
    const first = await buildApp(f.app, f.out, { sourcemap: true });
    assertEquals(first.id, "io.test.demo");
    const art = JSON.parse(await Deno.readTextFile(join(first.outDir, "manifest.json")));
    assert(art.manifest.appearance.icon.svg.startsWith("data:image/svg+xml;base64,"));
    assertEquals(first.sourceDigest, await computeSourceDigest(f.app));
    const map = JSON.parse(await Deno.readTextFile(join(first.outDir, "app.js.map")));
    assert(map.sources.includes("../_shared/value.ts"), JSON.stringify(map.sources));
    assert(!JSON.stringify(map.sources).includes(f.tmp));
    await Deno.writeTextFile(
      join(f.tmp, "_shared/value.ts"),
      "export function answer() { return 43; }",
    );
    const second = await buildApp(f.app, join(f.tmp, "out2"));
    assertNotEquals(first.sourceDigest, second.sourceDigest);
    assertNotEquals(first.execSha256, second.execSha256);
    // Build a second consumer with a distinct identity from the same shared source.
    const sibling = join(f.tmp, "second");
    await Deno.mkdir(sibling);
    for (const name of ["index.ts", "deno.json", "package.json"]) {
      await Deno.copyFile(join(f.app, name), join(sibling, name));
    }
    await Deno.writeTextFile(
      join(sibling, "package.json"),
      pkgJson({}, {
        id: "io.test.second",
        build: { include: ["../_shared"] },
      }),
    );
    const third = await buildApp(sibling, f.out);
    assertEquals(third.id, "io.test.second");
    // No source tree is required to execute either emitted app.
    await Deno.remove(f.app, { recursive: true });
    await Deno.remove(sibling, { recursive: true });
    await Deno.remove(join(f.tmp, "_shared"), { recursive: true });
    for (const [result, expected] of [[first, 42], [second, 43], [third, 43]] as const) {
      const manifest = JSON.parse(await Deno.readTextFile(join(result.outDir, "manifest.json")));
      const code = await Deno.readTextFile(join(result.outDir, "app.js"));
      const loaded = await loadedAppFromArtifact(manifest, code);
      assertEquals(
        await runHook({
          ...hookSource(loaded),
          selector: { kind: "action", key: "answer" },
          input: {},
        }),
        expected,
      );
    }
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});

for (
  const include of ["..", "../../outside", "/tmp", "./", "../_shared/..", "https://example.com"]
) {
  Deno.test(`refuse shared directory escape: ${include}`, () =>
    refuse("shared_path_invalid", {
      "package.json": pkgJson({}, { build: { include: [include] } }),
    }));
}

Deno.test("refuse shared include that is not an array", () =>
  refuse("shared_path_invalid", {
    "package.json": pkgJson({}, { build: { include: "../_shared" } }),
  }));

Deno.test("refuse shared symlink root", () =>
  refuse("shared_path_invalid", {
    "package.json": pkgJson({}, { build: { include: ["../_shared"] } }),
    "../elsewhere/value.ts": "export const value = 1;",
  }, async (f) => {
    await Deno.symlink(join(f.tmp, "elsewhere"), join(f.tmp, "_shared"));
  }));

Deno.test("refuse shared symlink file", () =>
  refuse("source_symlink", {
    "package.json": pkgJson({}, { build: { include: ["../_shared"] } }),
    "../_shared/value.ts": "export const value = 1;",
  }, async (f) => {
    await Deno.symlink(join(f.tmp, "_shared/value.ts"), join(f.tmp, "_shared/alias.ts"));
  }));

Deno.test("refuse tests imported from a shared directory", () =>
  refuse("graph_tests", {
    "package.json": pkgJson({}, { build: { include: ["../_shared"] } }),
    "index.ts": 'import "../_shared/tests/value.ts"; export default { actions: [] };',
    "../_shared/tests/value.ts": "export const value = 1;",
  }));

Deno.test("refuse transitive import beyond an included directory", () =>
  refuse("graph_outside_app", {
    "package.json": pkgJson({}, { build: { include: ["../_shared"] } }),
    "index.ts": 'import "../_shared/value.ts"; export default { actions: [] };',
    "../_shared/value.ts": 'import "../other/value.ts";',
    "../other/value.ts": "export const value = 1;",
  }));

Deno.test("refuse asset outside included directory", () =>
  refuse("asset_path", {
    "package.json": pkgJson({}, {
      build: { include: ["../_shared"] },
      appearance: { icon: { svg: "../other/icon.svg" } },
    }),
    "../_shared/value.ts": "export const value = 1;",
    "../other/icon.svg": "<svg/>",
  }));
