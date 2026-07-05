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

  if (!opts.force) {
    try {
      if ((await Deno.stat(dest)).isDirectory) return dest;
    } catch { /* not cached yet */ }
  } else {
    await Deno.remove(dest, { recursive: true }).catch(() => {});
  }

  const res = await fetch(src.url, { headers: src.headers });
  if (!res.ok || !res.body) {
    const who = src.label ?? "source";
    throw new SourceError("fetch_failed", `${who} fetch failed (${res.status}): ${src.url}`);
  }
  await Deno.mkdir(dest, { recursive: true });
  try {
    await extractStripped(res.body, dest);
  } catch (e) {
    await Deno.remove(dest, { recursive: true }).catch(() => {});
    throw e;
  }
  return dest;
}
