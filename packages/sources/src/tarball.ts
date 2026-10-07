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
import { type ResolveOptions, SourceError } from "./types.ts";
import { applySubpath } from "./subpath.ts";

/** Default cache root: `$W6W_CACHE`, else `${TMPDIR}/w6w-sources`, else /tmp. */
export function defaultCacheDir(): string {
  return Deno.env.get("W6W_CACHE") ?? join(Deno.env.get("TMPDIR") ?? "/tmp", "w6w-sources");
}

/** Extract a `.tar.gz` stream into destDir, stripping the leading path component. */
export async function extractStripped(
  body: ReadableStream<Uint8Array>,
  destDir: string,
): Promise<void> {
  // Cast around the lib.dom Uint8Array<ArrayBuffer> generic mismatch.
  const gunzip = new DecompressionStream("gzip") as unknown as TransformStream<
    Uint8Array,
    Uint8Array
  >;
  const entries = body.pipeThrough(gunzip).pipeThrough(new UntarStream());

  for await (const entry of entries) {
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

export interface TarballSource {
  /** Path segments under `<cacheDir>` identifying this ref (e.g. host/owner/repo/ref). */
  cacheKey: string[];
  /** Tarball (`.tar.gz`) URL to download. */
  url: string;
  /** Optional auth/other headers for the fetch. */
  headers?: HeadersInit;
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
  const dest = join(cacheDir, ...src.cacheKey.map((s) => s.replace(/[^\w.-]/g, "_")));
  const force = !!opts.force;

  // No await between the map lookups and `set`, so registration is atomic.
  for (;;) {
    const cur = inFlight.get(dest);
    if (!cur) break;
    if (!force || cur.force) return applySubpath(await cur.promise, src.subpath);
    await cur.promise.catch(() => {});
  }
  const promise = loadTarball(src, dest, force).finally(() => {
    if (inFlight.get(dest)?.promise === promise) inFlight.delete(dest);
  });
  inFlight.set(dest, { promise, force });
  return applySubpath(await promise, src.subpath);
}

/** Cache-check / fetch / extract into `dest`; resolves to `dest` (no subpath applied). */
async function loadTarball(src: TarballSource, dest: string, force: boolean): Promise<string> {
  if (force) {
    await Deno.remove(dest, { recursive: true }).catch(() => {});
  } else {
    try {
      if ((await Deno.stat(dest)).isDirectory) return dest;
    } catch { /* not cached yet */ }
  }

  const res = await fetch(src.url, { headers: src.headers });
  if (!res.ok || !res.body) {
    const who = src.label ?? "source";
    throw new SourceError("fetch_failed", `${who} fetch failed (${res.status}): ${src.url}`);
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
    await extractStripped(res.body, staging);
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
