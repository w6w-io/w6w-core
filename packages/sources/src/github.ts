/**
 * GitHub resolver. `github:owner/repo@ref` → downloads the tarball, extracts it
 * (stripping the top-level `repo-ref/` component), and returns the local dir.
 * Result is cached by `owner/repo@ref`.
 *
 * Runs host-side (full Deno perms) — this is a wrapper concern, never sandboxed.
 */
import { dirname, join, normalize, resolve as resolvePath } from "jsr:@std/path@^1.0.0";
import { UntarStream } from "jsr:@std/tar@^0.1";
import { type ResolveOptions, type Resolver, SourceError, splitRef } from "./types.ts";

export interface GithubRef {
  owner: string;
  repo: string;
  /** Branch, tag, or commit. Defaults to `HEAD`. */
  ref: string;
}

/** Parse `github:owner/repo@ref` (the `@ref` is optional → `HEAD`). */
export function parseGithubRef(ref: string): GithubRef {
  const { scheme, rest } = splitRef(ref);
  if (scheme !== "github") {
    throw new SourceError("bad_scheme", `Not a github ref: ${ref}`);
  }
  const m = rest.match(/^([^/]+)\/([^/@]+)(?:@(.+))?$/);
  if (!m) {
    throw new SourceError("bad_ref", `Expected "github:owner/repo[@ref]", got: ${ref}`);
  }
  return { owner: m[1], repo: m[2], ref: m[3] ?? "HEAD" };
}

/** codeload serves a gzipped tarball directly. */
export function githubTarballUrl({ owner, repo, ref }: GithubRef): string {
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;
}

function defaultCacheDir(): string {
  const root = Deno.env.get("W6W_CACHE") ?? join(Deno.env.get("TMPDIR") ?? "/tmp", "w6w-sources");
  return root;
}

/** Extract a `.tar.gz` stream into destDir, stripping the leading path component. */
async function extractStripped(body: ReadableStream<Uint8Array>, destDir: string): Promise<void> {
  // Cast around the lib.dom Uint8Array<ArrayBuffer> generic mismatch.
  const gunzip = new DecompressionStream("gzip") as unknown as TransformStream<
    Uint8Array,
    Uint8Array
  >;
  const entries = body.pipeThrough(gunzip).pipeThrough(new UntarStream());

  for await (const entry of entries) {
    const stripped = entry.path.split("/").slice(1).join("/");
    if (!stripped) {
      await entry.readable?.cancel();
      continue;
    }
    const outPath = join(destDir, normalize(stripped));
    // Guard against path traversal from a malicious tarball.
    if (outPath !== destDir && !outPath.startsWith(destDir + "/")) {
      await entry.readable?.cancel();
      throw new SourceError("unsafe_entry", `Tar entry escapes target dir: ${entry.path}`);
    }
    if (entry.readable) {
      await Deno.mkdir(dirname(outPath), { recursive: true });
      await entry.readable.pipeTo((await Deno.create(outPath)).writable);
    } else {
      await Deno.mkdir(outPath, { recursive: true });
    }
  }
}

export const githubResolver: Resolver = {
  scheme: "github",

  canResolve(ref: string): boolean {
    return splitRef(ref).scheme === "github";
  },

  async resolve(ref: string, opts: ResolveOptions = {}): Promise<string> {
    const gh = parseGithubRef(ref);
    const cacheDir = resolvePath(opts.cacheDir ?? defaultCacheDir());
    const dest = join(cacheDir, "github", gh.owner, gh.repo, gh.ref.replace(/[^\w.-]/g, "_"));

    if (!opts.force) {
      try {
        if ((await Deno.stat(dest)).isDirectory) return dest;
      } catch { /* not cached yet */ }
    } else {
      await Deno.remove(dest, { recursive: true }).catch(() => {});
    }

    const url = githubTarballUrl(gh);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new SourceError("fetch_failed", `GitHub fetch failed (${res.status}): ${url}`);
    }
    await Deno.mkdir(dest, { recursive: true });
    try {
      await extractStripped(res.body, dest);
    } catch (e) {
      await Deno.remove(dest, { recursive: true }).catch(() => {});
      throw e;
    }
    return dest;
  },
};
