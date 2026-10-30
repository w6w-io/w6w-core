/**
 * Wire §7 seam: auth modes, cache/memo partition, truthful `force`,
 * `resolveDetailed`, fetch bounds, coded vendor errors, tar link entries.
 * The memo is module-global, so every test uses a unique owner/repo.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { join } from "jsr:@std/path@^1.0.0";
import { TarStream, type TarStreamInput } from "jsr:@std/tar@^0.1";
import { resolve, resolveDetailed, resolveGithubCommitSha, SourceError } from "../mod.ts";
import type { ResolveOptions, SourceAuth } from "../mod.ts";

const SENTINELS: Record<string, string> = {
  W6W_GITHUB_TOKEN: "SENTINEL-gh-w6w",
  GITHUB_TOKEN: "SENTINEL-gh-plain",
  W6W_GITLAB_TOKEN: "SENTINEL-gl",
  W6W_BITBUCKET_USER: "SENTINEL-bb-user",
  W6W_BITBUCKET_TOKEN: "SENTINEL-bb-token",
};
const NO_ENV: Record<string, undefined> = {
  W6W_GITHUB_TOKEN: undefined,
  GITHUB_TOKEN: undefined,
  W6W_GITLAB_TOKEN: undefined,
  W6W_BITBUCKET_USER: undefined,
  W6W_BITBUCKET_TOKEN: undefined,
};

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>) {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = Deno.env.get(k);
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const prior = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prior;
  }
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

let counter = 0;
const uniq = (p: string) => `${p}${++counter}x${Date.now() % 1_000_000}`;
const SHA1 = "1".repeat(40);
const SHA2 = "2".repeat(40);
const LOOKUP_RE = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/commits\//;

type Entry = { path: string; content?: string; link?: string; bytes?: Uint8Array };

function tar(prefix: string, entries: Entry[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const inputs: TarStreamInput[] = entries.map((e) => {
    if (e.link !== undefined) {
      return { type: "symlink", path: `${prefix}/${e.path}`, linkname: e.link };
    }
    const bytes = e.bytes ?? enc.encode(e.content ?? "");
    return {
      type: "file",
      path: `${prefix}/${e.path}`,
      size: bytes.length,
      readable: ReadableStream.from([bytes]),
    };
  });
  return ReadableStream.from(inputs).pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"));
}

const oneFile = (content = "hi") => tar("repo-x", [{ path: "f.txt", content }]);

function stallUntil<T>(stream: ReadableStream<T>, gate: Promise<void>): ReadableStream<T> {
  const reader = stream.getReader();
  return new ReadableStream<T>({
    async start(controller) {
      await gate;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch { /* consumer cancelled */ }
    },
  });
}

/** Recording fetch stub: `respond` decides each answer; every call is normalized via Request. */
function recorder(respond: (req: Request, i: number) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input as string, init);
    calls.push(req);
    return Promise.resolve(respond(req, calls.length - 1));
  }) as typeof fetch;
  return { calls, impl };
}

/** Default stub: github lookup → `sha`, everything else → a one-file tarball naming its URL's SHA. */
function okStub(sha = SHA1) {
  return recorder((req) =>
    LOOKUP_RE.test(req.url) ? new Response(sha, { status: 200 }) : new Response(oneFile(req.url))
  );
}

const HOSTS = {
  github: (o: string, r: string, ref = SHA1) => `github:${o}/${r}@${ref}`,
  gitlab: (o: string, r: string, ref = "main") => `gitlab:${o}/${r}@${ref}`,
  bitbucket: (o: string, r: string, ref = "main") => `bitbucket:${o}/${r}@${ref}`,
};
type Host = keyof typeof HOSTS;
const HOST_NAMES = Object.keys(HOSTS) as Host[];

function sentinelFree(req: Request) {
  for (const [k, v] of req.headers) {
    assert(!/sentinel/i.test(v), `header ${k} carries a sentinel on ${req.url}`);
  }
}

// ---------- acceptance 1: egress ----------

