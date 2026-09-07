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

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/** Whether `ref` already names an immutable commit (a full 40-hex-char SHA). */
export function isCommitSha(ref: string): boolean {
  return FULL_SHA_RE.test(ref);
}

/**
 * Ref → resolved-SHA memo, short-TTL and per-process. A host resolves the
 * same moving ref (e.g. every app in a pack, all pinned to `@main`) many
 * times within seconds of each other; this collapses that burst into one
 * upstream lookup instead of one per resolve. See `resolveGithubCommitSha`
 * for why the lookup itself exists.
 */
const shaMemo = new Map<string, { sha: string; expires: number }>();
const SHA_MEMO_TTL_MS = 30_000;

/**
 * Resolve a possibly-moving ref (branch, tag, `HEAD`) to the commit SHA it
 * currently points at. A ref that already looks like a full SHA is returned
 * unchanged — it's already immutable, so there's nothing to resolve.
 *
 * Why this exists: `resolveViaTarball`'s cache is keyed by the literal ref
 * string and trusts a cache-directory hit forever, with no staleness check.
 * That's fine for a SHA (immutable by definition) but wrong for a branch name
 * like `main` — a moving target. Two failure modes stack on top of each
 * other for a ref cached by branch name: (1) `codeload.github.com`'s
 * tarball-by-branch endpoint can itself lag a push by some window, so even a
 * forced re-fetch immediately after a merge can silently return the
 * pre-merge tree; (2) on a horizontally-scaled host, each instance keeps its
 * own on-disk cache, so a cache-busting call that happens to land on one
 * instance never reaches the others — every instance it *doesn't* land on
 * keeps serving whatever it first cached, forever, and that drifts further
 * behind with every subsequent push. Caching by the *resolved commit SHA*
 * instead removes the staleness question entirely: a hit is always for
 * exactly that commit's content, on every instance, with no coordinated
 * "warm the cache" step required anywhere.
 */
export async function resolveGithubCommitSha(
  gh: GithubRef,
  headers: HeadersInit,
): Promise<string> {
  if (isCommitSha(gh.ref)) return gh.ref;

  const key = `${gh.owner}/${gh.repo}@${gh.ref}`;
  const now = Date.now();
  const cached = shaMemo.get(key);
  if (cached && cached.expires > now) return cached.sha;

  const url = `https://api.github.com/repos/${gh.owner}/${gh.repo}/commits/${gh.ref}`;
  const res = await fetch(url, {
    headers: { ...headers, Accept: "application/vnd.github.sha" },
  });
  if (!res.ok) {
    throw new SourceError("fetch_failed", `GitHub ref lookup failed (${res.status}): ${key}`);
  }
  const sha = (await res.text()).trim();
  if (!isCommitSha(sha)) {
    throw new SourceError("fetch_failed", `GitHub ref lookup returned a non-SHA body for ${key}`);
  }
  shaMemo.set(key, { sha, expires: now + SHA_MEMO_TTL_MS });
  return sha;
}

export const githubResolver: Resolver = {
  scheme: "github",

  canResolve(ref: string): boolean {
    return splitRef(ref).scheme === "github";
  },

  async resolve(ref: string, opts: ResolveOptions = {}): Promise<string> {
    const { subpath } = splitFragment(ref);
    const gh = parseGithubRef(ref);
    const token = githubToken();
    const headers = githubAuthHeaders();
    // Resolve a moving ref to the exact commit it names right now, so the
    // tarball cache below is keyed by immutable content — see
    // `resolveGithubCommitSha`'s doc comment for why.
    const sha = await resolveGithubCommitSha(gh, headers);
    const pinned = { ...gh, ref: sha };
    // Authenticated → API endpoint (private-capable); anonymous → codeload.
    const url = token ? githubApiTarballUrl(pinned) : githubTarballUrl(pinned);
    return resolveViaTarball(
      {
        cacheKey: ["github", gh.owner, gh.repo, sha],
        url,
        headers,
        label: "GitHub",
        subpath,
      },
      opts,
    );
  },
};
