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

/**
 * Split a ref's optional `#subpath` fragment off the base ref. The fragment
 * pins a directory *within* the resolved source, e.g.
 * `github:owner/repo@main#./apps/sendgrid` selects `apps/sendgrid` inside the
 * extracted repo. Splits on the first `#` only (a subpath never contains one).
 */
export function splitFragment(ref: string): { base: string; subpath?: string } {
  const i = ref.indexOf("#");
  return i < 0 ? { base: ref } : { base: ref.slice(0, i), subpath: ref.slice(i + 1) };
}