for (const host of HOST_NAMES) {
  Deno.test(`egress: anonymous sends no credential at ${host} (lookup and tarball)`, async () => {
    await withEnv(SENTINELS, () =>
      withTmp(async (cacheDir) => {
        const stub = okStub();
        const ref = host === "github"
          ? HOSTS.github(uniq("o"), uniq("r"), "main")
          : HOSTS[host](uniq("o"), uniq("r"));
        await withFetch(stub.impl, () => resolve(ref, { cacheDir, auth: { mode: "anonymous" } }));
        assert(stub.calls.length >= (host === "github" ? 2 : 1));
        for (const req of stub.calls) {
          assertEquals(req.headers.get("authorization"), null);
          assertEquals(req.headers.get("private-token"), null);
          sentinelFree(req);
          assertEquals(req.headers.get("user-agent"), "w6w-sources");
        }
        if (host === "github") {
          assert(stub.calls[1].url.startsWith("https://codeload.github.com/"));
        }
      }));
  });

  Deno.test(`egress: token sends exactly the given token at ${host}`, async () => {
    await withEnv(SENTINELS, () =>
      withTmp(async (cacheDir) => {
        const stub = okStub();
        const ref = host === "github"
          ? HOSTS.github(uniq("o"), uniq("r"), "main")
          : HOSTS[host](uniq("o"), uniq("r"));
        await withFetch(
          stub.impl,
          () => resolve(ref, { cacheDir, auth: { mode: "token", token: "tok-123" } }),
        );
        assert(stub.calls.length >= (host === "github" ? 2 : 1));
        for (const req of stub.calls) {
          sentinelFree(req);
          if (host === "gitlab") {
            assertEquals(req.headers.get("private-token"), "tok-123");
            assertEquals(req.headers.get("authorization"), null);
          } else {
            assertEquals(req.headers.get("authorization"), "Bearer tok-123");
            assertEquals(req.headers.get("private-token"), null);
          }
        }
        if (host === "github") {
          assert(stub.calls[1].url.startsWith("https://api.github.com/repos/"));
          assert(stub.calls[1].url.includes("/tarball/"));
        }
      }));
  });

  Deno.test(`egress: absent auth still sends the env credential at ${host}`, async () => {
    await withEnv(SENTINELS, () =>
      withTmp(async (cacheDir) => {
        const stub = okStub();
        const ref = host === "github"
          ? HOSTS.github(uniq("o"), uniq("r"), "main")
          : HOSTS[host](uniq("o"), uniq("r"));
        await withFetch(stub.impl, () => resolve(ref, { cacheDir }));
        for (const req of stub.calls) {
          if (host === "github") {
            assertEquals(req.headers.get("authorization"), "Bearer SENTINEL-gh-w6w");
          } else if (host === "gitlab") {
            assertEquals(req.headers.get("private-token"), "SENTINEL-gl");
          } else {
            assertEquals(
              req.headers.get("authorization"),
              `Basic ${btoa("SENTINEL-bb-user:SENTINEL-bb-token")}`,
            );
          }
        }
        // `host` mode spelled out is the same thing.
        const stub2 = okStub();
        await withFetch(
          stub2.impl,
          () => resolve(ref, { cacheDir, force: true, auth: { mode: "host" } }),
        );
        assertEquals(
          [...stub2.calls[0].headers].sort(),
          [...stub.calls[0].headers].sort(),
        );
      }));
  });
}

Deno.test("egress: an empty token never falls back to an env token", async () => {
  await withEnv(SENTINELS, () =>
    withTmp(async (cacheDir) => {
      for (const host of HOST_NAMES) {
        const stub = okStub();
        const ref = HOSTS[host](uniq("o"), uniq("r"), host === "github" ? SHA1 : "main");
        await withFetch(
          stub.impl,
          () => resolve(ref, { cacheDir, auth: { mode: "token", token: "" } }),
        );
        for (const req of stub.calls) {
          sentinelFree(req);
          assertEquals(req.headers.get("authorization"), null);
          assertEquals(req.headers.get("private-token"), null);
        }
      }
    }));
});

// ---------- acceptance 2: partition ----------

