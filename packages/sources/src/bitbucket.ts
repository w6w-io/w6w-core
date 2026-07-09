/**
 * Bitbucket Cloud resolver. `bitbucket:owner/repo@ref` → downloads the archive
 * tarball, strips the top-level dir, returns the local dir. Cached by
 * owner/repo/ref.
 *
 * Private repos: set `W6W_BITBUCKET_USER` + `W6W_BITBUCKET_TOKEN` (an app
 * password), sent as HTTP Basic auth.
 *
 * Runs host-side (full Deno perms) — never sandboxed.
 */
import {
  type ResolveOptions,
  type Resolver,
  SourceError,
  splitFragment,
  splitRef,
} from "./types.ts";
import { resolveViaTarball } from "./tarball.ts";

export interface BitbucketRef {
  owner: string;
  repo: string;
  /** Branch, tag, or commit. Defaults to `HEAD`. */
  ref: string;
}

/**
 * Parse `bitbucket:owner/repo@ref` (the `@ref` is optional → `HEAD`). A trailing
 * `#subpath` fragment is stripped here; the resolver applies it post-extraction.
 */
export function parseBitbucketRef(ref: string): BitbucketRef {
  const { base } = splitFragment(ref);
  const { scheme, rest } = splitRef(base);
  if (scheme !== "bitbucket") {
    throw new SourceError("bad_scheme", `Not a bitbucket ref: ${ref}`);
  }
  const m = rest.match(/^([^/]+)\/([^/@]+)(?:@(.+))?$/);
  if (!m) {
    throw new SourceError(
      "bad_ref",
      `Expected "bitbucket:owner/repo[@ref][#subpath]", got: ${ref}`,
    );
  }
  return { owner: m[1], repo: m[2], ref: m[3] ?? "HEAD" };
}

/** Bitbucket Cloud archive tarball URL. */
export function bitbucketTarballUrl({ owner, repo, ref }: BitbucketRef): string {
  return `https://bitbucket.org/${owner}/${repo}/get/${ref}.tar.gz`;
}

/** Headers for a Bitbucket fetch (Basic auth when user + token are set). */
export function bitbucketAuthHeaders(): HeadersInit {
  const headers: Record<string, string> = { "User-Agent": "w6w-sources" };
  const user = Deno.env.get("W6W_BITBUCKET_USER");
  const token = Deno.env.get("W6W_BITBUCKET_TOKEN");
  if (user && token) headers["Authorization"] = `Basic ${btoa(`${user}:${token}`)}`;
  return headers;
}

export const bitbucketResolver: Resolver = {
  scheme: "bitbucket",

  canResolve(ref: string): boolean {
    return splitRef(ref).scheme === "bitbucket";
  },

  resolve(ref: string, opts: ResolveOptions = {}): Promise<string> {
    const { subpath } = splitFragment(ref);
    const bb = parseBitbucketRef(ref);
    return resolveViaTarball(
      {
        cacheKey: ["bitbucket", bb.owner, bb.repo, bb.ref],
        url: bitbucketTarballUrl(bb),
        headers: bitbucketAuthHeaders(),
        label: "Bitbucket",
        subpath,
      },
      opts,
    );
  },
};
