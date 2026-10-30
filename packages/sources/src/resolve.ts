/**
 * Resolver registry + dispatch. `resolve(ref)` picks a resolver by the ref's
 * scheme (bare paths fall to the local resolver).
 */
import {
  type ResolvedSource,
  type ResolveOptions,
  type Resolver,
  SourceError,
  splitRef,
} from "./types.ts";
import { localResolver } from "./local.ts";
import { githubResolver } from "./github.ts";
import { gitlabResolver } from "./gitlab.ts";
import { bitbucketResolver } from "./bitbucket.ts";

/** Built-in resolvers, in priority order (scheme-dispatched, so order is cosmetic). */
export const defaultResolvers: Resolver[] = [
  githubResolver,
  gitlabResolver,
  bitbucketResolver,
  localResolver,
];

export class SourceRegistry {
  private resolvers: Resolver[];

  constructor(resolvers: Resolver[] = defaultResolvers) {
    this.resolvers = [...resolvers];
  }

  /** Register an additional resolver (highest priority first). */
  register(resolver: Resolver): void {
    this.resolvers.unshift(resolver);
  }

  async resolve(ref: string, opts: ResolveOptions = {}): Promise<string> {
    return (await this.resolveDetailed(ref, opts)).dir;
  }

  /** Resolve to `{ dir, revision }`; `revision` is only known to resolvers that report it. */
  async resolveDetailed(ref: string, opts: ResolveOptions = {}): Promise<ResolvedSource> {
    const resolver = this.resolvers.find((r) => r.canResolve(ref));
    if (!resolver) {
      const { scheme } = splitRef(ref);
      throw new SourceError(
        "no_resolver",
        `No resolver for ${scheme ? `scheme "${scheme}"` : `ref "${ref}"`}.`,
      );
    }
    if (resolver.resolveDetailed) return await resolver.resolveDetailed(ref, opts);
    return { dir: await resolver.resolve(ref, opts) };
  }
}

const registry = new SourceRegistry();

/** Resolve a source ref to a local directory using the built-in resolvers. */
export function resolve(ref: string, opts: ResolveOptions = {}): Promise<string> {
  return registry.resolve(ref, opts);
}

/** Like {@link resolve}, plus the revision the fetch actually used (GitHub: the commit SHA). */
export function resolveDetailed(ref: string, opts: ResolveOptions = {}): Promise<ResolvedSource> {
  return registry.resolveDetailed(ref, opts);
}