Deno.test("partition: a host-cached full-SHA github dir is not served to anonymous or token", async () => {
  await withEnv(NO_ENV, () =>
    withTmp(async (cacheDir) => {
      const stub = okStub();
      const ref = HOSTS.github(uniq("o"), uniq("r"));
      const hostDir = await withFetch(stub.impl, () => resolve(ref, { cacheDir }));
      assertEquals(stub.calls.length, 1);
      const anon = await withFetch(
        stub.impl,
        () => resolve(ref, { cacheDir, auth: { mode: "anonymous" } }),
      );
      assertEquals(stub.calls.length, 2, "anonymous makes its own credential-free fetch");
      assert(anon !== hostDir);
      assertEquals(stub.calls[1].headers.get("authorization"), null);
      const tok = await withFetch(
        stub.impl,
        () => resolve(ref, { cacheDir, auth: { mode: "token", token: "t" } }),
      );
      assertEquals(stub.calls.length, 3);
      assert(tok !== hostDir && tok !== anon);
      // Each class still hits its own cache.
      await withFetch(stub.impl, () => resolve(ref, { cacheDir, auth: { mode: "anonymous" } }));
      await withFetch(stub.impl, () => resolve(ref, { cacheDir }));
      assertEquals(stub.calls.length, 3);
    }));
});

Deno.test("partition: the ref→SHA memo is per auth class", async () => {
  await withEnv(NO_ENV, () =>
    withTmp(async (cacheDir) => {
      const stub = okStub();
      const ref = HOSTS.github(uniq("o"), uniq("r"), "main");
      const lookups = () => stub.calls.filter((c) => LOOKUP_RE.test(c.url)).length;
      await withFetch(stub.impl, () => resolve(ref, { cacheDir }));
      assertEquals(lookups(), 1);
      await withFetch(stub.impl, () => resolve(ref, { cacheDir }));
      assertEquals(lookups(), 1, "same class hits the memo");
      await withFetch(stub.impl, () => resolve(ref, { cacheDir, auth: { mode: "anonymous" } }));
      assertEquals(lookups(), 2, "anonymous does its own lookup");
      await withFetch(
        stub.impl,
        () => resolve(ref, { cacheDir, auth: { mode: "token", token: "t" } }),
      );
      assertEquals(lookups(), 3, "token does its own lookup");
    }));
});

for (const host of ["gitlab", "bitbucket"] as const) {
  Deno.test(`partition: ${host} classes do not share a cache dir`, async () => {
    await withEnv(NO_ENV, () =>
      withTmp(async (cacheDir) => {
        const stub = okStub();
        const ref = HOSTS[host](uniq("o"), uniq("r"));
        const a = await withFetch(stub.impl, () => resolve(ref, { cacheDir }));
        const b = await withFetch(
          stub.impl,
          () => resolve(ref, { cacheDir, auth: { mode: "anonymous" } }),
        );
        const c = await withFetch(
          stub.impl,
          () => resolve(ref, { cacheDir, auth: { mode: "token", token: "t" } }),
        );
        assertEquals(stub.calls.length, 3);
        assertEquals(new Set([a, b, c]).size, 3);
      }));
  });
}

Deno.test("partition: evictStale only removes siblings inside the same class", async () => {
  await withEnv(NO_ENV, () =>
    withTmp(async (cacheDir) => {
      const o = uniq("o");
      const r = uniq("r");
      const stub = okStub();
      const hostDir = await withFetch(stub.impl, () =>
        resolve(HOSTS.github(o, r, SHA1), { cacheDir }));
      // Age the host dir past the eviction grace, then fetch another SHA anonymously.
      const old = new Date(Date.now() - 3_600_000);
      await Deno.utime(hostDir, old, old);
      await withFetch(
        stub.impl,
        () =>
          resolve(HOSTS.github(o, r, SHA2), { cacheDir, auth: { mode: "anonymous" } }),
      );
      assert((await Deno.stat(hostDir)).isDirectory, "anonymous fetch must not evict a host dir");
    }));
});

// ---------- acceptance 3: force ----------

