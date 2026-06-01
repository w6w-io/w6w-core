import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { githubTarballUrl, parseGithubRef, resolve, SourceError, splitRef } from "../mod.ts";

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
