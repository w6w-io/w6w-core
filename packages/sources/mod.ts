/**
 * @w6w/sources — resolve a source reference to a local directory for the runtime.
 *
 * ```ts
 * import { resolve } from "@w6w/sources";
 * const dir = await resolve("github:w6w-io/slack@v1.0.0");
 * const dir2 = await resolve("file:./fixtures/apps/hello");
 * ```
 *
 * Pluggable: a `Resolver` can be registered (or extracted to its own package)
 * without changing how callers invoke `resolve()`.
 */
export { defaultResolvers, resolve, SourceRegistry } from "./src/resolve.ts";
export { localResolver } from "./src/local.ts";
export {
  githubApiTarballUrl,
  githubAuthHeaders,
  githubResolver,
  githubTarballUrl,
  githubToken,
  parseGithubRef,
} from "./src/github.ts";
export type { GithubRef } from "./src/github.ts";
export {
  gitlabArchiveUrl,
  gitlabAuthHeaders,
  gitlabHost,
  gitlabResolver,
  parseGitlabRef,
} from "./src/gitlab.ts";
export type { GitlabRef } from "./src/gitlab.ts";
export {
  bitbucketAuthHeaders,
  bitbucketResolver,
  bitbucketTarballUrl,
  parseBitbucketRef,
} from "./src/bitbucket.ts";
export type { BitbucketRef } from "./src/bitbucket.ts";
export { defaultCacheDir, extractStripped, resolveViaTarball } from "./src/tarball.ts";
export { applySubpath } from "./src/subpath.ts";
export {
  type ResolveOptions,
  type Resolver,
  SourceError,
  splitFragment,
  splitRef,
} from "./src/types.ts";