Deno.test("force: bypasses the memo read and still writes it", async () => {
  await withEnv(NO_ENV, () =>
    withTmp(async (cacheDir) => {
      let head = SHA1;
      const stub = recorder((req) =>
        LOOKUP_RE.test(req.url)
          ? new Response(head)
          : new Response(oneFile(req.url.match(/[0-9a-f]{40}$/)![0]))
      );
      const lookups = () => stub.calls.filter((c) => LOOKUP_RE.test(c.url)).length;
      const ref = HOSTS.github(uniq("o"), uniq("r"), "main");
      const read = async (opts: ResolveOptions = {}) =>
        Deno.readTextFile(join(await resolve(ref, { cacheDir, ...opts }), "f.txt"));
      await withFetch(stub.impl, async () => {
        assertEquals(await read(), SHA1);
        assertEquals(lookups(), 1);
        head = SHA2;
        assertEquals(await read(), SHA1);
        assertEquals(lookups(), 1, "non-forced within TTL: 0 new lookups");
        assertEquals(await read({ force: true }), SHA2);
        assertEquals(lookups(), 2, "forced: exactly 1 lookup");
        assertEquals(await read(), SHA2, "force wrote the memo");
        assertEquals(lookups(), 2);
      });
    }));
});

Deno.test("force: resolveGithubCommitSha honours it directly", async () => {
  const gh = { owner: uniq("o"), repo: uniq("r"), ref: "main" };
  let head = SHA1;
  const stub = recorder(() => new Response(head));
  await withFetch(stub.impl, async () => {
    assertEquals(await resolveGithubCommitSha(gh, {}), SHA1);
    head = SHA2;
    assertEquals(await resolveGithubCommitSha(gh, {}), SHA1);
    assertEquals(await resolveGithubCommitSha(gh, {}, { force: true }), SHA2);
  });
  assertEquals(stub.calls.length, 2);
});

// ---------- acceptance 4: resolveDetailed ----------

Deno.test("resolveDetailed: github revision is the SHA the tarball fetch used", async () => {
  await withEnv(NO_ENV, () =>
    withTmp(async (cacheDir) => {
      const stub = okStub(SHA2);
      const ref = HOSTS.github(uniq("o"), uniq("r"), "main");
      const out = await withFetch(
        stub.impl,
        () => resolveDetailed(ref, { cacheDir, force: true }),
      );
      assertEquals(out.revision, SHA2);
      assertEquals(stub.calls.filter((c) => LOOKUP_RE.test(c.url)).length, 1);
      const tarballs = stub.calls.filter((c) => !LOOKUP_RE.test(c.url));
      assertEquals(tarballs.length, 1);
      assert(tarballs[0].url.endsWith(SHA2));
      assertEquals(await Deno.readTextFile(join(out.dir, "f.txt")), tarballs[0].url);
      // dir is what resolve() returns for the same call
      assertEquals(await withFetch(stub.impl, () => resolve(ref, { cacheDir })), out.dir);
    }));
});

Deno.test("resolveDetailed: a full-SHA ref reports that SHA without a lookup", async () => {
  await withEnv(NO_ENV, () =>
    withTmp(async (cacheDir) => {
      const stub = okStub();
      const out = await withFetch(
        stub.impl,
        () => resolveDetailed(HOSTS.github(uniq("o"), uniq("r"), SHA2), { cacheDir }),
      );
      assertEquals(out.revision, SHA2);
      assertEquals(stub.calls.length, 1);
    }));
});

Deno.test("resolveDetailed: gitlab, bitbucket and file: have no revision", async () => {
  await withEnv(NO_ENV, () =>
    withTmp(async (cacheDir) => {
      const stub = okStub();
      for (const host of ["gitlab", "bitbucket"] as const) {
        const out = await withFetch(
          stub.impl,
          () => resolveDetailed(HOSTS[host](uniq("o"), uniq("r")), { cacheDir }),
        );
        assertEquals(out.revision, undefined);
        assert((await Deno.stat(out.dir)).isDirectory);
      }
      const local = await resolveDetailed(`file:${cacheDir}`);
      assertEquals(local.dir, cacheDir);
      assertEquals(local.revision, undefined);
    }));
});

