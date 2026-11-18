import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1.0.0";
import { npmResolver } from "../src/npm.ts";
import { SourceError } from "../src/types.ts";
import { makeTgz, MockRegistry, sha512Sri } from "./_mock_registry.ts";

async function withEnv<T>(
  f: (m: MockRegistry, cacheDir: string) => Promise<T>,
): Promise<T> {
  const m = new MockRegistry();
  const cacheDir = await Deno.makeTempDir();
  const prev = Deno.env.get("W6W_NPM_REGISTRY");
  Deno.env.set("W6W_NPM_REGISTRY", m.base);
  try {
    return await f(m, cacheDir);
  } finally {
    if (prev === undefined) Deno.env.delete("W6W_NPM_REGISTRY");
    else Deno.env.set("W6W_NPM_REGISTRY", prev);
    await m.close();
    await Deno.remove(cacheDir, { recursive: true });
  }
}

async function code(p: Promise<unknown>): Promise<string> {
  const e = await assertRejects(() => p, SourceError);
  return (e as SourceError).code;
}

async function countDirs(root: string, name: string): Promise<number> {
  let n = 0;
  for await (const e of Deno.readDir(root)) {
    if (!e.isDirectory) continue;
    if (e.name === name) n++;
    n += await countDirs(join(root, e.name), name);
  }
  return n;
}

const pkgJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "x", version: "1.0.0", ...extra });

Deno.test("npm: latest default, env override (AC7), revision = exact version", async () => {
  await withEnv(async (m, cacheDir) => {
    await m.addNpm("@acme/app", "1.0.0");
    await m.addNpm("@acme/app", "2.0.0");
    m.setTag("@acme/app", "latest", "2.0.0");
    const r = await npmResolver.resolveDetailed!("npm:@acme/app#my-app", { cacheDir });
    assertEquals(r.revision, "2.0.0");
    assert(await Deno.stat(join(r.dir, "w6w/app.js")));
    assert(m.hits("/@acme%2fapp").length >= 1);
  });
});

Deno.test("npm: ^1 excludes 2.0.0 and prereleases", async () => {
  await withEnv(async (m, cacheDir) => {
    for (const v of ["1.0.0", "1.2.0", "1.3.0-beta.1", "2.0.0"]) await m.addNpm("pkg", v);
    m.setTag("pkg", "latest", "2.0.0");
    const r = await npmResolver.resolveDetailed!("npm:pkg@^1", { cacheDir });
    assertEquals(r.revision, "1.2.0");
  });
});

Deno.test("npm: deprecated version allowed and reported", async () => {
  await withEnv(async (m, cacheDir) => {
    await m.addNpm("pkg", "1.0.0", { deprecated: "use 2" });
    m.setTag("pkg", "latest", "1.0.0");
    const r = await npmResolver.resolveDetailed!("npm:pkg", { cacheDir });
    assertEquals((r as { deprecated?: string }).deprecated, "use 2");
  });
});

Deno.test("npm: invalid name is refused with zero mock hits", async () => {
  await withEnv(async (m, cacheDir) => {
    assertEquals(await code(npmResolver.resolveDetailed!("npm:Bad_Name", { cacheDir })), "bad_ref");
    assertEquals(m.requests.length, 0);
  });
});

Deno.test("npm: off-origin dist.tarball refused before any body read", async () => {
  await withEnv(async (m, cacheDir) => {
    const evil = new MockRegistry();
    try {
      await m.addNpm("pkg", "1.0.0", { tarballUrl: `${evil.base}/-/tgz/pkg/1.0.0.tgz` });
      m.setTag("pkg", "latest", "1.0.0");
      assertEquals(
        await code(npmResolver.resolveDetailed!("npm:pkg", { cacheDir })),
        "off_registry",
      );
      assertEquals(evil.requests.length, 0);
    } finally {
      await evil.close();
    }
  });
});

Deno.test("npm: off-origin redirect refused; no cache entry", async () => {
  await withEnv(async (m, cacheDir) => {
    const evil = new MockRegistry();
    try {
      await m.addNpm("pkg", "1.0.0", { redirectTo: `${evil.base}/x.tgz` });
      m.setTag("pkg", "latest", "1.0.0");
      assertEquals(
        await code(npmResolver.resolveDetailed!("npm:pkg", { cacheDir })),
        "off_registry",
      );
      assertEquals(evil.requests.length, 0);
      assertEquals(await countDirs(cacheDir, "1.0.0"), 0);
    } finally {
      await evil.close();
    }
  });
});

