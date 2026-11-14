/**
 * CLI subprocess tests. The flagless runs prove the self re-exec (without it Deno exits
 * on the unstable Worker-options error). The pack test builds two real apps and one
 * generated app that imports from `tests/` — it must fail while the others still build.
 * The `--validate` cases assert the pinned surface: exactly the `validateApp` result as one
 * JSON line, exit 0/1, and no output left behind.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1.0.0";

const CLI = fromFileUrl(new URL("../cli.ts", import.meta.url));
const TYPES = fromFileUrl(new URL("../../types/mod.ts", import.meta.url));
const APPS = fromFileUrl(new URL("../../../../apps/apps/", import.meta.url));
const haveApps = (() => {
  try {
    return Deno.statSync(APPS).isDirectory;
  } catch {
    return false;
  }
})();

async function cli(args: string[]) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", CLI, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const td = new TextDecoder();
  return { code: out.code, stdout: td.decode(out.stdout), stderr: td.decode(out.stderr) };
}

Deno.test("cli: --help exits 0 with usage on stdout (no unstable flag)", async () => {
  const r = await cli(["--help"]);
  assertEquals(r.code, 0);
  assertStringIncludes(r.stdout, "usage:");
});

for (
  const args of [
    [],
    ["x", "--pack", "y"],
    ["--concurrency", "0", "--pack", "y"],
    ["--concurrency", "x", "--pack", "y"],
    ["--concurrency", "4", "x"],
    ["--bogus", "x"],
    ["x", "-o"],
    ["x", "y"],
    ["x", "--resolution", "bogus"],
    ["x", "--resolution", "latest"],
    ["x", "--resolution"],
    ["--validate", "x", "-o", "out"],
    ["--validate", "--pack", "p.json"],
  ]
) {
  Deno.test(`cli: usage error [${args.join(" ")}] exits 2`, async () => {
    const r = await cli(args);
    assertEquals(r.code, 2);
    assertStringIncludes(r.stderr, "usage:");
  });
}

Deno.test({
  name: "cli: pack with a tests/-importing app exits 1 and still builds the others",
  ignore: !haveApps,
  fn: async () => {
    const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "w6w-cli-test-" }));
    try {
      const bad = join(tmp, "bad");
      await Deno.mkdir(join(bad, "tests"), { recursive: true });
      await Deno.writeTextFile(
        join(bad, "package.json"),
        JSON.stringify({
          name: "@w6w-fixtures/bad",
          version: "1.0.0",
          description: "fixture",
          license: "MIT",
          author: { name: "w6w" },
          categories: ["developer-tools"],
          w6w: {
            id: "io.test.bad",
            displayName: "Bad",
            appearance: { icon: { url: "https://cdn.example.invalid/i.png" } },
            entry: "./index.ts",
          },
        }),
      );
      await Deno.writeTextFile(
        join(bad, "deno.json"),
        JSON.stringify({ imports: { "@w6w/types": TYPES } }),
      );
      await Deno.writeTextFile(join(bad, "tests", "helper.ts"), "export const x = 1;\n");
      await Deno.writeTextFile(
        join(bad, "index.ts"),
        `import { x } from "./tests/helper.ts";\nexport default { actions: [], x };\n`,
      );
      const pack = join(tmp, "w6w-pack.json");
      await Deno.writeTextFile(
        pack,
        JSON.stringify({
          manifestVersion: "1",
          kind: "pack",
          name: "t",
          apps: [{ path: join(APPS, "gotify") }, { path: bad }, { path: join(APPS, "apify") }],
        }),
      );
      const out = join(tmp, "out");
      const r = await cli(["--pack", pack, "-o", out, "--concurrency", "2"]);
      assertEquals(r.code, 1);
      assertStringIncludes(r.stderr, `${bad}: graph_tests:`);
      const index = JSON.parse(await Deno.readTextFile(join(out, "index.json")));
      assertEquals(index.apps.length, 2);
      assertEquals(index.failures.length, 1);
      assertEquals(index.failures[0].code, "graph_tests");
      assertEquals(index.failures[0].path, bad);
      assert(!JSON.stringify(index).includes(out));
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

/** A generated app fixture (`tmp/app`); `over` replaces/adds files, `null` deletes one. */
async function fixture(
  over: Record<string, string | null> = {},
): Promise<{ tmp: string; app: string }> {
  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "w6w-cli-fixture-" }));
  const app = join(tmp, "app");
  const files: Record<string, string | null> = {
    "package.json": JSON.stringify({
      name: "@w6w-fixtures/cli-demo",
      version: "1.0.0",
      description: "fixture",
      license: "MIT",
      author: { name: "w6w" },
      categories: ["developer-tools"],
      w6w: {
        id: "io.test.cli-demo",
        displayName: "Cli Demo",
        appearance: { icon: { url: "https://cdn.example.invalid/i.png" } },
        entry: "./index.ts",
      },
    }),
    "deno.json": "{}\n",
    "index.ts": "export default { actions: [] };\n",
    ...over,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    await Deno.mkdir(dirname(join(app, rel)), { recursive: true });
    await Deno.writeTextFile(join(app, rel), content);
  }
  return { tmp, app };
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** The platform temp dir `Deno.makeTempDir` picks by default. */
function tmpDir(): string {
  return Deno.env.get("TMPDIR") ?? Deno.env.get("TMP") ?? Deno.env.get("TEMP") ?? "/tmp";
}

