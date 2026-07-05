/**
 * GitLab resolver. `gitlab:group[/subgroup…]/repo@ref` → downloads the project
 * archive tarball, strips the top-level dir, returns the local dir. Cached by
 * host + project path + ref.
 *
 * Private repos: set `W6W_GITLAB_TOKEN` (sent as `PRIVATE-TOKEN`). Self-hosted:
 * set `W6W_GITLAB_HOST` (default `gitlab.com`).
 *
 * Runs host-side (full Deno perms) — never sandboxed.
 */
import { type ResolveOptions, type Resolver, SourceError, splitRef } from "./types.ts";
import { resolveViaTarball } from "./tarball.ts";

export interface GitlabRef {
  /** Full project path, e.g. `group/subgroup/repo`. */
  path: string;
  /** Branch, tag, or commit. `"HEAD"` means the project's default branch. */
  ref: string;
}

/** Parse `gitlab:group[/subgroup…]/repo@ref` (`@ref` optional → default branch). */
export function parseGitlabRef(ref: string): GitlabRef {
  const { scheme, rest } = splitRef(ref);
  if (scheme !== "gitlab") {
    throw new SourceError("bad_scheme", `Not a gitlab ref: ${ref}`);
  }
  const at = rest.lastIndexOf("@");
  const path = at >= 0 ? rest.slice(0, at) : rest;
  const gitRef = at >= 0 ? rest.slice(at + 1) : "HEAD";
  // Require at least namespace/project.
  if (!/^[^/]+\/[^/@]+(?:\/[^/@]+)*$/.test(path)) {
    throw new SourceError("bad_ref", `Expected "gitlab:namespace/project[@ref]", got: ${ref}`);
  }
  return { path, ref: gitRef };
}

/** GitLab host (default gitlab.com; override for self-hosted). */
export function gitlabHost(): string {
  return Deno.env.get("W6W_GITLAB_HOST") ?? "gitlab.com";
}

/** Project-archive tarball URL. Omits `sha` for the default branch (`HEAD`). */
export function gitlabArchiveUrl({ path, ref }: GitlabRef, host = gitlabHost()): string {
  const project = encodeURIComponent(path);
  const base = `https://${host}/api/v4/projects/${project}/repository/archive.tar.gz`;
  return ref && ref !== "HEAD" ? `${base}?sha=${encodeURIComponent(ref)}` : base;
}

/** Headers for a GitLab archive fetch (auth when a token is set). */
export function gitlabAuthHeaders(): HeadersInit {
  const headers: Record<string, string> = { "User-Agent": "w6w-sources" };
  const token = Deno.env.get("W6W_GITLAB_TOKEN");
  if (token) headers["PRIVATE-TOKEN"] = token;
  return headers;
}

export const gitlabResolver: Resolver = {
  scheme: "gitlab",

  canResolve(ref: string): boolean {
    return splitRef(ref).scheme === "gitlab";
  },

  resolve(ref: string, opts: ResolveOptions = {}): Promise<string> {
    const gl = parseGitlabRef(ref);
    const host = gitlabHost();
    return resolveViaTarball(
      {
        cacheKey: ["gitlab", host, gl.path, gl.ref],
        url: gitlabArchiveUrl(gl, host),
        headers: gitlabAuthHeaders(),
        label: "GitLab",
      },
      opts,
    );
  },
};
