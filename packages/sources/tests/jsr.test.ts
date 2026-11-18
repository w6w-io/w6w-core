import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1.0.0";
import { jsrResolver } from "../src/jsr.ts";
import { SourceError } from "../src/types.ts";
import { MockRegistry } from "./_mock_registry.ts";

async function withEnv<T>(f: (m: MockRegistry, cacheDir: string) => Promise<T>): Promise<T> {
  const m = new MockRegistry();
  const cacheDir = await Deno.makeTempDir();
  const prev = Deno.env.get("W6W_JSR_URL");
  Deno.env.set("W6W_JSR_URL", m.base);
  try {
    return await f(m, cacheDir);
  } finally {
    if (prev === undefined) Deno.env.delete("W6W_JSR_URL");
    else Deno.env.set("W6W_JSR_URL", prev);
    await m.close();
    await Deno.remove(cacheDir, { recursive: true });
  }
}

async function code(p: Promise<unknown>): Promise<string> {
  const e = await assertRejects(() => p, SourceError);
  return (e as SourceError).code;
}

const cfg = (extra: Record<string, unknown> = {}) => JSON.stringify({ name: "@a/b", ...extra });

Deno.test("jsr: highest non-yanked stable, override env, only config + w6w/ fetched (AC5)", async () => {
  await withEnv(async (m, cacheDir) => {
    m.addJsr("@a/b", "1.0.0");
    m.addJsr("@a/b", "1.1.0");
    m.addJsr("@a/b", "1.2.0", { yanked: true });
    m.addJsr("@a/b", "2.0.0-beta.1");
    const r = await jsrResolver.resolveDetailed!("jsr:@a/b#app", { cacheDir });
    assertEquals(r.revision, "1.1.0");
    assert(await Deno.stat(join(r.dir, "w6w/app.js")));
    assert(await Deno.stat(join(r.dir, "deno.json")));
    await assertRejects(() => Deno.stat(join(r.dir, "README.md")));
    await assertRejects(() => Deno.stat(join(r.dir, "src/other.ts")));
    const fileHits = m.hits("/@a/b/1.1.0/").map((h) => h.path).sort();
    assertEquals(fileHits, ["/@a/b/1.1.0/deno.json", "/@a/b/1.1.0/w6w/app.js"]);
    assertEquals(m.hits("/@a/b/1.1.0/README").length, 0);
  });
});

Deno.test("jsr: range and yanked exact version", async () => {
  await withEnv(async (m, cacheDir) => {
    m.addJsr("@a/b", "1.0.0");
    m.addJsr("@a/b", "2.0.0");
    m.addJsr("@a/b", "1.5.0", { yanked: true });
    assertEquals(
      (await jsrResolver.resolveDetailed!("jsr:@a/b@^1", { cacheDir })).revision,
      "1.0.0",
    );
    assertEquals(await code(jsrResolver.resolve("jsr:@a/b@1.5.0", { cacheDir })), "not_found");
    assertEquals(await code(jsrResolver.resolve("jsr:unscoped", { cacheDir })), "bad_ref");
  });
});

Deno.test("jsr: unsafe manifest keys refused before any file request (AC5)", async () => {
  const bad = ["/w6w/../x", "/w6w/%2e%2e/x", "/w6w/a%2fb", "/w6w/a\\b", "//w6w/x", "/w6w//x"];
  for (const key of bad) {
    await withEnv(async (m, cacheDir) => {
      m.addJsr("@a/b", "1.0.0", { files: { "/deno.json": cfg(), [key]: "x" } });
      assertEquals(await code(jsrResolver.resolve("jsr:@a/b", { cacheDir })), "unsafe_entry", key);
      assertEquals(m.hits("/@a/b/1.0.0/").length, 0, key);
    });
  }
});

