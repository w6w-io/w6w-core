/**
 * Ref parsing + tarball cache containment (T1.1.1).
 *
 * SAFETY: every test uses its own `Deno.makeTempDir()` root with an explicit,
 * nested `cacheDir` (`<root>/a/b/cache`) so even an UNFIXED tree's escaping
 * dest lands inside the root. `defaultCacheDir()` / `W6W_CACHE` is never used,
 * and `globalThis.fetch` is a counting stub that rejects.
 */
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1.0.0";
import { join } from "jsr:@std/path@^1.0.0";
import {
  parseBitbucketRef,
  parseGithubRef,
  parseGitlabRef,
  resolve,
  resolveViaTarball,
  SourceError,
} from "../mod.ts";
import { gitlabHost } from "../src/gitlab.ts";
import { isStrictlyInside } from "../src/refcheck.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof SourceError ? e.code : `other:${e}`;
  }
  return undefined;
}

// ---- A1 -------------------------------------------------------------------
const BAD: Array<[string, (r: string) => unknown, string]> = [];
for (
  const [name, fn] of [
    ["bitbucket", parseBitbucketRef],
    ["github", parseGithubRef],
  ] as const
) {
  for (
    const r of [
      `${name}:../..@..`,
      `${name}:../..@${SHA}`,
      `${name}:./r@main`,
      `${name}:o/.@main`,
      `${name}:o/..@main`,
      `${name}:.../repo`,
      `${name}:o/...`,
      `${name}:o w/r`,
      `${name}:o/r@..`,
      `${name}:o/r@.`,
      `${name}:o/r@`,
      `${name}:o/r@feature//x`,
      `${name}:o/r@feature/../x`,
      `${name}:o/r@feature/./x`,
      `${name}:o/r@/x`,
      `${name}:o/r@x/`,
    ]
  ) BAD.push([r, fn, "bad_ref"]);
}
for (
  const r of [
    "gitlab:g/r@..",
    "gitlab:g/r@.",
    "gitlab:g/r@",
    "gitlab:g/../r",
    "gitlab:g/./r",
    "gitlab:../r",
    "gitlab:g/..",
    "gitlab:g/...",
    "gitlab:g/r@feature//x",
    "gitlab:g/r@feature/../x",
    "gitlab:g/r@feature/./x",
    "gitlab:g/r@/x",
    "gitlab:g/r@x/",
    "gitlab:g w/r",
    "gitlab:g/s/../r@main",
  ]
) BAD.push([r, parseGitlabRef, "bad_ref"]);

for (const [r, fn, c] of BAD) {
  Deno.test(`A1 refuses ${r}`, () => {
    assertEquals(code(() => fn(r)), c);
  });
}

// ---- A2 -------------------------------------------------------------------
Deno.test("A2 legit refs still parse", () => {
  assertEquals(parseGithubRef("github:w6w-io/w6w-apps@feature/x#./apps/a").ref, "feature/x");
  assertEquals(parseGithubRef(`github:o/r@${SHA}`).ref, SHA);
  assertEquals(parseGithubRef("github:o/r").ref, "HEAD");
  assertEquals(parseBitbucketRef("bitbucket:acme/my.app@release/1.2").ref, "release/1.2");
  assertEquals(parseBitbucketRef("bitbucket:acme/my.app").ref, "HEAD");
  assertEquals(parseGitlabRef("gitlab:group/sub/repo@feature/x"), {
    path: "group/sub/repo",
    ref: "feature/x",
  });
  assertEquals(parseGitlabRef(`gitlab:g/r@${SHA}`).ref, SHA);
  assertEquals(parseGitlabRef("gitlab:g/r").ref, "HEAD");
});

// ---- fixtures -------------------------------------------------------------
async function listing(root: string): Promise<string> {
  const out: string[] = [];
  async function walk(d: string) {
    for await (const e of Deno.readDir(d)) {
      const p = join(d, e.name);
      if (e.isDirectory) {
        out.push(p + "/");
        await walk(p);
      } else {
        out.push(`${p} ${(await Deno.stat(p)).size}`);
      }
    }
  }
  await walk(root);
  return out.sort().join("\n");
}

