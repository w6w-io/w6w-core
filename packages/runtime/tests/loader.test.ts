import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0";
import { describe, invoke, loadApp, LoadError, W6WError } from "../mod.ts";

const HELLO_DIR = fromFileUrl(new URL("../../../fixtures/apps/hello", import.meta.url));
const SENDGRID_DIR = fromFileUrl(new URL("../../../fixtures/apps/sendgrid", import.meta.url));
const NPM_VENDORED_DIR = fromFileUrl(
  new URL("../../../fixtures/apps/npm-vendored", import.meta.url),
);

/** A minimal, otherwise-valid `package.json` for a temp fixture app. */
function basePackageJson(extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "@w6w-fixtures/temp",
    version: "1.0.0",
    description: "Temp fixture app for loader.test.ts.",
    license: "MIT",
    author: { name: "w6w" },
    categories: ["developer-tools"],
    private: true,
    w6w: {
      id: "io.w6w.temp",
      displayName: "Temp",
      appearance: { icon: { svg: "./assets/icon.svg" } },
      entry: "./index.ts",
    },
    ...extra,
  };
}

interface TempAppOptions {
  /** Vendor a `node_modules/tiny` tree alongside `package.json`. */
  nodeModules?: boolean;
  /** Contents of `index.ts`, written only when provided. */
  indexBody?: string;
}

/** Write a temp app directory, run `fn` against it, then always clean up. */
async function withTempApp(
  pkg: Record<string, unknown>,
  opts: TempAppOptions,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    if (opts.indexBody !== undefined) {
      await Deno.writeTextFile(join(dir, "index.ts"), opts.indexBody);
    }
    if (opts.nodeModules) {
      await Deno.mkdir(join(dir, "node_modules", "tiny"), { recursive: true });
      await Deno.writeTextFile(
        join(dir, "node_modules", "tiny", "package.json"),
        JSON.stringify({ name: "tiny", version: "1.0.0", main: "index.js" }),
      );
      await Deno.writeTextFile(
        join(dir, "node_modules", "tiny", "index.js"),
        "module.exports = {};\n",
      );
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// L1 — the `node_modules/` arm.
Deno.test("loadApp refuses a vendored node_modules/ tree", async () => {
  await withTempApp(basePackageJson(), { nodeModules: true }, async (dir) => {
    const err = await assertRejects(() => loadApp(dir), LoadError);
    assertEquals(err.code, "npm_dependencies_forbidden");
    assertEquals(err.phase, "load");
  });
});

// L2a — the declared-deps arm, `dependencies`.
Deno.test("loadApp refuses a non-empty `dependencies` object", async () => {
  await withTempApp(
    basePackageJson({ dependencies: { tiny: "^1.0.0" } }),
    {},
    async (dir) => {
      const err = await assertRejects(() => loadApp(dir), LoadError);
      assertEquals(err.code, "npm_dependencies_forbidden");
      assertEquals(err.phase, "load");
    },
  );
});

// L2b — the declared-deps arm, `devDependencies`.
Deno.test("loadApp refuses a non-empty `devDependencies` object", async () => {
  await withTempApp(
    basePackageJson({ devDependencies: { tiny: "^1.0.0" } }),
    {},
    async (dir) => {
      const err = await assertRejects(() => loadApp(dir), LoadError);
      assertEquals(err.code, "npm_dependencies_forbidden");
      assertEquals(err.phase, "load");
    },
  );
});

// L2c — the declared-deps arm, `optionalDependencies`.
Deno.test("loadApp refuses a non-empty `optionalDependencies` object", async () => {
  await withTempApp(
    basePackageJson({ optionalDependencies: { tiny: "^1.0.0" } }),
    {},
    async (dir) => {
      const err = await assertRejects(() => loadApp(dir), LoadError);
      assertEquals(err.code, "npm_dependencies_forbidden");
      assertEquals(err.phase, "load");
    },
  );
});

// L3 — refusal precedes execution.
Deno.test("the refusal fires before the entry module is imported", async () => {
  await withTempApp(
    basePackageJson(),
    { nodeModules: true, indexBody: 'throw new Error("ENTRY MODULE EVALUATED");\n' },
    async (dir) => {
      const err = await assertRejects(() => loadApp(dir), LoadError);
      assertEquals(err.code, "npm_dependencies_forbidden");
      assert(
        !err.message.includes("ENTRY MODULE EVALUATED"),
        "the entry module must never have been evaluated",
      );
    },
  );
});

// L4 — clean apps still load (positive pair for L1-L3).
Deno.test("clean apps still load: hello", async () => {
  const app = await loadApp(HELLO_DIR);
  const desc = describe(app);
  assertEquals(desc.app.id, "io.w6w.hello");
});

Deno.test("clean apps still load: sendgrid", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const desc = describe(app);
  assertEquals(desc.app.id, "io.w6w.sendgrid");
});

// L5 — an empty dep object is not a refusal (D-P4).
Deno.test("an empty `dependencies` object is not a refusal", async () => {
  await withTempApp(
    basePackageJson({ dependencies: {} }),
    { indexBody: "export default { actions: [] };\n" },
    async (dir) => {
      const app = await loadApp(dir);
      const desc = describe(app);
      assertEquals(desc.app.id, "io.w6w.temp");
    },
  );
});

// L6 — cold remote import still denied (A5): F-1's corrected root cause.
Deno.test("cold remote npm: import is still denied under the sandbox's real permissions", async () => {
  const app = await loadApp(NPM_VENDORED_DIR);
  const err = await assertRejects(
    () =>
      invoke(app, {
        manifestVersion: "1",
        app: "io.w6w.npm-vendored",
        action: "remote-import",
      }),
    W6WError,
  );
  assertEquals(err.code, "hook_failed");
  assertEquals(err.phase, "execute");
});