Deno.test("npm: integrity mismatch refused before extraction, no cache entry", async () => {
  await withEnv(async (m, cacheDir) => {
    const other = await makeTgz({ "package/package.json": "{}" });
    await m.addNpm("pkg", "1.0.0", { integrity: await sha512Sri(other) });
    m.setTag("pkg", "latest", "1.0.0");
    assertEquals(
      await code(npmResolver.resolveDetailed!("npm:pkg", { cacheDir })),
      "integrity_mismatch",
    );
    // retry still hits the network (nothing cached)
    const before = m.hits("/-/tgz").length;
    await code(npmResolver.resolveDetailed!("npm:pkg", { cacheDir }));
    assertEquals(m.hits("/-/tgz").length, before + 1);
  });
});

Deno.test("npm: compressed bytes capped by maxBytes", async () => {
  await withEnv(async (m, cacheDir) => {
    await m.addNpm("pkg", "1.0.0", {
      files: { "package/package.json": pkgJson(), "package/big.txt": "x".repeat(50_000) },
    });
    m.setTag("pkg", "latest", "1.0.0");
    assertEquals(
      await code(npmResolver.resolveDetailed!("npm:pkg", { cacheDir, maxBytes: 100 })),
      "too_large",
    );
  });
});

Deno.test("npm: second resolve of exact version is a tarball cache hit", async () => {
  await withEnv(async (m, cacheDir) => {
    await m.addNpm("pkg", "1.0.0", { files: { "package/package.json": pkgJson() } });
    await npmResolver.resolveDetailed!("npm:pkg@1.0.0", { cacheDir });
    await npmResolver.resolveDetailed!("npm:pkg@1.0.0", { cacheDir });
    assertEquals(m.hits("/-/tgz").length, 1);
  });
});

Deno.test("npm: dependency policy (AC4) — every field incl. empty {}, node_modules entry", async () => {
  for (
    const f of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "bundledDependencies",
      "bundleDependencies",
    ]
  ) {
    await withEnv(async (m, cacheDir) => {
      await m.addNpm("pkg", "1.0.0", { files: { "package/package.json": pkgJson({ [f]: {} }) } });
      assertEquals(
        await code(npmResolver.resolveDetailed!("npm:pkg@1.0.0", { cacheDir })),
        "npm_dependencies_forbidden",
        f,
      );
      // refused package is not left as a cache hit
      assertEquals(
        await code(npmResolver.resolveDetailed!("npm:pkg@1.0.0", { cacheDir })),
        "npm_dependencies_forbidden",
      );
    });
  }
  await withEnv(async (m, cacheDir) => {
    await m.addNpm("pkg", "1.0.0", {
      files: {
        "package/package.json": pkgJson(),
        "package/node_modules/dep/index.js": "1",
      },
    });
    assertEquals(
      await code(npmResolver.resolveDetailed!("npm:pkg@1.0.0", { cacheDir })),
      "npm_dependencies_forbidden",
    );
  });
});

Deno.test("npm: auth (AC6) — token => Bearer on every request; anonymous/host none; no leak", async () => {
  await withEnv(async (m, cacheDir) => {
    await m.addNpm("pkg", "1.0.0", { files: { "package/package.json": pkgJson() } });
    m.setTag("pkg", "latest", "1.0.0");
    const SECRET = "s3cr3t-token";
    const r = await npmResolver.resolveDetailed!("npm:pkg", {
      cacheDir,
      auth: { mode: "token", token: SECRET },
    });
    assert(m.requests.length >= 2);
    for (const q of m.requests) assertEquals(q.headers.get("authorization"), `Bearer ${SECRET}`);
    assert(!r.dir.includes(SECRET));
    // token resolves into its own cache partition
    assertEquals(r.dir.startsWith(cacheDir), true);

    m.requests.length = 0;
    for (const auth of [{ mode: "anonymous" as const }, { mode: "host" as const }, undefined]) {
      await npmResolver.resolveDetailed!("npm:pkg", { cacheDir, auth, force: true });
    }
    assert(m.requests.length >= 3);
    for (const q of m.requests) assertEquals(q.headers.get("authorization"), null);

    // error path never echoes the token
    const e = await assertRejects(
      () =>
        npmResolver.resolveDetailed!("npm:missing", {
          cacheDir,
          auth: { mode: "token", token: SECRET },
        }),
      SourceError,
    );
    assert(!(e as Error).message.includes(SECRET));
  });
});
