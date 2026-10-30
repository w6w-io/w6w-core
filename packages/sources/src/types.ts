/**
 * Source resolution — turn a source reference into a local directory that
 * `@w6w/runtime`'s `loadApp` can consume. Resolvers are pluggable; built-ins
 * cover `file:` and `github:`. A reference's scheme selects the resolver.
 */

/**
 * Which credential a remote resolve presents. Absent ≡ `{ mode: "host" }`
 * (today's env-token behaviour). `anonymous` sends no credential on any
 * request; `token` sends only the given token (never an env token).
 */
export type SourceAuth =
  | { mode: "host" }
  | { mode: "anonymous" }
  | { mode: "token"; token: string };

export interface ResolveOptions {
  /** Root for cached downloads. Defaults to `$W6W_CACHE` or an OS temp dir. */
  cacheDir?: string;
  /** Re-download even if a cached copy exists (also bypasses the GitHub ref→SHA memo read). */
  force?: boolean;
  /** Credential selection for remote resolvers. Absent ≡ `{ mode: "host" }`. */
  auth?: SourceAuth;
  /** Abort the resolve; any abort surfaces as `SourceError("timeout")`. Absent = unbounded. */
  signal?: AbortSignal;
  /** Cap on DECOMPRESSED tarball bytes; beyond it `SourceError("too_large")`. Absent = unbounded. */
  maxBytes?: number;
}

/** The auth class a resolve belongs to; partitions the cache and the SHA memo. */
export type AuthClass = "host" | "anonymous" | "token";

/** Class of `auth` (absent ≡ host). */
export function authClassOf(auth?: SourceAuth): AuthClass {
  if (auth === undefined) return "host";
  // Fail closed: an unrecognised runtime mode must never fall back to the host token.
  const mode = (auth as { mode?: unknown } | null)?.mode;
  if (mode === "host" || mode === "anonymous" || mode === "token") return mode;
  throw new SourceError("bad_ref", "Unknown source auth mode");
}

/**
 * First cache-key segment for a host (`github`, …) in an auth class. Host keeps
 * the bare name, so today's on-disk layout is unchanged; the other classes get
 * their own namespace so a credentialed fetch is never served to another class.
 */
export function classSegment(base: string, cls: AuthClass): string {
  return cls === "host" ? base : `${base}-${cls}`;
}

/** Result of {@link Resolver.resolveDetailed}. */
export interface ResolvedSource {
  dir: string;
  /** The immutable revision the fetch actually used (GitHub commit SHA); `undefined` otherwise. */
  revision?: string;
}

export interface Resolver {
  /** Scheme this resolver handles, e.g. `"github"`, `"file"`. */
  readonly scheme: string;
  /** Whether this resolver can handle `ref`. */
  canResolve(ref: string): boolean;
  /** Resolve `ref` to an absolute local directory. */
  resolve(ref: string, opts: ResolveOptions): Promise<string>;
  /** Like `resolve`, but also reports the revision the fetch used. Optional. */
  resolveDetailed?(ref: string, opts: ResolveOptions): Promise<ResolvedSource>;
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
