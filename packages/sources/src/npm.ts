/**
 * `npm:` resolver. `npm:name[@range][#app-id]` → packument from the configured registry origin,
 * exact version selected, tarball fetched from that same origin, `dist.integrity` (sha512)
 * verified over the compressed bytes BEFORE extraction, dependency policy (P2) enforced.
 *
 * Never runs `npm install` or any package script, never trusts a packument URL off-origin.
 */
import { join } from "jsr:@std/path@^1.0.0";
import {
  authClassOf,
  classSegment,
  type ResolvedSource,
  type ResolveOptions,
  type Resolver,
  SourceError,
} from "./types.ts";
import { abortedError, httpFailure, isAbortFallout, resolveViaTarball } from "./tarball.ts";
import {
  assertNoDependencies,
  assertNoNodeModules,
  packageKey,
  parsePackageRef,
  selectVersion,
} from "./package-ref.ts";

const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";
const MAX_PACKUMENT_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** Registry base (origin + optional path prefix), from `W6W_NPM_REGISTRY`. No trailing slash. */
export function npmRegistryBase(): string {
  const raw = Deno.env.get("W6W_NPM_REGISTRY") || DEFAULT_NPM_REGISTRY;
  return raw.replace(/\/+$/, "");
}

/** What `resolveDetailed` returns for npm: the revision is the exact version. */
export interface NpmResolvedSource extends ResolvedSource {
  /** Deprecation message of the selected version, if the registry marks it deprecated. */
  deprecated?: string;
}

interface Packument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<
    string,
    { deprecated?: unknown; dist?: { tarball?: unknown; integrity?: unknown } }
  >;
}

function offRegistry(what: string): SourceError {
  return new SourceError("off_registry", `Refusing request outside the registry origin: ${what}`);
}

/** Fetch `url`, following only same-origin redirects. */
async function fetchOnOrigin(
  url: string,
  origin: string,
  init: RequestInit,
): Promise<Response> {
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

function authHeaders(opts: ResolveOptions): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": "w6w-sources" };
  // Fail closed on an unknown mode (authClassOf throws); only an explicit token sends one.
  if (authClassOf(opts.auth) === "token" && opts.auth?.mode === "token" && opts.auth.token) {
    headers["Authorization"] = `Bearer ${opts.auth.token}`;
  }
  return headers;
}

async function readPackument(
  base: string,
  name: string,
  headers: Record<string, string>,
  opts: ResolveOptions,
): Promise<Packument> {
  const cls = authClassOf(opts.auth);
  const url = `${base}/${name.replace("/", "%2f")}`;
  const res = await fetchOnOrigin(url, new URL(base).origin, {
    headers: { ...headers, Accept: "application/json" },
    signal: opts.signal,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw httpFailure(cls, "npm", res.status, res.headers, `${name}`);
  }
  const text = await res.text();
  if (text.length > MAX_PACKUMENT_BYTES) {
    throw new SourceError("too_large", "npm packument exceeds the size limit");
  }
  try {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== "object") throw new Error("not an object");
    return doc as Packument;
  } catch {
    throw new SourceError("fetch_failed", `npm packument for ${name} is not valid JSON`);
  }
}

async function readRootPackageJson(dir: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await Deno.readTextFile(join(dir, "package.json"));
  } catch {
    throw new SourceError("bad_package", "package has no root package.json");
  }
  try {
    const doc = JSON.parse(text);
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object");
    return doc as Record<string, unknown>;
  } catch {
    throw new SourceError("bad_package", "root package.json is not a JSON object");
  }
}

export const npmResolver: Resolver = {
  scheme: "npm",
  canResolve: (ref: string) => ref.startsWith("npm:"),
  resolve: async (ref: string, opts: ResolveOptions = {}): Promise<string> =>
    (await npmResolver.resolveDetailed!(ref, opts)).dir,

  async resolveDetailed(ref: string, opts: ResolveOptions = {}): Promise<NpmResolvedSource> {
    // Name/range validated here, before any fetch.
    const pref = parsePackageRef(ref);
    if (pref.registry !== "npm") throw new SourceError("bad_scheme", `Not an npm ref: ${ref}`);
    if (opts.signal?.aborted) throw abortedError();
    const cls = authClassOf(opts.auth);
    const base = npmRegistryBase();
    const origin = new URL(base).origin;
    const headers = authHeaders(opts);

    let version: string;
    let tarball: string;
    let integrity: string;
    let deprecated: string | undefined;
    try {
      const packument = await readPackument(base, pref.name, headers, opts);
      const versions = packument.versions ?? {};
      const info = Object.fromEntries(
        Object.entries(versions).map(([v, m]) => [
          v,
          typeof m?.deprecated === "string" && m.deprecated ? { deprecated: m.deprecated } : {},
        ]),
      );
      version = selectVersion("npm", info, pref.range, packument["dist-tags"]);
      deprecated = (info[version] as { deprecated?: string }).deprecated;
      const dist = versions[version]?.dist;
      if (typeof dist?.tarball !== "string" || !dist.tarball) {
        throw new SourceError("bad_package", `${packageKey(pref)}@${version} has no dist.tarball`);
      }
      // Never trust the packument's URL: it must name the configured registry origin.
      if (new URL(dist.tarball, base).origin !== origin) {
        throw offRegistry(new URL(dist.tarball, base).origin);
      }
      tarball = new URL(dist.tarball, base).href;
      if (typeof dist.integrity !== "string" || !/(^|\s)sha512-/.test(dist.integrity)) {
        throw new SourceError(
          "integrity_mismatch",
          `${packageKey(pref)}@${version} has no sha512 dist.integrity`,
        );
      }
      integrity = dist.integrity;
    } catch (e) {
      if (isAbortFallout(e, opts.signal)) throw abortedError();
      throw e;
    }

    const originSeg = origin.replace(/[^\w.-]/g, "_") + (new URL(base).pathname.replace(/\/+$/, "")
      .replace(/[^\w.-]/g, "_"));
    const cacheKey = [classSegment("npm", cls), originSeg, ...pref.name.split("/"), version];
    const dir = await resolveViaTarball(
      {
        cacheKey,
        url: tarball,
        headers,
        authClass: cls,
        label: "npm",
        integrity,
        allowedOrigin: origin,
        onEntry: (path) => assertNoNodeModules(path),
      },
      opts,
    );
    try {
      assertNoDependencies(await readRootPackageJson(dir));
    } catch (e) {
      // A refused package must not stay in the cache to be served as a hit next time.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      throw e;
    }
    return { dir, revision: version, ...(deprecated ? { deprecated } : {}) };
  },
};
