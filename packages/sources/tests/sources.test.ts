import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import {
  bitbucketAuthHeaders,
  bitbucketResolver,
  bitbucketTarballUrl,
  defaultResolvers,
  githubApiTarballUrl,
  githubAuthHeaders,
  githubTarballUrl,
  gitlabArchiveUrl,
  gitlabAuthHeaders,
  gitlabResolver,
  parseBitbucketRef,
  parseGithubRef,
  parseGitlabRef,
  resolve,
  SourceError,
  splitRef,
} from "../mod.ts";

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

const HELLO_DIR = fromFileUrl(new URL("../../../fixtures/apps/hello", import.meta.url));

Deno.test("splitRef separates scheme from bare paths", () => {
  assertEquals(splitRef("github:w6w-io/x@v1"), { scheme: "github", rest: "w6w-io/x@v1" });
  assertEquals(splitRef("file:./x"), { scheme: "file", rest: "./x" });
  assertEquals(splitRef("./x"), { rest: "./x" });
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

Deno.test("parseGithubRef parses owner/repo@ref and defaults to HEAD", () => {
  assertEquals(parseGithubRef("github:w6w-io/slack@v1.2.0"), {
    owner: "w6w-io",
    repo: "slack",
    ref: "v1.2.0",
  });
  assertEquals(parseGithubRef("github:w6w-io/slack").ref, "HEAD");
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
