import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import { jsrResolver } from "../src/jsr.ts";
import { npmResolver } from "../src/npm.ts";
import { SourceError } from "../src/types.ts";
import { MockRegistry } from "./_mock_registry.ts";

async function withRegistry(
  envName: string,
  f: (m: MockRegistry, evil: MockRegistry, cacheDir: string) => Promise<void>,
): Promise<void> {
  const m = new MockRegistry();
  const evil = new MockRegistry();
  const cacheDir = await Deno.makeTempDir();
  const prev = Deno.env.get(envName);
  Deno.env.set(envName, m.base);
  try {
    await f(m, evil, cacheDir);
  } finally {
    if (prev === undefined) Deno.env.delete(envName);
    else Deno.env.set(envName, prev);
    await m.close();
    await evil.close();
    await Deno.remove(cacheDir, { recursive: true });
  }
}

async function code(p: Promise<unknown>): Promise<string> {
  const e = await assertRejects(() => p, SourceError);
  return (e as SourceError).code;
}

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

Deno.test("jsr: meta.json redirected to a foreign host -> off_registry", async () => {
  await withRegistry("W6W_JSR_URL", async (m, evil, cacheDir) => {
    m.addJsr("@a/b", "1.0.0");
    m.extra.push((_r, url) =>
      url.pathname === "/@a/b/meta.json" ? redirect(`${evil.base}/@a/b/meta.json`) : undefined
    );
    assertEquals(
      await code(jsrResolver.resolveDetailed!("jsr:@a/b#app", { cacheDir })),
      "off_registry",
    );
    assertEquals(evil.requests.length, 0);
  });
});

Deno.test("jsr: file URL redirected to a foreign host -> off_registry", async () => {
  await withRegistry("W6W_JSR_URL", async (m, evil, cacheDir) => {
    m.addJsr("@a/b", "1.0.0");
    m.extra.push((_r, url) =>
      url.pathname === "/@a/b/1.0.0/w6w/app.js" ? redirect(`${evil.base}/app.js`) : undefined
    );
    assertEquals(
      await code(jsrResolver.resolveDetailed!("jsr:@a/b#app", { cacheDir })),
      "off_registry",
    );
    assertEquals(evil.requests.length, 0);
  });
});

Deno.test("npm: packument redirected to a foreign host -> off_registry", async () => {
  await withRegistry("W6W_NPM_REGISTRY", async (m, evil, cacheDir) => {
    await m.addNpm("pkg", "1.0.0");
    m.setTag("pkg", "latest", "1.0.0");
    m.extra.push((_r, url) => url.pathname === "/pkg" ? redirect(`${evil.base}/pkg`) : undefined);
    assertEquals(await code(npmResolver.resolveDetailed!("npm:pkg", { cacheDir })), "off_registry");
    assertEquals(evil.requests.length, 0);
  });
});
