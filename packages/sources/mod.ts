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
export { defaultResolvers, resolve, resolveDetailed, SourceRegistry } from "./src/resolve.ts";
export { resolveGrantedFolder } from "./src/folder.ts";
export { localResolver } from "./src/local.ts";
export {
  githubApiTarballUrl,
  githubAuthHeaders,
  githubResolver,
  githubTarballUrl,
  githubToken,
  isCommitSha,
  parseGithubRef,
  resolveGithubCommitSha,
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
export { npmResolver } from "./src/npm.ts";
export { jsrResolver } from "./src/jsr.ts";
export { packageKey, parsePackageRef } from "./src/package-ref.ts";
export type { PackageRef, PackageRegistry } from "./src/package-ref.ts";
export { defaultCacheDir, extractStripped, resolveViaTarball } from "./src/tarball.ts";
export { applySubpath } from "./src/subpath.ts";
export {
  type ResolvedSource,
  type ResolveOptions,
  type Resolver,
  type SourceAuth,
  SourceError,
  splitFragment,
  splitRef,
} from "./src/types.ts";