// ---------- acceptance 5: bounds ----------

/** An abort controller that fires after `ms`, plus a clear for the finally. */
function abortAfter(ms: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, clear: () => clearTimeout(t) };
}

async function listAll(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const p = join(dir, e.name);
    out.push(p.slice(base.length));
    if (e.isDirectory) out.push(...await listAll(p, base));
  }
  return out;
}

/** After a refused resolve nothing may remain: no `dest`, no `*.tmp-*` staging. */
async function assertNothingLeft(cacheDir: string, owner: string) {
  const left = await listAll(cacheDir);
  assert(!left.some((p) => p.includes(".tmp-")), `staging left: ${left}`);
  assert(!left.some((p) => p.endsWith(SHA1)), `dest left: ${left}`);
  assert(left.every((p) => !p.includes(owner) || !p.endsWith(SHA1)));
}

/** Rejects if `resolve` resolves; a hung bound is released after 3 s so a mutant fails, not hangs. */
function releaseAfter3s(openGate: () => void) {
  const t = setTimeout(openGate, 3000);
  return () => clearTimeout(t);
}

Deno.test("bounds: a tarball fetch stalled until released (3s) rejects `timeout` on abort (needs the signal at the tarball fetch)", async () => {
  await withTmp(async (cacheDir) => {
    const o = uniq("o");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const clearRelease = releaseAfter3s(release);
    // Only the signal ends this fetch; a stub that is handed none stalls until released.
    const impl = ((_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((res, rej) => {
        init?.signal?.addEventListener("abort", () =>
          rej(new DOMException("a", "AbortError")));
        gate.then(() => res(new Response(oneFile())));
      })) as typeof fetch;
    const { signal, clear } = abortAfter(100);
    try {
      const err = await withFetch(impl, () =>
        assertRejects(
          () => resolve(HOSTS.github(o, "stallfetch"), { cacheDir, signal }),
          SourceError,
        ));
      assertEquals(err.code, "timeout");
      release();
      await new Promise((r) => setTimeout(r, 20));
      await assertNothingLeft(cacheDir, o);
    } finally {
      clear();
      clearRelease();
      release();
    }
  });
});

Deno.test("bounds: the github lookup fetch receives the signal", async () => {
  await withTmp(async (cacheDir) => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const impl = ((input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.signal);
      const url = String(input);
      return Promise.resolve(
        LOOKUP_RE.test(url) ? new Response(SHA1) : new Response(oneFile()),
      );
    }) as typeof fetch;
    const ctl = new AbortController();
    await withFetch(
      impl,
      () => resolve(HOSTS.github(uniq("o"), uniq("r"), "main"), { cacheDir, signal: ctl.signal }),
    );
    assertEquals(seen.length, 2);
    assert(seen.every((s) => s === ctl.signal), "signal passed to lookup and tarball fetch");
  });
});

for (const host of HOST_NAMES) {
  Deno.test(`bounds: a stalled body rejects \`timeout\` on abort at ${host}`, async () => {
    await withTmp(async (cacheDir) => {
      const o = uniq("o");
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const clearRelease = releaseAfter3s(release);
      const stub = recorder((req) =>
        LOOKUP_RE.test(req.url) ? new Response(SHA1) : new Response(stallUntil(oneFile(), gate))
      );
      const { signal, clear } = abortAfter(100);
      try {
        const ref = host === "github" ? HOSTS.github(o, "stallbody", SHA1) : HOSTS[host](o, "sb");
        const err = await withFetch(
          stub.impl,
          () => assertRejects(() => resolve(ref, { cacheDir, signal }), SourceError),
        );
        assertEquals(err.code, "timeout");
        release();
        await new Promise((r) => setTimeout(r, 20));
        await assertNothingLeft(cacheDir, o);
      } finally {
        clear();
        clearRelease();
        release();
      }
    });
  });
}

