/**
 * Shared tarball download/extract/cache logic used by the host resolvers
 * (github, gitlab, bitbucket). Each host builds a `cacheKey`, a tarball `url`,
 * and optional auth `headers`; this owns the cache-hit / force / fetch / extract
 * / cleanup pipeline.
 *
 * Runs host-side (full Deno perms) — resolvers are a wrapper concern, never
 * sandboxed.
 */
import { basename, dirname, join, normalize, resolve as resolvePath } from "jsr:@std/path@^1.0.0";
import { UntarStream } from "jsr:@std/tar@^0.1";
import { type AuthClass, type ResolveOptions, SourceError } from "./types.ts";
import { applySubpath } from "./subpath.ts";
import { isStrictlyInside } from "./refcheck.ts";

/** Default cache root: `$W6W_CACHE`, else `${TMPDIR}/w6w-sources`, else /tmp. */
export function defaultCacheDir(): string {
  return Deno.env.get("W6W_CACHE") ?? join(Deno.env.get("TMPDIR") ?? "/tmp", "w6w-sources");
}

/** The error every abort of a resolve's `signal` surfaces as. */
export function abortedError(): SourceError {
  return new SourceError("timeout", "Source fetch was aborted or timed out");
}

/** True when `e` is the fallout of `signal` aborting (everything but a cap breach). */
export function isAbortFallout(e: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted && !(e instanceof SourceError && e.code === "too_large");
}

/**
 * Settle with `p`, or reject `timeout` the moment `signal` aborts. `p` is left
 * running (a joiner must not cancel a shared op). No `signal` → `p` unchanged.
 */
export function raceSignal<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    p.catch(() => {});
    return Promise.reject(abortedError());
  }
  return new Promise<T>((res, rej) => {
    const onAbort = () => rej(abortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        res(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        rej(e);
      },
    );
  });
}

/**
 * Classify a non-ok vendor response. Under `anonymous`/`token`: 429, or a 403
 * with `x-ratelimit-remaining: 0`, is `rate_limited` (checked first); else
 * 401/403/404 is `auth_required`. Host mode keeps `fetch_failed` for everything.
 * `what` is a url/ref — never a credential.
 */
export function httpFailure(
  cls: AuthClass | undefined,
  label: string,
  status: number,
  headers: Headers,
  what: string,
): SourceError {
  const message = `${label} fetch failed (${status}): ${what}`;
  if (cls === "anonymous" || cls === "token") {
    if (status === 429 || (status === 403 && headers.get("x-ratelimit-remaining") === "0")) {
      return new SourceError("rate_limited", message);
    }
    if (status === 401 || status === 403 || status === 404) {
      return new SourceError("auth_required", message);
    }
  }
  return new SourceError("fetch_failed", message);
}

/** Wrap `body` so a stalled read still ends (with `timeout`) when `signal` aborts. */
function abortableBody(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  if (!signal) return body;
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const r = await raceSignal(reader.read(), signal);
        if (r.done) controller.close();
        else controller.enqueue(r.value);
      } catch (e) {
        reader.cancel().catch(() => {});
        controller.error(e);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Pass-through that refuses (`too_large`) once more than `max` bytes have flowed. */
function capBytes(max: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > max) {
        throw new SourceError("too_large", `Source tarball exceeds the ${max}-byte limit`);
      }
      controller.enqueue(chunk);
    },
  });
}

/**
 * Extract a `.tar.gz` stream into destDir, stripping the leading path component.
 * Only regular files and directories are materialized: link, device and fifo
 * entries (typeflag 1-4, 6) are skipped, so a tarball can never plant a symlink.
 * `maxBytes` caps the DECOMPRESSED stream.
 */
export async function extractStripped(
  body: ReadableStream<Uint8Array>,
  destDir: string,
  opts: { maxBytes?: number } = {},
): Promise<void> {
  // Cast around the lib.dom Uint8Array<ArrayBuffer> generic mismatch.
  const gunzip = new DecompressionStream("gzip") as unknown as TransformStream<
    Uint8Array,
    Uint8Array
  >;
  const decompressed = body.pipeThrough(gunzip);
  const bounded = opts.maxBytes === undefined
    ? decompressed
    : decompressed.pipeThrough(capBytes(opts.maxBytes));
  const entries = bounded.pipeThrough(new UntarStream());

  for await (const entry of entries) {
    if (SKIPPED_TYPEFLAGS.has(entry.header.typeflag)) {
      await entry.readable?.cancel();
      continue;
    }
    const stripped = entry.path.split("/").slice(1).join("/");
    if (!stripped) {
      await entry.readable?.cancel();
      continue;
    }
    const outPath = join(destDir, normalize(stripped));
    // Guard against path traversal from a malicious tarball.
    if (outPath !== destDir && !outPath.startsWith(destDir + "/")) {
      await entry.readable?.cancel();
      throw new SourceError("unsafe_entry", `Tar entry escapes target dir: ${entry.path}`);
    }
    if (entry.readable) {
      await Deno.mkdir(dirname(outPath), { recursive: true });
      await entry.readable.pipeTo((await Deno.create(outPath)).writable);
    } else {
      await Deno.mkdir(outPath, { recursive: true });
    }
  }
}

