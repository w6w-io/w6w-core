/**
 * CLI subprocess tests. The flagless runs prove the self re-exec (without it Deno exits
 * on the unstable Worker-options error). The pack test builds two real apps and one
 * generated app that imports from `tests/` — it must fail while the others still build.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0";

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
