/**
 * Resolver registry + dispatch. `resolve(ref)` picks a resolver by the ref's
 * scheme (bare paths fall to the local resolver).
 */
import { type ResolveOptions, type Resolver, SourceError, splitRef } from "./types.ts";
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

  // deno-lint-ignore require-await
  async resolve(ref: string, opts: ResolveOptions = {}): Promise<string> {
    const resolver = this.resolvers.find((r) => r.canResolve(ref));
    if (!resolver) {
      const { scheme } = splitRef(ref);
      throw new SourceError(
        "no_resolver",
        `No resolver for ${scheme ? `scheme "${scheme}"` : `ref "${ref}"`}.`,
      );
    }
    return resolver.resolve(ref, opts);
  }
}

const registry = new SourceRegistry();

/** Resolve a source ref to a local directory using the built-in resolvers. */
export function resolve(ref: string, opts: ResolveOptions = {}): Promise<string> {
  return registry.resolve(ref, opts);
}
