/**
 * Source resolution — turn a source reference into a local directory that
 * `@w6w/runtime`'s `loadApp` can consume. Resolvers are pluggable; built-ins
 * cover `file:` and `github:`. A reference's scheme selects the resolver.
 */

export interface ResolveOptions {
  /** Root for cached downloads. Defaults to `$W6W_CACHE` or an OS temp dir. */
  cacheDir?: string;
  /** Re-download even if a cached copy exists. */
  force?: boolean;
}

export interface Resolver {
  /** Scheme this resolver handles, e.g. `"github"`, `"file"`. */
  readonly scheme: string;
  /** Whether this resolver can handle `ref`. */
  canResolve(ref: string): boolean;
  /** Resolve `ref` to an absolute local directory. */
  resolve(ref: string, opts: ResolveOptions): Promise<string>;
}

export class SourceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SourceError";
  }
}

/** Split `scheme:rest`. Returns `undefined` scheme for bare paths. */
export function splitRef(ref: string): { scheme?: string; rest: string } {
  const m = ref.match(/^([a-z][a-z0-9+.-]*):(.*)$/);
  return m ? { scheme: m[1], rest: m[2] } : { rest: ref };
}