/** Throwaway out roots `validateApp` creates in the platform temp dir. */
async function validateOutRoots(): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(tmpDir())) {
    if (e.name.startsWith("w6w-app-validate-")) names.push(e.name);
  }
  return names.sort();
}

/** The one JSON line `--validate` prints; asserts there is exactly one line and nothing else. */
function jsonLine(stdout: string): unknown {
  const lines = stdout.replace(/\n$/, "").split("\n");
  assertEquals(lines.length, 1, `expected one stdout line, got: ${JSON.stringify(stdout)}`);
  return JSON.parse(lines[0]);
}

Deno.test("cli: --validate on a valid app prints one ok JSON line, exits 0, leaves nothing", async () => {
  const { tmp, app } = await fixture();
  try {
    const before = await validateOutRoots();
    const r = await cli(["--validate", app]);
    assertEquals(r.code, 0);
    assertEquals(jsonLine(r.stdout), {
      ok: true,
      id: "io.test.cli-demo",
      version: "1.0.0",
    });
    // Nothing left behind: no `out/` next to the app, no throwaway out root in the temp dir.
    const names: string[] = [];
    for await (const e of Deno.readDir(tmp)) names.push(e.name);
    assertEquals(names, ["app"]);
    assert(!(await exists(join(app, "out"))));
    assertEquals(await validateOutRoots(), before);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("cli: --validate on a broken graph prints its BuildError code, exits 1", async () => {
  const { tmp, app } = await fixture({
    "index.ts": `import "npm:left-pad@1.3.0";\nexport default { actions: [] };\n`,
  });
  try {
    const before = await validateOutRoots();
    const r = await cli(["--validate", app]);
    assertEquals(r.code, 1);
    const result = jsonLine(r.stdout) as { ok: boolean; errors: { code: string }[] };
    assertEquals(result.ok, false);
    assertEquals(result.errors.map((e) => e.code), ["graph_npm"]);
    assertEquals(await validateOutRoots(), before);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("cli: --resolution sibling builds the fixture app (default mode, explicit)", async () => {
  const { tmp, app } = await fixture();
  try {
    const r = await cli([app, "-o", join(tmp, "out"), "--resolution", "sibling"]);
    assertEquals(r.code, 0);
    const index = JSON.parse(await Deno.readTextFile(join(tmp, "out", "index.json")));
    assertEquals(index.apps.length, 1);
    assertEquals(index.apps[0].id, "io.test.cli-demo");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("cli: --resolution registry refuses a non-exact specifier, exits 1", async () => {
  const { tmp, app } = await fixture({
    "deno.json": JSON.stringify({ imports: { "@w6w/types": "jsr:@w6w/types@^0.2.0" } }),
  });
  try {
    const out = join(tmp, "out");
    const r = await cli([app, "-o", out, "--resolution", "registry"]);
    assertEquals(r.code, 1);
    assertStringIncludes(r.stderr, `registry_spec_invalid`);
    const index = JSON.parse(await Deno.readTextFile(join(out, "index.json")));
    assertEquals(index.failures.map((f: { code: string }) => f.code), ["registry_spec_invalid"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
