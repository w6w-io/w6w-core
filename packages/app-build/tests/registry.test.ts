/**
 * Registry mode (`resolution: "registry"`): the P3 specifier allowlist, the mapped-pair
 * module gate and app-kit's two entrypoints — every build runs against the local JSR
 * mirror (`tests/jsr-mirror.ts`) with a fresh `DENO_DIR`, so no test touches the network.
 *
 * The allowlist unit tests at the bottom need no mirror; they are the 4a/4b surface.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { dirname, join } from "jsr:@std/path@^1.0.0";
import { buildApp, BuildError, P3_SPECS } from "../mod.ts";
import {
  hasRealAppKit,
  type LocalMirror,
  type MirrorPackage,
  REAL_APP_KIT_DIR,
  startMirror,
} from "./jsr-mirror.ts";
import { moduleAllowed, readRegistryMap } from "../src/registry.ts";

const encoder = new TextEncoder();

/** The four P3 specifiers exactly as pinned — an app's whole `deno.json` `imports` block. */
const P3_DENO_JSON = JSON.stringify({ imports: { ...P3_SPECS } }, null, 2) + "\n";

/**
 * A registry-mode app: one value from `@w6w/types`, two types from `@w6w/runtime/author`.
 * `DIGEST_VERSION` is used at runtime so the bundle really pulls `@w6w/types` in.
 */
const INDEX = `import { DIGEST_VERSION } from "@w6w/types";
import type { ActionDefinition, AppDefinition } from "@w6w/runtime/author";

const ping: ActionDefinition = {
  key: "ping",
  type: "perform",
  title: "Ping",
  execute: () => ({ digestVersion: DIGEST_VERSION }),
};

const app: AppDefinition = { actions: [ping] };

export default app;
`;

/** The app-kit entrypoints, resolved as namespaces so either kit (real or synthetic) fits. */
const APP_KIT_INDEX = `import * as poll from "@w6w/app-kit/poll";
import * as webhook from "@w6w/app-kit/webhook";
import type { ActionDefinition, AppDefinition } from "@w6w/runtime/author";

const ping: ActionDefinition = {
  key: "ping",
  type: "perform",
  title: "Ping",
  execute: () => ({ poll: Object.keys(poll).length, webhook: Object.keys(webhook).length }),
};

const app: AppDefinition = { actions: [ping] };

export default app;
`;

/**
 * Requirement 4's app: it imports `pollSnapshot`, which only the REAL kit
 * (`apps/apps/_shared/poll`) exports — so a successful build proves the mirror
 * served those files, not the synthetic interface.
 */
const POLL_SNAPSHOT_INDEX = `import { pollSnapshot } from "@w6w/app-kit/poll";
import type { ActionDefinition, AppDefinition } from "@w6w/runtime/author";

const scan: ActionDefinition = {
  key: "scan",
  type: "read",
  title: "Scan",
  execute: () =>
    pollSnapshot({ state: undefined, rows: [{ key: "row-1", values: { title: "first" } }] }),
};

const app: AppDefinition = { actions: [scan] };

export default app;
`;

/** One synthetic extra version so a test can import a mirror module the app did not map. */
const APP_KIT_0_1_1: MirrorPackage = {
  name: "app-kit",
  version: "0.1.1",
  exports: { "./poll": "./poll.ts" },
  files: new Map([
    [
      "/poll.ts",
      encoder.encode(`export function pollTrigger(o: unknown): unknown {\n  return o;\n}\n`),
    ],
  ]),
};

function pkgJson(): string {
  return JSON.stringify({
    name: "@w6w-fixtures/registry-demo",
    version: "1.0.0",
    description: "fixture",
    license: "MIT",
    author: { name: "w6w" },
    categories: ["developer-tools"],
    w6w: {
      id: "io.test.registry-demo",
      displayName: "Registry Demo",
      appearance: { icon: { url: "https://cdn.example.invalid/i.png" } },
      entry: "./index.ts",
    },
  });
}

interface Ctx {
  mirror: LocalMirror;
  tmp: string;
  app: string;
  out: string;
}

/**
 * Start a mirror, generate the app in a temp dir, point `JSR_URL`/`DENO_DIR` at the test's
 * own dirs (a fresh cache per build, never the developer's), then clean both up.
 */