Deno.test("bounds: a bounded joiner of an unbounded in-flight op times out; the op finishes", async () => {
  await withEnv(NO_ENV, () =>
    withTmp(async (cacheDir) => {
      const ref = HOSTS.github(uniq("o"), "joiner", SHA1);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const clearRelease = releaseAfter3s(release);
      const stub = recorder(() => new Response(stallUntil(oneFile("shared"), gate)));
      try {
        await withFetch(stub.impl, async () => {
          const owner = resolve(ref, { cacheDir });
          await new Promise((r) => setTimeout(r, 30));
          const { signal, clear } = abortAfter(100);
          try {
            const err = await assertRejects(() => resolve(ref, { cacheDir, signal }), SourceError);
            assertEquals(err.code, "timeout");
          } finally {
            clear();
          }
          assertEquals(stub.calls.length, 1, "the joiner shared the op");
          release();
          const dir = await owner;
          assertEquals(await Deno.readTextFile(join(dir, "f.txt")), "shared");
        });
      } finally {
        clearRelease();
        release();
      }
    }));
});

Deno.test("bounds: an already-aborted signal rejects `timeout` before any fetch", async () => {
  await withTmp(async (cacheDir) => {
    const stub = okStub();
    const ctl = new AbortController();
    ctl.abort();
    const err = await withFetch(stub.impl, () =>
      assertRejects(
        () => resolve(HOSTS.gitlab(uniq("o"), uniq("r")), { cacheDir, signal: ctl.signal }),
        SourceError,
      ));
    assertEquals(err.code, "timeout");
    assertEquals(stub.calls.length, 0);
  });
});

for (const host of HOST_NAMES) {
  Deno.test(`bounds: maxBytes refuses a body that decompresses past it at ${host}`, async () => {
    await withTmp(async (cacheDir) => {
      const o = uniq("o");
      const big = tar("repo-x", [{ path: "big.bin", bytes: new Uint8Array(400_000) }]);
      const ref = host === "github" ? HOSTS.github(o, "big", SHA1) : HOSTS[host](o, "big");
      const stub = recorder(() => new Response(big));
      const err = await withFetch(
        stub.impl,
        () => assertRejects(() => resolve(ref, { cacheDir, maxBytes: 100_000 }), SourceError),
      );
      assertEquals(err.code, "too_large");
      await assertNothingLeft(cacheDir, o);
    });
  });
}

Deno.test("bounds: a small-compressed gzip bomb is refused on DECOMPRESSED bytes", async () => {
  await withTmp(async (cacheDir) => {
    const o = uniq("o");
    // Compress ONE big chunk so deflate reaches its real ratio (a chunked stream does not).
    const raw = new Uint8Array(
      await new Response(
        ReadableStream.from([{
          type: "file",
          path: "repo-x/z",
          size: 8_000_000,
          readable: ReadableStream.from([new Uint8Array(8_000_000)]),
        } as TarStreamInput]).pipeThrough(new TarStream()),
      ).arrayBuffer(),
    );
    const compressed = new Uint8Array(
      await new Response(
        new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
      ).arrayBuffer(),
    );
    assert(compressed.length < 50_000, `fixture must be tiny compressed (${compressed.length})`);
    const stub = recorder(() => new Response(compressed));
    const err = await withFetch(stub.impl, () =>
      assertRejects(
        () => resolve(HOSTS.github(o, "bomb", SHA1), { cacheDir, maxBytes: compressed.length * 4 }),
        SourceError,
      ));
    assertEquals(err.code, "too_large");
    await assertNothingLeft(cacheDir, o);
  });
});

Deno.test("bounds: an under-cap body succeeds, and absent bounds mean unbounded", async () => {
  await withTmp(async (cacheDir) => {
    const stub = recorder(() => new Response(oneFile("fits")));
    const ctl = new AbortController();
    await withFetch(stub.impl, async () => {
      const dir = await resolve(HOSTS.gitlab(uniq("o"), uniq("r")), {
        cacheDir,
        maxBytes: 1_000_000,
        signal: ctl.signal,
      });
      assertEquals(await Deno.readTextFile(join(dir, "f.txt")), "fits");
      const dir2 = await resolve(HOSTS.bitbucket(uniq("o"), uniq("r")), { cacheDir });
      assertEquals(await Deno.readTextFile(join(dir2, "f.txt")), "fits");
    });
  });
});