async function withScratch(
  fn: (ctx: { root: string; cacheDir: string; fetches: () => number }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "w6w-refcont-" });
  const cacheDir = join(root, "a", "b", "cache");
  await Deno.mkdir(cacheDir, { recursive: true });
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (() => {
    n++;
    return Promise.reject(new Error("fetch must not be called"));
  }) as typeof fetch;
  try {
    await fn({ root, cacheDir, fetches: () => n });
  } finally {
    globalThis.fetch = realFetch;
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

async function plant(dir: string): Promise<string> {
  await Deno.mkdir(dir, { recursive: true });
  const marker = join(dir, "MARKER");
  await Deno.writeTextFile(marker, "victim");
  return marker;
}

async function assertIntact(marker: string): Promise<void> {
  assertEquals(await Deno.readTextFile(marker), "victim");
}

// ---- A3 -------------------------------------------------------------------
Deno.test("A3 bitbucket:../..@.. force: bad_ref, no fetch, victim intact", async () => {
  await withScratch(async ({ root, cacheDir, fetches }) => {
    const marker = await plant(join(root, "a"));
    const before = await listing(root);
    const e = await assertRejects(
      () => resolve("bitbucket:../..@..", { cacheDir, force: true }),
      SourceError,
    );
    assertEquals(e.code, "bad_ref");
    assertEquals(fetches(), 0);
    await assertIntact(marker);
    assertEquals(await listing(root), before);
  });
});

for (const force of [true, false]) {
  Deno.test(`A3 github:../..@<sha> force=${force}: bad_ref, no fetch, victim intact`, async () => {
    await withScratch(async ({ root, cacheDir, fetches }) => {
      const marker = await plant(join(root, "a", "b", SHA));
      const before = await listing(root);
      const e = await assertRejects(
        () => resolve(`github:../..@${SHA}`, { cacheDir, force }),
        SourceError,
      );
      assertEquals(e.code, "bad_ref");
      assertEquals(fetches(), 0);
      await assertIntact(marker);
      assertEquals(await listing(root), before);
    });
  });
}

Deno.test("A3 gitlab:g/r@.. force: bad_ref, no fetch, sibling project intact", async () => {
  await withScratch(async ({ root, cacheDir, fetches }) => {
    const marker = await plant(join(cacheDir, "gitlab", gitlabHost(), "other_proj", "sha"));
    const before = await listing(root);
    const e = await assertRejects(
      () => resolve("gitlab:g/r@..", { cacheDir, force: true }),
      SourceError,
    );
    assertEquals(e.code, "bad_ref");
    assertEquals(fetches(), 0);
    await assertIntact(marker);
    assertEquals(await listing(root), before);
  });
});

// ---- A4 / A6 --------------------------------------------------------------
const KEYS: string[][] = [
  ["..", "victim"],
  [],
  ["."],
  ["x", ".."],
  ["bitbucket", "o", "r", ".."],
  ["t", "", "x"],
];
for (const key of KEYS) {
  for (const force of [true, false]) {
    Deno.test(
      `A4 resolveViaTarball ${JSON.stringify(key)} force=${force}: unsafe_cache_path`,
      async () => {
        await withScratch(async ({ root, cacheDir, fetches }) => {
          const marker = await plant(join(cacheDir, ...key));
          const before = await listing(root);
          const e = await assertRejects(
            () =>
              resolveViaTarball({ cacheKey: key, url: "https://example.invalid/x.tar.gz" }, {
                cacheDir,
                force,
              }),
            SourceError,
          );
          assertEquals(e.code, "unsafe_cache_path");
          assert(!e.message.includes(root), "message must not echo the scratch path");
          assertEquals(fetches(), 0);
          await assertIntact(marker);
          assertEquals(await listing(root), before);
        });
      },
    );
  }
}

// ---- A5 -------------------------------------------------------------------
Deno.test("A5 isStrictlyInside", () => {
  assert(isStrictlyInside("/s/cache", "/s/cache/x"));
  assert(!isStrictlyInside("/s/cache", "/s/cache"));
  assert(!isStrictlyInside("/s/cache", "/s/cache-evil/x"));
  assert(!isStrictlyInside("/s/cache", "/s"));
  assert(!isStrictlyInside("/s/cache", "/s/other"));
});

// keep assertThrows import used for parity with sibling tests
Deno.test("A1 bad_ref is a SourceError", () => {
  assertThrows(() => parseGithubRef("github:../..@.."), SourceError);
});
