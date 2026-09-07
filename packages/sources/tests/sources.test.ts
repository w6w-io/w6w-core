import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1.0.0";
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1.0.0";
import {
  applySubpath,
  bitbucketAuthHeaders,
  bitbucketResolver,
  bitbucketTarballUrl,
  defaultResolvers,
  githubApiTarballUrl,
  githubAuthHeaders,
  githubResolver,
  githubTarballUrl,
  gitlabArchiveUrl,
  gitlabAuthHeaders,
  gitlabResolver,
  isCommitSha,
  parseBitbucketRef,
  parseGithubRef,
  parseGitlabRef,
  resolve,
  resolveGithubCommitSha,
  resolveViaTarball,
  SourceError,
  splitFragment,
  splitRef,
} from "../mod.ts";
import { TarStream, type TarStreamInput } from "jsr:@std/tar@^0.1";

/** Run `fn` with the given env vars set, restoring prior values afterward. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = Deno.env.get(k);
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const header = (h: HeadersInit, name: string): string | null => new Headers(h).get(name);

const APPS_DIR = fromFileUrl(new URL("../../../fixtures/apps", import.meta.url));
const HELLO_DIR = join(APPS_DIR, "hello");

Deno.test("splitRef separates scheme from bare paths", () => {
  assertEquals(splitRef("github:w6w-io/x@v1"), { scheme: "github", rest: "w6w-io/x@v1" });
  assertEquals(splitRef("file:./x"), { scheme: "file", rest: "./x" });
  assertEquals(splitRef("./x"), { rest: "./x" });
});

Deno.test("splitFragment separates the #subpath fragment from the base ref", () => {
  assertEquals(splitFragment("github:w6w-io/w6w-apps"), { base: "github:w6w-io/w6w-apps" });
  assertEquals(splitFragment("github:w6w-io/w6w-apps#./apps/sendgrid"), {
    base: "github:w6w-io/w6w-apps",
    subpath: "./apps/sendgrid",
  });
  assertEquals(splitFragment("github:w6w-io/w6w-apps@main#./apps/sendgrid"), {
    base: "github:w6w-io/w6w-apps@main",
    subpath: "./apps/sendgrid",
  });
  assertEquals(splitFragment("file:/abs/pack#./hello"), {
    base: "file:/abs/pack",
    subpath: "./hello",
  });
});

Deno.test("local resolver resolves a bare path to an absolute dir", async () => {
  const dir = await resolve(HELLO_DIR);
  assertEquals(dir, HELLO_DIR);
});

Deno.test("local resolver resolves a file: ref", async () => {
  const dir = await resolve(`file:${HELLO_DIR}`);
  assertEquals(dir, HELLO_DIR);
});

Deno.test("local resolver rejects a missing path", async () => {
  const err = await assertRejects(() => resolve("/no/such/dir/here"), SourceError);
  assertEquals(err.code, "not_found");
});

Deno.test("local resolver applies a #subpath fragment (file: and bare)", async () => {
  assertEquals(await resolve(`file:${APPS_DIR}#./hello`), HELLO_DIR);
  assertEquals(await resolve(`${APPS_DIR}#hello`), HELLO_DIR);
});

Deno.test("local resolver rejects a #subpath that escapes the source dir", async () => {
  const err = await assertRejects(
    () => resolve(`file:${APPS_DIR}#../../../../etc`),
    SourceError,
  );
  assertEquals(err.code, "unsafe_subpath");
});

Deno.test("local resolver reports not_found for a missing #subpath", async () => {
  const err = await assertRejects(() => resolve(`file:${APPS_DIR}#./nope`), SourceError);
  assertEquals(err.code, "not_found");
});

// --- applySubpath (generic #subpath application) ---

Deno.test("applySubpath returns the base dir for empty / '.' subpaths", async () => {
  assertEquals(await applySubpath(APPS_DIR), APPS_DIR);
  assertEquals(await applySubpath(APPS_DIR, ""), APPS_DIR);
  assertEquals(await applySubpath(APPS_DIR, "."), APPS_DIR);
  assertEquals(await applySubpath(APPS_DIR, "./"), APPS_DIR);
});

Deno.test("applySubpath joins a contained subpath", async () => {
  assertEquals(await applySubpath(APPS_DIR, "./hello"), HELLO_DIR);
  assertEquals(await applySubpath(APPS_DIR, "hello"), HELLO_DIR);
});

Deno.test("applySubpath rejects a `..` escape", async () => {
  const err = await assertRejects(() => applySubpath(APPS_DIR, "../../../etc"), SourceError);
  assertEquals(err.code, "unsafe_subpath");
});

Deno.test("applySubpath rejects a subpath that is a file, not a dir", async () => {
  // `hello/index.ts` exists as a file in the fixture.
  const err = await assertRejects(() => applySubpath(HELLO_DIR, "./index.ts"), SourceError);
  assertEquals(err.code, "not_a_directory");
});

Deno.test("parseGithubRef parses owner/repo@ref and defaults to HEAD", () => {
  assertEquals(parseGithubRef("github:w6w-io/slack@v1.2.0"), {
    owner: "w6w-io",
    repo: "slack",
    ref: "v1.2.0",
  });
  assertEquals(parseGithubRef("github:w6w-io/slack").ref, "HEAD");
});

Deno.test("parseGithubRef ignores a #subpath fragment and parses the base repo", () => {
  // The exact string that used to detonate with a `bad_ref` SourceError.
  assertEquals(parseGithubRef("github:w6w-io/w6w-apps#./apps/sendgrid"), {
    owner: "w6w-io",
    repo: "w6w-apps",
    ref: "HEAD",
  });
  // `@ref` before `#subpath` still parses the git ref.
  assertEquals(parseGithubRef("github:w6w-io/w6w-apps@main#./apps/sendgrid"), {
    owner: "w6w-io",
    repo: "w6w-apps",
    ref: "main",
  });
});

Deno.test("github resolver claims a ref carrying a #subpath fragment", () => {
  assert(githubResolver.canResolve("github:w6w-io/w6w-apps#./apps/sendgrid"));
  // splitFragment keeps the fragment out of the parsed git ref.
  assertEquals(splitFragment("github:w6w-io/w6w-apps#./apps/sendgrid").subpath, "./apps/sendgrid");
});

Deno.test("githubTarballUrl builds the codeload URL", () => {
  assertEquals(
    githubTarballUrl({ owner: "w6w-io", repo: "slack", ref: "v1.2.0" }),
    "https://codeload.github.com/w6w-io/slack/tar.gz/v1.2.0",
  );
});

Deno.test("parseGithubRef rejects malformed refs", () => {
  let threw = false;
  try {
    parseGithubRef("github:nope");
  } catch (e) {
    threw = e instanceof SourceError;
  }
  assert(threw);
});

Deno.test("resolve rejects an unknown scheme", async () => {
  const err = await assertRejects(() => resolve("ftp://example.com/x"), SourceError);
  assertEquals(err.code, "no_resolver");
});

// --- GitHub auth ---

Deno.test("githubAuthHeaders: anonymous when no token", () => {
  withEnv({ W6W_GITHUB_TOKEN: undefined, GITHUB_TOKEN: undefined }, () => {
    const h = githubAuthHeaders();
    assertEquals(header(h, "authorization"), null);
    assertEquals(header(h, "user-agent"), "w6w-sources");
  });
});

Deno.test("githubAuthHeaders: Bearer when W6W_GITHUB_TOKEN set", () => {
  withEnv({ W6W_GITHUB_TOKEN: "ghp_abc", GITHUB_TOKEN: undefined }, () => {
    assertEquals(header(githubAuthHeaders(), "authorization"), "Bearer ghp_abc");
  });
});

Deno.test("githubApiTarballUrl builds the authenticated endpoint", () => {
  assertEquals(
    githubApiTarballUrl({ owner: "w6w-io", repo: "slack", ref: "v1" }),
    "https://api.github.com/repos/w6w-io/slack/tarball/v1",
  );
});

// --- resolveGithubCommitSha ---

/** Run `fn` with `globalThis.fetch` replaced, restoring it afterward. */
async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const prior = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = prior;
  }
}