// ---------- acceptance 6: codes ----------

const TOK = "tok-SECRET-literal";
const modes: Array<[string, SourceAuth]> = [
  ["anonymous", { mode: "anonymous" }],
  ["token", { mode: "token", token: TOK }],
];

async function code(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  const err = await assertRejects(() => p, SourceError);
  return { code: err.code, message: err.message };
}

const FAILURES: Array<[string, number, Record<string, string>, string]> = [
  ["401", 401, {}, "auth_required"],
  ["403", 403, {}, "auth_required"],
  ["404", 404, {}, "auth_required"],
  ["429", 429, {}, "rate_limited"],
  ["403+ratelimit", 403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
];

for (const host of HOST_NAMES) {
  Deno.test(`codes: ${host} tarball failures are classified under anonymous and token`, async () => {
    await withTmp(async (cacheDir) => {
      for (const [mname, auth] of modes) {
        for (const [label, status, headers, want] of FAILURES) {
          const stub = recorder(() => new Response(null, { status, headers }));
          const ref = host === "github"
            ? HOSTS.github(uniq("o"), uniq("r"), SHA1)
            : HOSTS[host](uniq("o"), uniq("r"));
          const got = await withFetch(stub.impl, () => code(resolve(ref, { cacheDir, auth })));
          assertEquals(got.code, want, `${host}/${mname}/${label}`);
          assert(!got.message.includes(TOK), "message must not carry the token");
        }
      }
    });
  });

  Deno.test(`codes: ${host} absent auth keeps fetch_failed for 404 and 429`, async () => {
    await withEnv(SENTINELS, () =>
      withTmp(async (cacheDir) => {
        for (const status of [404, 429, 403]) {
          const stub = recorder(() =>
            new Response(null, { status, headers: { "x-ratelimit-remaining": "0" } })
          );
          const ref = host === "github"
            ? HOSTS.github(uniq("o"), uniq("r"), SHA1)
            : HOSTS[host](uniq("o"), uniq("r"));
          const got = await withFetch(stub.impl, () => code(resolve(ref, { cacheDir })));
          assertEquals(got.code, "fetch_failed", `${host}/${status}`);
          assert(!got.message.includes("SENTINEL"));
          const got2 = await withFetch(
            stub.impl,
            () => code(resolve(ref, { cacheDir, auth: { mode: "host" } })),
          );
          assertEquals(got2.code, "fetch_failed");
        }
      }));
  });
}

Deno.test("codes: the github ref LOOKUP is classified under anonymous and token", async () => {
  await withTmp(async (cacheDir) => {
    for (const [mname, auth] of modes) {
      for (const [label, status, headers, want] of FAILURES) {
        const stub = recorder(() => new Response(null, { status, headers }));
        const ref = HOSTS.github(uniq("o"), uniq("r"), "main");
        const got = await withFetch(stub.impl, () => code(resolve(ref, { cacheDir, auth })));
        assertEquals(got.code, want, `lookup/${mname}/${label}`);
        assert(!got.message.includes(TOK));
        assertEquals(stub.calls.length, 1, "failure at the lookup stops before the tarball");
      }
    }
    // absent auth: 404 / 429 at the lookup stay fetch_failed
    for (const status of [404, 429]) {
      const stub = recorder(() => new Response(null, { status }));
      const ref = HOSTS.github(uniq("o"), uniq("r"), "main");
      const got = await withFetch(stub.impl, () => code(resolve(ref, { cacheDir })));
      assertEquals(got.code, "fetch_failed");
    }
  });
});

// ---------- acceptance 8: tar link entries ----------

Deno.test("tar: symlink entries are never materialized; regular files still extract", async () => {
  await withTmp(async (cacheDir) => {
    const body = tar("repo-x", [
      { path: "ok.txt", content: "fine" },
      { path: "evil", link: "/etc/passwd" },
      { path: "d", link: "/" },
    ]);
    const stub = recorder(() => new Response(body));
    const dir = await withFetch(
      stub.impl,
      () => resolve(HOSTS.github(uniq("o"), uniq("r"), SHA1), { cacheDir }),
    );
    assertEquals(await Deno.readTextFile(join(dir, "ok.txt")), "fine");
    for (const name of ["evil", "d"]) {
      await assertRejects(() => Deno.lstat(join(dir, name)), Deno.errors.NotFound);
    }
  });
});

// ---------- Round 1: the moving-ref lookup honours the signal (P5) ----------

/** A stalled lookup: fetch (or its body) only ends on the signal; a mutant is released after 3 s. */
for (const where of ["fetch", "body"] as const) {
  Deno.test(`bounds: a stalled github lookup ${where} on a moving ref rejects \`timeout\` on abort`, async () => {
    await withTmp(async (cacheDir) => {
      const o = uniq("o");
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const clearRelease = releaseAfter3s(release);
      const impl = ((input: string | URL | Request, init?: RequestInit) => {
        if (!LOOKUP_RE.test(String(input))) return Promise.resolve(new Response(oneFile()));
        const abortErr = () => new DOMException("aborted", "AbortError");
        if (where === "fetch") {
          return new Promise<Response>((res, rej) => {
            init?.signal?.addEventListener("abort", () => rej(abortErr()));
            gate.then(() => res(new Response(SHA1)));
          });
        }
        const body = new ReadableStream<Uint8Array>({
          async pull(ctl) {
            await new Promise<void>((r) => {
              init?.signal?.addEventListener("abort", () => r());
              gate.then(() => r());
            });
            if (init?.signal?.aborted) ctl.error(abortErr());
            else {
              ctl.enqueue(new TextEncoder().encode(SHA1));
              ctl.close();
            }
          },
        });
        return Promise.resolve(new Response(body));
      }) as typeof fetch;
      const { signal, clear } = abortAfter(100);
      try {
        const err = await withFetch(impl, () =>
          assertRejects(
            () => resolve(HOSTS.github(o, "lookup" + where, "main"), { cacheDir, signal }),
            SourceError,
          ));
        assertEquals(err.code, "timeout");
      } finally {
        clear();
        clearRelease();
        release();
      }
    });
  });
}

Deno.test("bounds: a pre-aborted signal on a moving ref rejects `timeout` before any lookup", async () => {
  await withTmp(async (cacheDir) => {
    const stub = okStub();
    const ctl = new AbortController();
    ctl.abort();
    const err = await withFetch(stub.impl, () =>
      assertRejects(
        () => resolve(HOSTS.github(uniq("o"), uniq("r"), "main"), { cacheDir, signal: ctl.signal }),
        SourceError,
      ));
    assertEquals(err.code, "timeout");
    assertEquals(stub.calls.length, 0);
  });
});

// ---------- Round 1: fail-closed hardening (F1, F3) ----------

for (const [label, bad] of [["ANONYMOUS", { mode: "ANONYMOUS" }], ["{}", {}], ["null", null]]) {
  Deno.test(`auth: an unknown runtime auth.mode (${label}) is refused, never the host token`, async () => {
    await withTmp(async (cacheDir) => {
      await withEnv({ W6W_GITHUB_TOKEN: "ghp_hosttoken_sentinel" }, async () => {
        const stub = okStub();
        const r = await withFetch(
          stub.impl,
          () =>
            code(resolve(HOSTS.github(uniq("o"), uniq("r")), {
              cacheDir,
              auth: bad as unknown as SourceAuth,
            })),
        );
        assertEquals(r.code, "bad_ref");
        assert(!r.message.includes("hosttoken"));
        assertEquals(stub.calls.length, 0);
      });
    });
  });
}

for (const bad of [NaN, Infinity, 0, -5]) {
  Deno.test(`bounds: maxBytes ${bad} is refused rather than silently unbounded`, async () => {
    await withTmp(async (cacheDir) => {
      const stub = okStub();
      const r = await withFetch(
        stub.impl,
        () => code(resolve(HOSTS.github(uniq("o"), uniq("r")), { cacheDir, maxBytes: bad })),
      );
      assertEquals(r.code, "bad_ref");
      assertEquals(stub.calls.length, 0);
    });
  });
}