Deno.test("jsr: checksum / size mismatch -> integrity_mismatch, no cache", async () => {
  await withEnv(async (m, cacheDir) => {
    m.addJsr("@a/b", "1.0.0", {
      files: { "/deno.json": cfg(), "/w6w/app.js": "x" },
      badChecksum: { "/w6w/app.js": "sha256-" + "0".repeat(64) },
    });
    m.addJsr("@a/c", "1.0.0", {
      files: { "/deno.json": cfg(), "/w6w/app.js": "xyz" },
      badSize: { "/w6w/app.js": 2 },
    });
    assertEquals(await code(jsrResolver.resolve("jsr:@a/b", { cacheDir })), "integrity_mismatch");
    const c = await code(jsrResolver.resolve("jsr:@a/c", { cacheDir }));
    assert(c === "integrity_mismatch" || c === "too_large", c);
    // Nothing under the cache (published or staged) holds a file after a failed resolve.
    const files: string[] = [];
    const walk = async (d: string) => {
      for await (const e of Deno.readDir(d)) {
        if (e.isDirectory) await walk(join(d, e.name));
        else files.push(join(d, e.name));
      }
    };
    await walk(cacheDir);
    assertEquals(files, []);
  });
});

Deno.test("jsr: summed bytes capped by maxBytes", async () => {
  await withEnv(async (m, cacheDir) => {
    m.addJsr("@a/b", "1.0.0", {
      files: { "/deno.json": cfg(), "/w6w/a.js": "a".repeat(100), "/w6w/b.js": "b".repeat(100) },
    });
    assertEquals(
      await code(jsrResolver.resolve("jsr:@a/b", { cacheDir, maxBytes: 150 })),
      "too_large",
    );
    await jsrResolver.resolve("jsr:@a/b", { cacheDir, maxBytes: 500 });
  });
});

Deno.test("jsr: npm:/jsr: imports refused (AC4), plain imports fine", async () => {
  await withEnv(async (m, cacheDir) => {
    m.addJsr("@a/b", "1.0.0", {
      files: { "/deno.json": cfg({ imports: { x: "npm:left-pad@1" } }) },
    });
    m.addJsr("@a/c", "1.0.0", { files: { "/deno.json": cfg({ imports: { x: "jsr:@std/x" } }) } });
    m.addJsr("@a/d", "1.0.0", { files: { "/deno.json": cfg({ imports: { x: "./x.ts" } }) } });
    assertEquals(
      await code(jsrResolver.resolve("jsr:@a/b", { cacheDir })),
      "npm_dependencies_forbidden",
    );
    assertEquals(
      await code(jsrResolver.resolve("jsr:@a/c", { cacheDir })),
      "npm_dependencies_forbidden",
    );
    await jsrResolver.resolve("jsr:@a/d", { cacheDir });
  });
});

Deno.test("jsr: auth modes (AC6) and cache hit", async () => {
  await withEnv(async (m, cacheDir) => {
    m.addJsr("@a/b", "1.0.0");
    const r = await jsrResolver.resolve("jsr:@a/b", {
      cacheDir,
      auth: { mode: "token", token: "sekrit" },
    });
    assert(m.requests.length > 0);
    assert(m.requests.every((q) => q.headers.get("authorization") === "Bearer sekrit"));
    assert(!r.includes("sekrit"));
    m.requests.length = 0;
    await jsrResolver.resolve("jsr:@a/b", { cacheDir, auth: { mode: "token", token: "sekrit" } });
    assertEquals(m.hits("/@a/b/1.0.0/").length, 0);
    m.requests.length = 0;
    for (const auth of [{ mode: "anonymous" }, { mode: "host" }] as const) {
      await jsrResolver.resolve("jsr:@a/b", { cacheDir, auth });
      assert(m.requests.length > 0);
      assert(m.requests.every((q) => q.headers.get("authorization") === null));
    }
    const e = await assertRejects(() =>
      jsrResolver.resolve("jsr:@a/missing", { cacheDir, auth: { mode: "token", token: "sekrit" } })
    );
    assert(!String((e as Error).message).includes("sekrit"));
  });
});