const FAKE_SHA = "a".repeat(40);

Deno.test("isCommitSha accepts a 40-hex string, rejects everything else", () => {
  assert(isCommitSha(FAKE_SHA));
  assert(isCommitSha(FAKE_SHA.toUpperCase()));
  assert(!isCommitSha("main"));
  assert(!isCommitSha("a".repeat(39)));
  assert(!isCommitSha("g".repeat(40))); // not hex
});

Deno.test("resolveGithubCommitSha returns an already-SHA ref unchanged, no network call", async () => {
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      throw new Error("must not fetch for an already-resolved SHA");
    },
    async () => {
      const sha = await resolveGithubCommitSha(
        { owner: "w6w-io", repo: "slack", ref: FAKE_SHA },
        {},
      );
      assertEquals(sha, FAKE_SHA);
    },
  );
  assertEquals(calls, 0);
});

Deno.test("resolveGithubCommitSha resolves a branch ref via the GitHub commits API", async () => {
  let seenUrl = "";
  let seenAccept: string | null = null;
  const sha = await withFetch(
    (input, init) => {
      seenUrl = String(input);
      seenAccept = new Headers(init?.headers).get("accept");
      return Promise.resolve(new Response(FAKE_SHA + "\n", { status: 200 }));
    },
    () => resolveGithubCommitSha({ owner: "w6w-io", repo: "resolve-branch", ref: "main" }, {}),
  );
  assertEquals(sha, FAKE_SHA);
  assertEquals(seenUrl, "https://api.github.com/repos/w6w-io/resolve-branch/commits/main");
  assertEquals(seenAccept, "application/vnd.github.sha");
});