/** hardlink, symlink, char dev, block dev, fifo — never materialized. */
const SKIPPED_TYPEFLAGS = new Set(["1", "2", "3", "4", "6"]);

export interface TarballSource {
  /** Path segments under `<cacheDir>` identifying this ref (e.g. host/owner/repo/ref). */
  cacheKey: string[];
  /** Tarball (`.tar.gz`) URL to download. */
  url: string;
  /** Optional auth/other headers for the fetch. */
  headers?: HeadersInit;
  /** Auth class of this fetch; selects error classification (`auth_required`/`rate_limited`). */
  authClass?: AuthClass;
  /** Host label for error messages (e.g. "GitHub"). */
  label?: string;
  /** Optional `#subpath` fragment: a repo-relative dir to select post-extract. */
  subpath?: string;
  /**
   * Opt in to evicting stale sibling cache dirs (older SHAs) after a successful
   * extract. ONLY set this when the LAST `cacheKey` segment is an immutable id
   * (a commit SHA): siblings are then provably superseded. Moving-ref keys
   * (branch/tag) must not set it — a sibling there is a different live ref.
   */
  evictStale?: boolean;
  /** Minimum sibling age (mtime) before eviction. Default {@link DEFAULT_EVICT_GRACE_MS}. */
  evictGraceMs?: number;
}

/** Siblings younger than this are kept so an in-progress read of an older tree isn't yanked. */
export const DEFAULT_EVICT_GRACE_MS = 10 * 60 * 1000;

interface InFlight {
  promise: Promise<string>;
  force: boolean;
}

/**
 * In-flight download+extract per resolved `dest`, so N concurrent misses on one
 * cacheKey share ONE fetch and ONE staging copy instead of N (which OOMs on
 * in-memory /tmp). Entries are removed when the promise settles, so a failure
 * is never cached; every waiter sees the same rejection.
 *
 * Force semantics: a non-force call joins ANY in-flight op (a forced one is at
 * least as fresh). A force call joins an in-flight FORCED op, but if only a
 * non-force op is in flight it first waits for that to settle (ignoring its
 * outcome) and then runs its own fetch — it never `rm -rf`s a dir an in-flight
 * non-force call is about to rename into place or return. Later non-force calls
 * join the forced op.
 */
const inFlight = new Map<string, InFlight>();

/**
 * Resolve a tarball-backed source to a cached local directory. Returns the
 * cached dir on a hit (unless `force`); otherwise downloads + extracts.
 */
export async function resolveViaTarball(
  src: TarballSource,
  opts: ResolveOptions = {},
): Promise<string> {
  const cacheDir = resolvePath(opts.cacheDir ?? defaultCacheDir());
  const key = src.cacheKey.map((s) => s.replace(/[^\w.-]/g, "_"));
  const dest = join(cacheDir, ...key);
  const force = !!opts.force;
  const signal = opts.signal;
  if (signal?.aborted) throw abortedError();
  // A cap that is not a positive finite number would silently be no cap at all.
  if (opts.maxBytes !== undefined && !(Number.isFinite(opts.maxBytes) && opts.maxBytes > 0)) {
    throw new SourceError("bad_ref", "maxBytes must be a positive finite number");
  }
  // Refuse before any stat/remove/mkdir/rename: `dest` must be strictly inside the cache.
  assertCacheDest(cacheDir, dest, key);

  // No await between the map lookups and `set`, so registration is atomic.
  for (;;) {
    const cur = inFlight.get(dest);
    if (!cur) break;
    // A joiner honours its OWN signal; the shared op keeps running for the others.
    if (!force || cur.force) {
      return applySubpath(await raceSignal(cur.promise, signal), src.subpath);
    }
    await raceSignal(cur.promise.catch(() => {}), signal);
  }
  const promise = loadTarball(src, cacheDir, dest, force, opts).finally(() => {
    if (inFlight.get(dest)?.promise === promise) inFlight.delete(dest);
  });
  inFlight.set(dest, { promise, force });
  return applySubpath(await promise, src.subpath);
}