async function withApp(
  over: Record<string, string | null> = {},
  fn: (ctx: Ctx) => Promise<void>,
  mirrorOpts: { packages?: MirrorPackage[] } = {},
): Promise<void> {
  const mirror = await startMirror(mirrorOpts);
  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "w6w-registry-test-" }));
  const app = join(tmp, "app");
  const out = join(tmp, "out");
  const saved = { jsr: Deno.env.get("JSR_URL"), denoDir: Deno.env.get("DENO_DIR") };
  try {
    const files: Record<string, string | null> = {
      "package.json": pkgJson(),
      "deno.json": P3_DENO_JSON,
      "index.ts": INDEX,
      ...over,
    };
    for (const [rel, content] of Object.entries(files)) {
      if (content === null) continue;
      await Deno.mkdir(dirname(join(app, rel)), { recursive: true });
      await Deno.writeTextFile(join(app, rel), content);
    }
    Deno.env.set("JSR_URL", mirror.url);
    Deno.env.set("DENO_DIR", join(tmp, "deno-dir"));
    await fn({ mirror, tmp, app, out });
  } finally {
    for (const [key, value] of [["JSR_URL", saved.jsr], ["DENO_DIR", saved.denoDir]] as const) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await mirror.close();
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** `deno info` on the built bundle: it must be one module with no dependencies. */
async function infoModules(file: string): Promise<{ dependencies?: unknown[] }[]> {
  const r = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", "--no-config", "--no-lock", file],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
  return JSON.parse(new TextDecoder().decode(r.stdout)).modules;
}

async function refuse(over: Record<string, string | null>, mirrorOpts = {}): Promise<BuildError> {
  let captured: BuildError | undefined;
  await withApp(over, async ({ app, out }) => {
    const err = await assertRejects(
      () => buildApp(app, out, { resolution: "registry" }),
      BuildError,
    );
    assertEquals(await exists(out), false, "a refusal must leave nothing under outRoot");
    captured = err;
  }, mirrorOpts);
  return captured!;
}

Deno.test("3: registry mode builds a P3 app into one module with zero imports", async () => {
  await withApp({}, async ({ app, out }) => {
    const r = await buildApp(app, out, { resolution: "registry" });
    assertEquals(r.id, "io.test.registry-demo");
    assertEquals(r.version, "1.0.0");
    assertEquals(r.outDir, join(out, "io.test.registry-demo", "1.0.0"));
    const js = await Deno.readFile(join(r.outDir, "app.js"));
    const code = new TextDecoder().decode(js);

    // One module, nothing left to resolve — jsr: specifiers are gone from the output.
    const mods = await infoModules(join(r.outDir, "app.js"));
    assertEquals(mods.length, 1);
    assertEquals((mods[0].dependencies ?? []).length, 0);
    assert(!code.includes("jsr:"), "a jsr: specifier survived bundling");
    assert(!code.includes("http://127.0.0.1"), "a mirror URL survived bundling");

    // The registry content digest and the exec hash are the artifact's own.
    assertEquals(r.digestVersion, 2);
    assertEquals(r.execSha256.length, 64);
    assert(await exists(join(r.outDir, "manifest.json")));
  });
});

Deno.test("4c: jsr:@std/assert in registry mode is graph_jsr", async () => {
  const err = await refuse({
    "index.ts": `import { assertEquals } from "jsr:@std/assert@1.0.0";\n` +
      `export default { actions: [], assertEquals };\n`,
  });
  assertEquals(err.code, "graph_jsr", err.message);
});

Deno.test("4d: npm: import in registry mode is graph_npm", async () => {
  const err = await refuse({
    "index.ts": `import x from "npm:left-pad@1.3.0";\nexport default { actions: [], x };\n`,
  });
  assertEquals(err.code, "graph_npm", err.message);
});

Deno.test("4e: a mirror module for a version the app did not map is refused", async () => {
  // The mirror serves app-kit@0.1.1; the app's map names app-kit@0.1.0 only.
  const err = await refuse({
    "index.ts": `import { pollTrigger } from "jsr:@w6w/app-kit@0.1.1/poll";\n` +
      `export default { actions: [], poll: pollTrigger };\n`,
  }, { packages: [APP_KIT_0_1_1] });
  assertEquals(err.code, "graph_remote", err.message);
  // The URL in the message proves the module WAS fetched and refused by the pair gate,
  // not rejected because it failed to resolve.
  assert(
    err.message.includes("/@w6w/app-kit/0.1.1/poll.ts"),
    `message should name the served module: ${err.message}`,
  );
});

Deno.test("4f: app-kit /poll and /webhook both build", async () => {
  await withApp({ "index.ts": APP_KIT_INDEX }, async ({ app, out }) => {
    const r = await buildApp(app, out, { resolution: "registry" });
    const js = await Deno.readFile(join(r.outDir, "app.js"));
    assertEquals((await infoModules(join(r.outDir, "app.js"))).length, 1);
    const code = new TextDecoder().decode(js);
    // One exported name from each entrypoint, whichever kit the mirror staged.
    assert(
      code.includes("pollSnapshot") || code.includes("pollTrigger"),
      "poll's exports are missing from the bundle",
    );
    assert(
      code.includes("requireRawBody") || code.includes("webhookTrigger"),
      "webhook's exports are missing from the bundle",
    );
  });
});

/** Whether the real kit is there — the `../apps` sibling is absent in a lone core checkout. */
const realAppKit = await hasRealAppKit();
if (!realAppKit) {
  console.log(
    `4g SKIPPED: the real @w6w/app-kit is not at ${REAL_APP_KIT_DIR} (the ../apps sibling is missing)`,
  );
}

Deno.test({
  name: "4g: an app importing pollSnapshot from the real @w6w/app-kit/poll builds",
  ignore: !realAppKit,
  fn: async () => {
    await withApp({ "index.ts": POLL_SNAPSHOT_INDEX }, async ({ app, out, mirror }) => {
      const kit = mirror.packages.find((pkg) => pkg.name === "app-kit");
      assert(kit, "the mirror staged no @w6w/app-kit");
      // The P3 pin: the real kit's own deno.json version.
      assertEquals(kit.version, "0.1.0");

      const r = await buildApp(app, out, { resolution: "registry" });
      assertEquals((await infoModules(join(r.outDir, "app.js"))).length, 1);
      const code = new TextDecoder().decode(await Deno.readFile(join(r.outDir, "app.js")));
      // `pollSnapshot`'s own error message: the real kit's source, not the synthetic stub.
      assert(code.includes("pollSnapshot: "), "the real kit's poll source is not in the bundle");
    });
  },
});

Deno.test("mirror: unserved paths pass through to the upstream, 404 when offline", async () => {
  // A stand-in jsr.io, so the pass-through is proven without leaving the machine.
  const upstream = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (req: Request) => new Response(`upstream ${new URL(req.url).pathname}\n`),
  );
  const upstreamUrl = `http://127.0.0.1:${(upstream.addr as Deno.NetAddr).port}/`;
  try {
    const online = await startMirror({ offline: false, upstream: upstreamUrl });
    try {
      assertEquals(online.offline, false);
      const res = await fetch(`${online.url}@std/assert/1.0.0_meta.json`);
      assertEquals(res.status, 200);
      assertEquals(await res.text(), "upstream /@std/assert/1.0.0_meta.json\n");
    } finally {
      await online.close();
    }

    const offline = await startMirror({ offline: true });
    try {
      assertEquals(offline.offline, true);
      const res = await fetch(`${offline.url}@std/assert/1.0.0_meta.json`);
      assertEquals(res.status, 404);
      await res.text();
    } finally {
      await offline.close();
    }
  } finally {
    await upstream.shutdown();
  }
});