Deno.test("resolveGithubCommitSha memoizes within its TTL — one fetch for repeated calls", async () => {
  let calls = 0;
  await withFetch(
    () => {
      calls++;
      return Promise.resolve(new Response(FAKE_SHA, { status: 200 }));
    },
    async () => {
      const gh = { owner: "w6w-io", repo: "resolve-memo", ref: "main" };
      const first = await resolveGithubCommitSha(gh, {});
      const second = await resolveGithubCommitSha(gh, {});
      assertEquals(first, FAKE_SHA);
      assertEquals(second, FAKE_SHA);
    },
  );
  assertEquals(calls, 1);
});

Deno.test("resolveGithubCommitSha throws fetch_failed on a non-ok response", async () => {
  const err = await withFetch(
    () => Promise.resolve(new Response("not found", { status: 404 })),
    () =>
      assertRejects(
        () => resolveGithubCommitSha({ owner: "w6w-io", repo: "resolve-404", ref: "gone" }, {}),
        SourceError,
      ),
  );
  assertEquals(err.code, "fetch_failed");
});

Deno.test("resolveGithubCommitSha throws fetch_failed on a non-SHA body", async () => {
  const err = await withFetch(
    () => Promise.resolve(new Response("<html>not a sha</html>", { status: 200 })),
    () =>
      assertRejects(
        () =>
          resolveGithubCommitSha({ owner: "w6w-io", repo: "resolve-bad-body", ref: "weird" }, {}),
        SourceError,
      ),
  );
  assertEquals(err.code, "fetch_failed");
});

// --- resolveViaTarball ---

/** Build a gzip'd tar body, top-level-prefixed like GitHub's tarballs, from `{path: content}`. */
function buildTarball(
  prefix: string,
  files: Record<string, string>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const inputs: TarStreamInput[] = Object.entries(files).map(([path, content]) => {
    const bytes = enc.encode(content);
    return {
      type: "file",
      path: `${prefix}/${path}`,
      size: bytes.length,
      readable: ReadableStream.from([bytes]),
    };
  });
  return ReadableStream.from(inputs)
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"));
}

