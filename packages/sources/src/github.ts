/**
 * GitHub resolver. `github:owner/repo@ref` → downloads the tarball, extracts it
 * (stripping the top-level `repo-ref/` component), and returns the local dir.
 * Result is cached by `owner/repo@ref`.
 *
 * Private repos: set `W6W_GITHUB_TOKEN` (or `GITHUB_TOKEN`). With a token we hit
 * the authenticated API tarball endpoint; anonymously we use codeload (public).
 *
 * Runs host-side (full Deno perms) — this is a wrapper concern, never sandboxed.
 */
import {
  type ResolveOptions,
  type Resolver,
  SourceError,
  splitFragment,
  splitRef,
} from "./types.ts";
import { resolveViaTarball } from "./tarball.ts";

export interface GithubRef {
  owner: string;
  repo: string;
  /** Branch, tag, or commit. Defaults to `HEAD`. */
  ref: string;
}

/**
 * Parse `github:owner/repo@ref` (the `@ref` is optional → `HEAD`). An optional
 * trailing `#subpath` fragment is stripped here — it pins a dir within the repo
 * and is applied post-extraction by the resolver, not part of the repo identity.
 */
export function parseGithubRef(ref: string): GithubRef {
  const { base } = splitFragment(ref);
  const { scheme, rest } = splitRef(base);
  if (scheme !== "github") {
    throw new SourceError("bad_scheme", `Not a github ref: ${ref}`);
  }
  const m = rest.match(/^([^/]+)\/([^/@]+)(?:@(.+))?$/);
  if (!m) {
    throw new SourceError("bad_ref", `Expected "github:owner/repo[@ref][#subpath]", got: ${ref}`);
  }
  return { owner: m[1], repo: m[2], ref: m[3] ?? "HEAD" };
}

/** codeload serves a gzipped tarball directly (public, anonymous). */
export function githubTarballUrl({ owner, repo, ref }: GithubRef): string {
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;
}

/** Authenticated API tarball endpoint (works for private; 302s to codeload). */
export function githubApiTarballUrl({ owner, repo, ref }: GithubRef): string {
  return `https://api.github.com/repos/${owner}/${repo}/tarball/${ref}`;
}

/** Resolve the GitHub token from env, if any. */
export function githubToken(): string | undefined {
  return Deno.env.get("W6W_GITHUB_TOKEN") ?? Deno.env.get("GITHUB_TOKEN") ?? undefined;
}

/** Headers for a GitHub tarball fetch (auth when a token is set). */
export function githubAuthHeaders(): HeadersInit {
  const headers: Record<string, string> = { "User-Agent": "w6w-sources" };
  const token = githubToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
    headers["Accept"] = "application/vnd.github+json";
  }
  return headers;
}

export const githubResolver: Resolver = {
  scheme: "github",

  canResolve(ref: string): boolean {
    return splitRef(ref).scheme === "github";
  },

  resolve(ref: string, opts: ResolveOptions = {}): Promise<string> {
    const { subpath } = splitFragment(ref);
    const gh = parseGithubRef(ref);
    const token = githubToken();
    // Authenticated → API endpoint (private-capable); anonymous → codeload.
    const url = token ? githubApiTarballUrl(gh) : githubTarballUrl(gh);
    return resolveViaTarball(
      {
        cacheKey: ["github", gh.owner, gh.repo, gh.ref],
        url,
        headers: githubAuthHeaders(),
        label: "GitHub",
        subpath,
      },
      opts,
    );
  },
};