Deno.test("mirror: offline is the test default and JSR_MIRROR_OFFLINE=1 keeps it", async () => {
  const saved = Deno.env.get("JSR_MIRROR_OFFLINE");
  const offlineWith = async (value: string | undefined): Promise<boolean> => {
    if (value === undefined) Deno.env.delete("JSR_MIRROR_OFFLINE");
    else Deno.env.set("JSR_MIRROR_OFFLINE", value);
    const mirror = await startMirror();
    try {
      return mirror.offline;
    } finally {
      await mirror.close();
    }
  };
  try {
    assertEquals(await offlineWith(undefined), true, "tests must default to offline");
    assertEquals(await offlineWith("1"), true, "JSR_MIRROR_OFFLINE=1 must stay offline");
    assertEquals(await offlineWith("0"), false, "JSR_MIRROR_OFFLINE=0 opts into pass-through");
  } finally {
    if (saved === undefined) Deno.env.delete("JSR_MIRROR_OFFLINE");
    else Deno.env.set("JSR_MIRROR_OFFLINE", saved);
  }
});

// ---- allowlist unit tests: no mirror, no subprocess ----

async function withDeno(imports: Record<string, string>, fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/deno.json`, JSON.stringify({ imports }));
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function code(dir: string): Promise<string> {
  const e = await assertRejects(() => readRegistryMap(dir, dir), BuildError);
  return e.code;
}

Deno.test("4a: caret range is registry_spec_invalid", async () => {
  await withDeno({ "@w6w/types": "jsr:@w6w/types@^0.2.0" }, async (d) => {
    assertEquals(await code(d), "registry_spec_invalid");
  });
});

Deno.test("4b: unapproved key @w6w/runtime (host root) is registry_spec_invalid", async () => {
  await withDeno({ "@w6w/runtime": "jsr:@w6w/runtime@0.2.0" }, async (d) => {
    assertEquals(await code(d), "registry_spec_invalid");
  });
});

Deno.test("approved P3 map yields pairs and gates module URLs", async () => {
  await withDeno({
    "@w6w/types": "jsr:@w6w/types@0.2.0",
    "@w6w/runtime/author": "jsr:@w6w/runtime@0.2.0/author",
    "@w6w/app-kit/poll": "jsr:@w6w/app-kit@0.1.0/poll",
  }, async (d) => {
    const { pairs } = await readRegistryMap(d, d);
    assertEquals([...pairs].sort(), ["app-kit@0.1.0", "runtime@0.2.0", "types@0.2.0"]);
    const h = "http://127.0.0.1:1/";
    assertEquals(moduleAllowed(`${h}@w6w/types/0.2.0/mod.ts`, pairs, h), true);
    assertEquals(moduleAllowed(`${h}@w6w/types/0.3.0/mod.ts`, pairs, h), false);
    assertEquals(moduleAllowed(`${h}@w6w/server/0.2.0/mod.ts`, pairs, h), false);
  });
});
