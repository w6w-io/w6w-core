/**
 * `jsr:` resolver. `jsr:@scope/name[@range][#app-id]` → native JSR `meta.json` /
 * `<v>_meta.json` / files (never the npm-compat tarballs). Only the root config and files under
 * `w6w/` listed in the version manifest are fetched; each is verified (sha256 + size) and the
 * sum is capped by `maxBytes`. Manifest keys are validated BEFORE any URL/path join.
 */
import { dirname, join, resolve as resolvePath } from "jsr:@std/path@^1.0.0";
import { parse as parseJsonc } from "jsr:@std/jsonc@^1";
import {
  authClassOf,
  classSegment,
  type ResolvedSource,
  type ResolveOptions,
  type Resolver,
  SourceError,
} from "./types.ts";
import { abortedError, defaultCacheDir, httpFailure, isAbortFallout } from "./tarball.ts";
import {
  assertNoNodeModules,
  assertNoPackageImports,
  assertSafeEntryPath,
  packageKey,
  parsePackageRef,
  selectVersion,
} from "./package-ref.ts";
import { isStrictlyInside } from "./refcheck.ts";

const DEFAULT_JSR_URL = "https://jsr.io";
const MAX_META_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const CONFIG_FILES = new Set(["deno.json", "deno.jsonc", "jsr.json"]);

/** JSR base URL from `W6W_JSR_URL`. No trailing slash. */
export function jsrBase(): string {
  return (Deno.env.get("W6W_JSR_URL") || DEFAULT_JSR_URL).replace(/\/+$/, "");
}

const offRegistry = (what: string) =>
  new SourceError("off_registry", `Refusing request outside the registry origin: ${what}`);

async function fetchOnOrigin(url: string, origin: string, init: RequestInit): Promise<Response> {
  let cur = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (new URL(cur).origin !== origin) throw offRegistry(new URL(cur).origin);
    const res = await fetch(cur, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    await res.body?.cancel().catch(() => {});
    const loc = res.headers.get("location");
    if (!loc) throw new SourceError("fetch_failed", `Redirect without Location: ${cur}`);
    cur = new URL(loc, cur).href;
  }
  throw new SourceError("fetch_failed", "Too many redirects");
}

