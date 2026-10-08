/**
 * Refusals, source digest and digest-equals-registry — every fixture is GENERATED in a temp
 * dir (no committed npm/remote-import fixtures). Each refusal asserts its own `code` and that
 * nothing exists under `outRoot` afterwards.
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { dirname, join } from "jsr:@std/path@^1.0.0";
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
