/**
 * Shared tarball download/extract/cache logic used by the host resolvers
 * (github, gitlab, bitbucket). Each host builds a `cacheKey`, a tarball `url`,
 * and optional auth `headers`; this owns the cache-hit / force / fetch / extract
 * / cleanup pipeline.
 *
 * Runs host-side (full Deno perms) — resolvers are a wrapper concern, never
 * sandboxed.
 */
import { dirname, join, normalize, resolve as resolvePath } from "jsr:@std/path@^1.0.0";
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
}

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

  if (opts.force) {
    await Deno.remove(dest, { recursive: true }).catch(() => {});
  } else {
    try {
      if ((await Deno.stat(dest)).isDirectory) return applySubpath(dest, src.subpath);
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
  return applySubpath(dest, src.subpath);
}