/**
 * Throw `unsafe_cache_path` unless `dest` is strictly inside `cacheDir` and no
 * sanitized key segment is path-special (`""`, `.`, `..` — the only ones that
 * survive sanitizing). The segment rule catches in-cache wipes (`cache/gitlab/<host>`)
 * that containment alone cannot see. The message never echoes `cacheDir` or `dest`.
 */
function assertCacheDest(cacheDir: string, dest: string, key: string[]): void {
  if (key.some((s) => s === "" || s === "." || s === "..") || !isStrictlyInside(cacheDir, dest)) {
    throw new SourceError(
      "unsafe_cache_path",
      `Cache key escapes the cache directory: ${JSON.stringify(key)}`,
    );
  }
}

/** Cache-check / fetch / extract into `dest`; resolves to `dest` (no subpath applied). */
async function loadTarball(
  src: TarballSource,
  cacheDir: string,
  dest: string,
  force: boolean,
  opts: ResolveOptions,
): Promise<string> {
  try {
    return await loadTarballUnbounded(src, cacheDir, dest, force, opts);
  } catch (e) {
    // Any abort (fetch rejection, stalled body, …) is one coded error.
    if (isAbortFallout(e, opts.signal)) {
      throw abortedError();
    }
    throw e;
  }
}

async function loadTarballUnbounded(
  src: TarballSource,
  cacheDir: string,
  dest: string,
  force: boolean,
  opts: ResolveOptions,
): Promise<string> {
  // Re-assert: first statement, before any remove/stat.
  if (!isStrictlyInside(cacheDir, dest)) {
    throw new SourceError("unsafe_cache_path", "Cache destination escapes the cache directory");
  }
  if (force) {
    await Deno.remove(dest, { recursive: true }).catch(() => {});
  } else {
    try {
      if ((await Deno.stat(dest)).isDirectory) return dest;
    } catch { /* not cached yet */ }
  }

  const res = await fetch(src.url, { headers: src.headers, signal: opts.signal });
  if (!res.ok || !res.body) {
    throw httpFailure(src.authClass, src.label ?? "source", res.status, res.headers, src.url);
  }

  // Extract into a private staging dir and only rename it into place as
  // `dest` once fully populated — never extract into `dest` directly. Two
  // concurrent resolves sharing the same cacheKey are the COMMON case (every
  // app in a pack shares one repo+ref), and `Deno.mkdir(dest)` followed by a
  // slow streaming extract used to make `dest` exist the instant extraction
  // STARTED — so a concurrent caller's cache-hit check above would read a
  // still-being-written directory as a complete hit and 404 looking for its
  // own subpath inside it. Renaming a fully-extracted staging dir into place
  // is atomic, so `dest` only ever appears once its content is real.
  const staging = `${dest}.tmp-${crypto.randomUUID()}`;
  await Deno.mkdir(staging, { recursive: true });
  try {
    await extractStripped(abortableBody(res.body, opts.signal), staging, {
      maxBytes: opts.maxBytes,
    });
  } catch (e) {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    throw e;
  }

  try {
    await Deno.rename(staging, dest);
  } catch (renameErr) {
    // Another resolve for the same cacheKey won the race and already
    // populated `dest` first — a fine outcome, use its copy and drop ours.
    // Anything else (permissions, disk full, …) is a real failure: surface it.
    const destIsDir = await Deno.stat(dest).then((s) => s.isDirectory).catch(() => false);
    await Deno.remove(staging, { recursive: true }).catch(() => {});
    if (!destIsDir) throw renameErr;
  }
  if (src.evictStale) {
    await evictStaleSiblings(dest, src.evictGraceMs ?? DEFAULT_EVICT_GRACE_MS).catch((e) => {
      console.warn(`[sources] stale cache eviction failed: ${e}`);
    });
  }
  return dest;
}

/**
 * Delete sibling cache dirs of `dest` (older SHAs, abandoned staging dirs) whose
 * mtime is older than `graceMs`. Never touches `dest` or its own staging dirs.
 * Per-entry failures are swallowed.
 */
async function evictStaleSiblings(dest: string, graceMs: number): Promise<void> {
  const parent = dirname(dest);
  const self = basename(dest);
  const now = Date.now();
  for await (const entry of Deno.readDir(parent)) {
    if (entry.name === self || entry.name.startsWith(`${self}.tmp-`)) continue;
    if (!entry.isDirectory) continue;
    const path = join(parent, entry.name);
    try {
      const { mtime } = await Deno.stat(path);
      if (!mtime || now - mtime.getTime() < graceMs) continue;
      await Deno.remove(path, { recursive: true });
    } catch { /* best effort */ }
  }
}