Deno.test("resolveViaTarball: cold cache fetches + extracts; warm cache skips the fetch", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    let fetches = 0;
    const dir = await withFetch(
      () => {
        fetches++;
        return Promise.resolve(
          new Response(buildTarball("repo-main", { "hello.txt": "hi" }), { status: 200 }),
        );
      },
      () =>
        resolveViaTarball(
          { cacheKey: ["t", "cold-warm"], url: "https://example.test/t.tar.gz" },
          { cacheDir: tmp },
        ),
    );
    assertEquals(await Deno.readTextFile(join(dir, "hello.txt")), "hi");
    assertEquals(fetches, 1);

    // Second resolve, same key: cache hit, no fetch.
    const dir2 = await withFetch(
      () => {
        throw new Error("must not fetch on a warm cache");
      },
      () =>
        resolveViaTarball(
          { cacheKey: ["t", "cold-warm"], url: "https://example.test/t.tar.gz" },
          { cacheDir: tmp },
        ),
    );
    assertEquals(dir2, dir);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

/** Wrap a stream so it yields nothing until `gate` resolves, then passes everything through. */
function stallUntil<T>(stream: ReadableStream<T>, gate: Promise<void>): ReadableStream<T> {
  const reader = stream.getReader();
  return new ReadableStream<T>({
    async start(controller) {
      await gate;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
      controller.close();
    },
  });
}

Deno.test("resolveViaTarball: `dest` never exists half-populated (regression for the mkdir-then-extract race)", async () => {
  // The bug: the old code did `Deno.mkdir(dest)` THEN awaited extraction —
  // making `dest` exist, empty, for the whole extraction window. A concurrent
  // resolve's cache-hit check (`Deno.stat(dest).isDirectory`) read that as a
  // complete hit and 404'd looking for its own subpath inside it. This stalls
  // the response body mid-flight to hold a resolve inside that window and
  // asserts `dest` is invisible for the whole time — proven by extracting
  // into a staging dir and only renaming it into place once fully populated.
  const tmp = await Deno.makeTempDir();
  try {
    const dest = join(tmp, "t", "stall");
    let openGate = () => {};
    const gate = new Promise<void>((r) => (openGate = r));

    const resolvePromise = withFetch(
      () =>
        Promise.resolve(
          new Response(
            stallUntil(buildTarball("repo-main", { "index.ts": "x" }), gate),
            { status: 200 },
          ),
        ),
      () =>
        resolveViaTarball(
          { cacheKey: ["t", "stall"], url: "https://example.test/t.tar.gz" },
          { cacheDir: tmp },
        ),
    );

    // Give resolveViaTarball time to get past the fetch and into extraction —
    // the gate is still closed, so it's stalled mid-flight right now.
    await new Promise((r) => setTimeout(r, 20));
    const midFlight = await Deno.stat(dest).then((s) => s.isDirectory).catch(() => false);
    assertEquals(midFlight, false, "dest must not exist until extraction is fully done");

    openGate();
    const dir = await resolvePromise;
    assertEquals(await Deno.readTextFile(join(dir, "index.ts")), "x");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveViaTarball: concurrent cold resolves for the SAME key all land on real content", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const paths = ["apps/alpha/index.ts", "apps/bravo/index.ts", "apps/charlie/index.ts"];
    const files = Object.fromEntries(paths.map((p) => [p, p]));

    const results = await withFetch(
      () => Promise.resolve(new Response(buildTarball("repo-main", files), { status: 200 })),
      () =>
        Promise.all(
          paths.map((p) =>
            resolveViaTarball(
              {
                cacheKey: ["t", "concurrent"],
                url: "https://example.test/t.tar.gz",
                subpath: dirname(p),
              },
              { cacheDir: tmp },
            )
          ),
        ),
    );

    for (const [i, p] of paths.entries()) {
      const file = join(results[i], "index.ts");
      assertEquals(await Deno.readTextFile(file), p);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveViaTarball: force removes the old cache before re-fetching", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const dir = await withFetch(
      () =>
        Promise.resolve(
          new Response(buildTarball("repo-main", { "v.txt": "old" }), { status: 200 }),
        ),
      () =>
        resolveViaTarball(
          { cacheKey: ["t", "force"], url: "https://example.test/t.tar.gz" },
          { cacheDir: tmp },
        ),
    );
    assertEquals(await Deno.readTextFile(join(dir, "v.txt")), "old");

    const dir2 = await withFetch(
      () =>
        Promise.resolve(
          new Response(buildTarball("repo-main", { "v.txt": "new" }), { status: 200 }),
        ),
      () =>
        resolveViaTarball(
          { cacheKey: ["t", "force"], url: "https://example.test/t.tar.gz" },
          { cacheDir: tmp, force: true },
        ),
    );
    assertEquals(dir2, dir);
    assertEquals(await Deno.readTextFile(join(dir2, "v.txt")), "new");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// --- GitLab ---

Deno.test("parseGitlabRef parses namespace/project@ref, subgroups, and default", () => {
  assertEquals(parseGitlabRef("gitlab:group/repo@v1"), { path: "group/repo", ref: "v1" });
  assertEquals(parseGitlabRef("gitlab:group/sub/repo@main"), {
    path: "group/sub/repo",
    ref: "main",
  });
  assertEquals(parseGitlabRef("gitlab:group/repo").ref, "HEAD");
});

Deno.test("parseGitlabRef rejects a ref without a namespace", () => {
  const err = assertThrows(() => parseGitlabRef("gitlab:justrepo"));
  assert(err instanceof SourceError);
});

Deno.test("gitlabArchiveUrl encodes the path and omits sha for HEAD", () => {
  assertEquals(
    gitlabArchiveUrl({ path: "group/sub/repo", ref: "v1" }, "gitlab.com"),
    "https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo/repository/archive.tar.gz?sha=v1",
  );
  assertEquals(
    gitlabArchiveUrl({ path: "group/repo", ref: "HEAD" }, "gitlab.example.com"),
    "https://gitlab.example.com/api/v4/projects/group%2Frepo/repository/archive.tar.gz",
  );
});

Deno.test("gitlabAuthHeaders: PRIVATE-TOKEN only when set", () => {
  withEnv({ W6W_GITLAB_TOKEN: undefined }, () => {
    assertEquals(header(gitlabAuthHeaders(), "private-token"), null);
  });
  withEnv({ W6W_GITLAB_TOKEN: "glpat-xyz" }, () => {
    assertEquals(header(gitlabAuthHeaders(), "private-token"), "glpat-xyz");
  });
});

Deno.test("gitlab + bitbucket schemes are dispatched (registered resolvers)", () => {
  // Network-free: assert the resolvers claim their schemes and are registered.
  assert(gitlabResolver.canResolve("gitlab:group/repo@v1"));
  assert(!gitlabResolver.canResolve("github:o/r"));
  assert(bitbucketResolver.canResolve("bitbucket:acme/app@v2"));
  assert(!bitbucketResolver.canResolve("file:./x"));
  const schemes = defaultResolvers.map((r) => r.scheme);
  assert(schemes.includes("gitlab") && schemes.includes("bitbucket"));
});

// --- Bitbucket ---

Deno.test("parseBitbucketRef + bitbucketTarballUrl", () => {
  assertEquals(parseBitbucketRef("bitbucket:acme/app@v2"), {
    owner: "acme",
    repo: "app",
    ref: "v2",
  });
  assertEquals(
    bitbucketTarballUrl({ owner: "acme", repo: "app", ref: "v2" }),
    "https://bitbucket.org/acme/app/get/v2.tar.gz",
  );
});

Deno.test("bitbucketAuthHeaders: Basic only when user + token set", () => {
  withEnv({ W6W_BITBUCKET_USER: undefined, W6W_BITBUCKET_TOKEN: undefined }, () => {
    assertEquals(header(bitbucketAuthHeaders(), "authorization"), null);
  });
  withEnv({ W6W_BITBUCKET_USER: "alice", W6W_BITBUCKET_TOKEN: "app-pw" }, () => {
    assertEquals(
      header(bitbucketAuthHeaders(), "authorization"),
      `Basic ${btoa("alice:app-pw")}`,
    );
  });
});
