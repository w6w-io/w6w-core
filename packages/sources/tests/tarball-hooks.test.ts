import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { join } from "jsr:@std/path@^1.0.0";
import { TarStream, type TarStreamInput } from "jsr:@std/tar@^0.1";
import { resolveViaTarball } from "../src/tarball.ts";
import { SourceError } from "../src/types.ts";

async function makeTgz(files: Record<string, string>): Promise<Uint8Array<ArrayBuffer>> {
  const inputs: TarStreamInput[] = Object.entries(files).map(([path, text]) => {
    const bytes = new TextEncoder().encode(text);
    return {
      type: "file",
      path,
      size: bytes.length,
      readable: ReadableStream.from([bytes]),
    } as TarStreamInput;
  });
  const gz = ReadableStream.from(inputs).pipeThrough(new TarStream())
    .pipeThrough(
      new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
    );
  return new Uint8Array(await new Response(gz).arrayBuffer()) as Uint8Array<ArrayBuffer>;
}

async function sri(b: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-512", b));
  return "sha512-" + btoa(String.fromCharCode(...d));
}

interface Srv {
  base: string;
  hits: string[];
  close(): Promise<void>;
}

function serve(handler: (req: Request, hits: string[]) => Response): Srv {
  const hits: string[] = [];
  const s = Deno.serve({ port: 0, onListen() {} }, (req) => {
    hits.push(new URL(req.url).pathname);
    return handler(req, hits);
  });
  return {
    base: `http://127.0.0.1:${s.addr.port}`,
    hits,
    close: () => s.shutdown(),
  };
}

async function withCache<T>(f: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await f(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("integrity ok extracts; second resolve is a cache hit (zero fetches)", async () => {
  const tgz = await makeTgz({ "package/a.txt": "hi" });
  const srv = serve(() => new Response(tgz));
  try {
    await withCache(async (cacheDir) => {
      const src = {
        cacheKey: ["npm", "x", "1.0.0"],
        url: `${srv.base}/x.tgz`,
        integrity: await sri(tgz),
        allowedOrigin: srv.base,
      };
      const d = await resolveViaTarball(src, { cacheDir });
      assertEquals(await Deno.readTextFile(join(d, "a.txt")), "hi");
      assertEquals(srv.hits.length, 1);
      await resolveViaTarball(src, { cacheDir });
      assertEquals(srv.hits.length, 1);
    });
  } finally {
    await srv.close();
  }
});

Deno.test("integrity mismatch refused before extraction; no cache entry", async () => {
  const tgz = await makeTgz({ "package/a.txt": "hi" });
  const srv = serve(() => new Response(tgz));
  try {
    await withCache(async (cacheDir) => {
      const src = {
        cacheKey: ["npm", "x", "2.0.0"],
        url: `${srv.base}/x.tgz`,
        integrity: await sri(new Uint8Array([1, 2, 3])),
      };
      const e = await assertRejects(() => resolveViaTarball(src, { cacheDir }), SourceError);
      assertEquals((e as SourceError).code, "integrity_mismatch");
      const left = [];
      for await (const x of Deno.readDir(join(cacheDir, "npm", "x"))) left.push(x.name);
      assertEquals(left, []);
    });
  } finally {
    await srv.close();
  }
});

Deno.test("compressed bytes capped by maxBytes -> too_large", async () => {
  const tgz = await makeTgz({ "package/a.txt": "hi" });
  const srv = serve(() => new Response(tgz));
  try {
    await withCache(async (cacheDir) => {
      const e = await assertRejects(
        () =>
          resolveViaTarball(
            { cacheKey: ["c"], url: `${srv.base}/x.tgz`, integrity: "sha512-AAAA" },
            { cacheDir, maxBytes: 10 },
          ),
        SourceError,
      );
      assertEquals((e as SourceError).code, "too_large");
    });
  } finally {
    await srv.close();
  }
});

Deno.test("off-origin redirect refused off_registry before the target body is read", async () => {
  const tgz = await makeTgz({ "package/a.txt": "hi" });
  const evil = serve(() => new Response(tgz));
  const srv = serve(() =>
    new Response(null, { status: 302, headers: { location: `${evil.base}/x.tgz` } })
  );
  try {
    await withCache(async (cacheDir) => {
      const e = await assertRejects(
        () =>
          resolveViaTarball(
            { cacheKey: ["r"], url: `${srv.base}/x.tgz`, allowedOrigin: srv.base },
            { cacheDir },
          ),
        SourceError,
      );
      assertEquals((e as SourceError).code, "off_registry");
      assertEquals(evil.hits.length, 0);
    });
  } finally {
    await srv.close();
    await evil.close();
  }
});

Deno.test("same-origin redirect is followed", async () => {
  const tgz = await makeTgz({ "package/a.txt": "hi" });
  const srv = serve((req) =>
    new URL(req.url).pathname === "/a"
      ? new Response(null, { status: 302, headers: { location: "/b.tgz" } })
      : new Response(tgz)
  );
  try {
    await withCache(async (cacheDir) => {
      const d = await resolveViaTarball(
        { cacheKey: ["s"], url: `${srv.base}/a`, allowedOrigin: srv.base },
        { cacheDir },
      );
      assertEquals(await Deno.readTextFile(join(d, "a.txt")), "hi");
    });
  } finally {
    await srv.close();
  }
});

Deno.test("onEntry sees every entry; a throw aborts and publishes nothing", async () => {
  const tgz = await makeTgz({ "package/a.txt": "hi", "package/node_modules/z/i.js": "x" });
  const srv = serve(() => new Response(tgz));
  try {
    await withCache(async (cacheDir) => {
      const seen: string[] = [];
      const e = await assertRejects(
        () =>
          resolveViaTarball({
            cacheKey: ["h", "1"],
            url: `${srv.base}/x.tgz`,
            onEntry: (p) => {
              seen.push(p);
              if (p.split("/").includes("node_modules")) {
                throw new SourceError("npm_dependencies_forbidden", "nm");
              }
            },
          }, { cacheDir }),
        SourceError,
      );
      assertEquals((e as SourceError).code, "npm_dependencies_forbidden");
      assert(seen.includes("package/a.txt"));
      const left = [];
      for await (const x of Deno.readDir(join(cacheDir, "h"))) left.push(x.name);
      assertEquals(left, []);
    });
  } finally {
    await srv.close();
  }
});