/** Read a body fully, refusing to buffer more than `limit` bytes. */
async function readBounded(res: Response, limit: number, what: string): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) {
      await reader.cancel().catch(() => {});
      throw new SourceError("too_large", `${what} exceeds its size limit`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

interface ManifestEntry {
  size: number;
  checksum: string;
}

export const jsrResolver: Resolver = {
  scheme: "jsr",
  canResolve: (ref: string) => ref.startsWith("jsr:"),
  resolve: async (ref: string, opts: ResolveOptions = {}): Promise<string> =>
    (await jsrResolver.resolveDetailed!(ref, opts)).dir,

  async resolveDetailed(ref: string, opts: ResolveOptions = {}): Promise<ResolvedSource> {
    const pref = parsePackageRef(ref); // validates the name before any fetch
    if (pref.registry !== "jsr") throw new SourceError("bad_scheme", `Not a jsr ref: ${ref}`);
    if (opts.signal?.aborted) throw abortedError();
    const cls = authClassOf(opts.auth);
    if (
      opts.maxBytes !== undefined && !(Number.isFinite(opts.maxBytes) && opts.maxBytes > 0)
    ) {
      throw new SourceError("bad_ref", "maxBytes must be a positive finite number");
    }
    const base = jsrBase();
    const baseUrl = new URL(base);
    const origin = baseUrl.origin;
    const headers: Record<string, string> = { "User-Agent": "w6w-sources" };
    if (cls === "token" && opts.auth?.mode === "token" && opts.auth.token) {
      headers["Authorization"] = `Bearer ${opts.auth.token}`;
    }
    const pkgUrl = `${base}/${pref.name}`; // name validated: `@scope/name`
    const label = packageKey(pref);

    const getJson = async (url: string): Promise<Record<string, unknown>> => {
      const res = await fetchOnOrigin(url, origin, {
        headers: { ...headers, Accept: "application/json" },
        signal: opts.signal,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw httpFailure(cls, "jsr", res.status, res.headers, label);
      }
      const bytes = await readBounded(res, MAX_META_BYTES, "jsr metadata");
      try {
        const doc = JSON.parse(new TextDecoder().decode(bytes));
        if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("shape");
        return doc as Record<string, unknown>;
      } catch {
        throw new SourceError("fetch_failed", `jsr metadata for ${label} is not valid JSON`);
      }
    };

    try {
      const meta = await getJson(`${pkgUrl}/meta.json`);
      const versions = (meta.versions ?? {}) as Record<string, { yanked?: boolean }>;
      const info = Object.fromEntries(
        Object.entries(versions).map(([v, m]) => [v, { yanked: !!m?.yanked }]),
      );
      const version = selectVersion("jsr", info, pref.range);
      const vmeta = await getJson(`${pkgUrl}/${encodeURIComponent(version)}_meta.json`);
      const manifest = vmeta.manifest;
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new SourceError("bad_package", `${label}@${version} has no manifest`);
      }

      // Validate EVERY key before any URL/path join; pick the files we need.
      const wanted: [string, ManifestEntry][] = [];
      for (const [key, raw] of Object.entries(manifest as Record<string, unknown>)) {
        const rel = assertSafeEntryPath(key);
        const isConfig = CONFIG_FILES.has(rel);
        if (!isConfig && !rel.startsWith("w6w/")) continue; // ignored, never fetched
        assertNoNodeModules(rel);
        const e = raw as Partial<ManifestEntry> | null;
        if (
          !e || typeof e.size !== "number" || !Number.isSafeInteger(e.size) || e.size < 0 ||
          typeof e.checksum !== "string" || !/^sha256-[0-9a-f]{64}$/.test(e.checksum)
        ) {
          throw new SourceError(
            "bad_package",
            `${label}@${version} has a malformed manifest entry`,
          );
        }
        wanted.push([rel, e as ManifestEntry]);
      }
      let total = 0;
      for (const [, e] of wanted) total += e.size;
      if (opts.maxBytes !== undefined && total > opts.maxBytes) {
        throw new SourceError("too_large", `${label}@${version} exceeds maxBytes`);
      }

      const cacheDir = resolvePath(opts.cacheDir ?? defaultCacheDir());
      const originSeg = (origin + baseUrl.pathname.replace(/\/+$/, "")).replace(/[^\w.-]/g, "_");
      const key = [classSegment("jsr", cls), originSeg, ...pref.name.split("/"), version]
        .map((s) => s.replace(/[^\w.-]/g, "_"));
      const dest = join(cacheDir, ...key);
      if (
        key.some((s) => s === "" || s === "." || s === "..") || !isStrictlyInside(cacheDir, dest)
      ) {
        throw new SourceError("unsafe_cache_path", "Cache key escapes the cache directory");
      }
      if (opts.force) await Deno.remove(dest, { recursive: true }).catch(() => {});
      else if ((await Deno.stat(dest).catch(() => null))?.isDirectory) {
        return { dir: dest, revision: version };
      }

      const staging = `${dest}.tmp-${crypto.randomUUID()}`;
      await Deno.mkdir(staging, { recursive: true });
      try {
        let sum = 0;
        let sawConfig = false;
        for (const [rel, e] of wanted) {
          const url = `${pkgUrl}/${encodeURIComponent(version)}/${
            rel.split("/").map(encodeURIComponent).join("/")
          }`;
          const res = await fetchOnOrigin(url, origin, { headers, signal: opts.signal });
          if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            throw httpFailure(cls, "jsr", res.status, res.headers, label);
          }
          const bytes = await readBounded(res, e.size, `jsr file ${rel}`);
          sum += bytes.length;
          if (opts.maxBytes !== undefined && sum > opts.maxBytes) {
            throw new SourceError("too_large", `${label}@${version} exceeds maxBytes`);
          }
          const digest = hex(
            await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
          );
          if (bytes.length !== e.size || `sha256-${digest}` !== e.checksum) {
            throw new SourceError(
              "integrity_mismatch",
              `${label}@${version}: ${rel} failed verification`,
            );
          }
          if (CONFIG_FILES.has(rel)) {
            sawConfig = true;
            let cfg: unknown;
            try {
              cfg = parseJsonc(new TextDecoder().decode(bytes));
            } catch {
              throw new SourceError("bad_package", `${label}@${version}: ${rel} is not valid JSON`);
            }
            if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
              assertNoPackageImports(cfg as Record<string, unknown>);
            }
          }
          const out = join(staging, ...rel.split("/"));
          if (!isStrictlyInside(staging, out)) {
            throw new SourceError("unsafe_entry", "Unsafe package entry path");
          }
          await Deno.mkdir(dirname(out), { recursive: true });
          await Deno.writeFile(out, bytes);
        }
        if (!sawConfig) {
          throw new SourceError("bad_package", `${label}@${version} has no root config`);
        }
        await Deno.rename(staging, dest).catch(async (err) => {
          const ok = await Deno.stat(dest).then((s) => s.isDirectory).catch(() => false);
          if (!ok) throw err;
        });
      } finally {
        await Deno.remove(staging, { recursive: true }).catch(() => {});
      }
      return { dir: dest, revision: version };
    } catch (e) {
      if (isAbortFallout(e, opts.signal)) throw abortedError();
      throw e;
    }
  },
};
