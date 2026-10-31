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

// L7 — the nested node_modules/ bypass is closed (round 2, A7). Mirrors the
// evaluator's own repro shape: a clean root package.json, no declared deps,
// and node_modules/ vendored two levels deep under actions/.
Deno.test("loadApp refuses a node_modules/ tree nested under a subdirectory", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify(basePackageJson(), null, 2));
    await Deno.mkdir(join(dir, "actions", "node_modules", "nanoid"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "actions", "node_modules", "nanoid", "package.json"),
      JSON.stringify({ name: "nanoid", version: "5.0.9", main: "index.js" }),
    );
    await Deno.writeTextFile(
      join(dir, "actions", "node_modules", "nanoid", "index.js"),
      "module.exports = {};\n",
    );

    const err = await assertRejects(() => loadApp(dir), LoadError);
    assertEquals(err.code, "npm_dependencies_forbidden");
    assertEquals(err.phase, "load");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// L8 — the walk terminates on a symlink cycle (round 2, A8). A symlink under
// `foo/` points back at an ancestor directory; the walk must never follow it,
// so loadApp must return well inside a generous 5s bound instead of hanging.
Deno.test("loadApp's node_modules walk does not hang on a symlink cycle", async () => {
  const dir = await Deno.makeTempDir();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify(basePackageJson(), null, 2));
    await Deno.writeTextFile(join(dir, "index.ts"), "export default { actions: [] };\n");
    await Deno.mkdir(join(dir, "foo"));
    await Deno.symlink(dir, join(dir, "foo", "link"), { type: "dir" });

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("loadApp did not return within 5s — symlink cycle hang")),
        5000,
      );
    });
    const app = await Promise.race([loadApp(dir), timeout]);
    const desc = describe(app);
    assertEquals(desc.app.id, "io.w6w.temp");
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadApp carries w6w.modelProvider through to the manifest; absent stays absent", async () => {
  const mp = {
    modelTypes: ["llm", "image-generation"] as ("llm" | "image-generation")[],
    modelFamilies: ["diffusion"] as "diffusion"[],
  };
  const pkg = basePackageJson();
  (pkg.w6w as Record<string, unknown>).modelProvider = mp;
  await withTempApp(pkg, { indexBody: "export default { actions: [] };\n" }, async (dir) => {
    const app = await loadApp(dir);
    assertEquals(app.manifest.modelProvider, mp);
  });
  await withTempApp(
    basePackageJson(),
    { indexBody: "export default { actions: [] };\n" },
    async (dir) => {
      const app = await loadApp(dir);
      assert(!("modelProvider" in app.manifest));
    },
  );
});

// ---- trigger protocol declaration (rfcs/trigger-protocol.md) ----

const PROTOCOL_FIXTURE = fromFileUrl(
  new URL("../../../fixtures/apps/trigger-protocol", import.meta.url),
);

type ProtocolPkg = {
  w6w: { protocol?: Record<string, unknown>; network: { allow: string[] } };
};

async function withProtocolApp(
  edit: (pkg: ProtocolPkg) => void,
  index: string | undefined,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const pkg = JSON.parse(await Deno.readTextFile(join(PROTOCOL_FIXTURE, "package.json")));
    edit(pkg);
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify(pkg));
    await Deno.writeTextFile(
      join(dir, "index.ts"),
      index ?? await Deno.readTextFile(join(PROTOCOL_FIXTURE, "index.ts")),
    );
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function assertProtocolRefused(
  edit: (pkg: ProtocolPkg) => void,
  index?: string,
): Promise<string> {
  let message = "";
  await withProtocolApp(edit, index, async (dir) => {
    const err = await assertRejects(() => loadApp(dir), LoadError);
    assertEquals((err as LoadError).code, "invalid_trigger");
    message = (err as LoadError).message;
  });
  return message;
}

Deno.test("trigger-protocol fixture loads: type protocol, delivery kept, block carried", async () => {
  const app = await loadApp(PROTOCOL_FIXTURE);
  assertEquals(app.manifest.id, "io.w6w.trigger-protocol");
  assertEquals(app.manifest.protocol, {
    baseUrl: "https://partner.example.test/api",
    jwksUrl: "https://partner.example.test/.well-known/w6w-jwks.json",
    versions: [1],
  });
  const t = app.triggers.get("order-placed")!.trigger;
  assertEquals(t.type, "protocol");
  assertEquals(t.delivery, "w6w-protocol");
  assertEquals(t.protocol, { events: ["order.placed"], filters: { versions: [1] } });
  assertEquals(app.triggers.get("guest-event")!.trigger.protocol!.events.length, 2);
  // describe() (what an artifact is built from) keeps both
  const d = describe(app).triggers.find((x) => x.key === "guest-event")!;
  assertEquals(d.delivery, "w6w-protocol");
  assertEquals(d.type, "protocol");
});

Deno.test("an app without the protocol block keeps manifest.protocol absent", async () => {
  const app = await loadApp(fromFileUrl(new URL("../../../fixtures/apps/hello", import.meta.url)));
  assertEquals("protocol" in app.manifest, false);
});

Deno.test("a protocol trigger may not declare onSubscribe / onUnsubscribe / poll", async () => {
  const src = await Deno.readTextFile(join(PROTOCOL_FIXTURE, "index.ts"));
  for (
    const hook of [
      "onSubscribe() { return {}; }",
      "onUnsubscribe() {}",
      "poll() { return { events: [] }; }",
    ]
  ) {
    const withHook = src.replace(
      `key: "order-placed",`,
      `key: "order-placed", ${hook},`,
    );
    const m = await assertProtocolRefused(() => {}, withHook);
    assert(m.includes(hook.split("(")[0]), m);
  }
});

Deno.test("a two-event protocol trigger without the eventType select is refused", async () => {
  const src = await Deno.readTextFile(join(PROTOCOL_FIXTURE, "index.ts"));
  const m = await assertProtocolRefused(
    () => {},
    src.replace(`key: "eventType",`, `key: "somethingElse",`),
  );
  assert(m.includes("eventType"), m);
});

Deno.test("loader refuses a protocol trigger with no app block, and a non-https/unlisted URL", async () => {
  const m1 = await assertProtocolRefused((p) => delete p.w6w.protocol);
  assert(m1.includes("no `protocol` block"), m1);
  const m2 = await assertProtocolRefused((p) =>
    p.w6w.protocol!.baseUrl = "http://partner.example.test"
  );
  assert(m2.includes("https"), m2);
  const m3 = await assertProtocolRefused((p) => p.w6w.network.allow = ["*"]);
  assert(m3.includes("network.allow"), m3);
});

Deno.test("the loader derives type protocol from a hand-built delivery, whatever type was authored", async () => {
  const src = (await Deno.readTextFile(join(PROTOCOL_FIXTURE, "index.ts"))).replace(
    `key: "order-placed",`,
    `key: "order-placed", type: "webhook",`,
  );
  await withProtocolApp(() => {}, src, async (dir) => {
    const app = await loadApp(dir);
    assertEquals(app.triggers.get("order-placed")!.trigger.type, "protocol");
  });
});
