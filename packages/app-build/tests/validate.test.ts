/**
 * `validateApp` / `--validate`: build the app into a throwaway out root, read the built
 * `manifest.json` back off disk, and run the artifact parser the server publishes with
 * (`parseAppArtifactManifest`, @w6w/types) over that file.
 *
 * Every assertion below is about real disk state: the returned result, the parse input, and
 * the absence of the temp out root afterwards. `invalid_manifest` needs the injectable
 * `parse` seam: `buildApp` runs the same parser on what it writes, so no authored fixture can
 * make the default parser reject a manifest the builder accepted.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { dirname, join } from "jsr:@std/path@^1.0.0";
import { validateApp } from "../mod.ts";

const INDEX = `export default { actions: [] };\n`;
const HEX64 = /^[0-9a-f]{64}$/;

/** The temp out roots `validateApp` creates; none may survive a run, pass or refusal. */
const OUT_ROOT_PREFIX = "w6w-app-validate-";

function pkgJson(): string {
  return JSON.stringify({
    name: "@w6w-fixtures/validate-demo",
    version: "1.0.0",
    description: "fixture",
    license: "MIT",
    author: { name: "w6w" },
    categories: ["developer-tools"],
    w6w: {
      id: "io.test.validate-demo",
      displayName: "Validate Demo",
      appearance: { icon: { url: "https://cdn.example.invalid/i.png" } },
      entry: "./index.ts",
    },
  });
}

/** A generated app fixture (`tmp/app`); `over` replaces/adds files, `null` deletes one. */
async function fixture(
  over: Record<string, string | null> = {},
): Promise<{ tmp: string; app: string }> {
  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "w6w-validate-fixture-" }));
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

/** Every leftover validate out root, so a run that forgot to clean up is visible. */
async function outRoots(): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(tmpDir())) {
      if (e.name.startsWith(OUT_ROOT_PREFIX)) names.push(e.name);
    }
  } catch { /* no temp dir to list: nothing can be left behind there */ }
  return names.sort();
}

/** Sorted names directly under `dir` — the app's own tree, to prove validate never writes there. */
function listing(dir: string): string[] {
  return [...Deno.readDirSync(dir)].map((e) => e.name).sort();
}

/** Run `fn` on a fresh fixture and assert the temp out root is gone and the app untouched. */
async function withFixture(
  over: Record<string, string | null>,
  fn: (f: { tmp: string; app: string }) => Promise<void>,
): Promise<void> {
  const f = await fixture(over);
  try {
    const appBefore = listing(f.app);
    const before = await outRoots();
    await fn(f);
    assertEquals(await outRoots(), before, "validateApp left its temp out root behind");
    assertEquals(listing(f.app), appBefore, "validateApp wrote into the app directory");
    assertEquals(await exists(join(f.tmp, "out")), false);
  } finally {
    await Deno.remove(f.tmp, { recursive: true }).catch(() => {});
  }
}

Deno.test("6: a valid app validates — {ok:true,id,version}, no output left", async () => {
  await withFixture({}, async ({ app }) => {
    assertEquals(await validateApp(app), {
      ok: true,
      id: "io.test.validate-demo",
      version: "1.0.0",
    });
  });
});

Deno.test("6: a build refusal passes its BuildError code through", async () => {
  await withFixture({
    "index.ts": `import x from "npm:left-pad@1.3.0";\nexport default { actions: [], x };\n`,
  }, async ({ app }) => {
    const r = await validateApp(app);
    assertEquals(r.ok, false);
    if (r.ok) return;
    assertEquals(r.errors.length, 1);
    assertEquals(r.errors[0].code, "graph_npm");
    assert(r.errors[0].message.length > 0, "a refusal carries a message");
  });
});

Deno.test("6: a missing app dir is app_dir_invalid, not a throw", async () => {
  await withFixture({}, async ({ tmp }) => {
    const r = await validateApp(join(tmp, "nope"));
    assertEquals(r.ok, false);
    if (r.ok) return;
    assertEquals(r.errors[0].code, "app_dir_invalid");
  });
});

Deno.test("6: a manifest the parser rejects is invalid_manifest", async () => {
  await withFixture({}, async ({ app }) => {
    // The parse runs over the manifest read back from disk: capture what it was handed.
    let seen: unknown;
    const r = await validateApp(app, {
      parse: (value) => {
        seen = value;
        return { ok: false, errors: ["actions[0].key: must be a non-empty string"] };
      },
    });
    assertEquals(r, {
      ok: false,
      errors: [{ code: "invalid_manifest", message: "actions[0].key: must be a non-empty string" }],
    });

    // That input can only be the built file: the artifact envelope, this app's identity, a
    // real exec blob and source digest. Skipping the read-and-parse would return ok:true.
    const m = seen as Record<string, unknown>;
    assertEquals(m.artifactVersion, 1);
    assertEquals(m.id, "io.test.validate-demo");
    assertEquals(m.version, "1.0.0");
    assert(Array.isArray(m.actions), "manifest.actions is an array");
    const exec = m.exec as { sha256: string; bytes: number; format: string };
    assert(HEX64.test(exec.sha256), `exec.sha256 is a sha-256: ${exec.sha256}`);
    assertEquals(exec.format, "esm");
    assert(HEX64.test(m.sourceDigest as string), "sourceDigest is a sha-256");
  });
});

Deno.test("6: the default parser is the types parser — a real build parses clean", async () => {
  // No seam: the default parse of the built manifest must accept it (this is the same parser
  // the tests above inject over, so a passing ok:true proves the default is wired).
  await withFixture({}, async ({ app }) => {
    const r = await validateApp(app, { minify: false });
    assertEquals(r.ok, true);
  });
});
