/**
 * Shared grammar + policy for `npm:` / `jsr:` package refs (P1).
 */
import { maxSatisfying, parse, parseRange } from "jsr:@std/semver@^1";
import { SourceError } from "./types.ts";

export type PackageRegistry = "npm" | "jsr";

export interface PackageRef {
  registry: PackageRegistry;
  /** Full package name, e.g. `@scope/name` or `name`. */
  name: string;
  /** Requested range / tag / exact version; `undefined` = default selection. */
  range?: string;
  /** `#app-id` fragment, returned to the caller; never applied as a subpath. */
  appId?: string;
}

const bad = (msg: string): never => {
  throw new SourceError("bad_ref", msg);
};

/** Parse `npm:name[@range][#app-id]` / `jsr:@scope/name[@range][#app-id]`. */
export function parsePackageRef(ref: string): PackageRef {
  const m = /^(npm|jsr):(.*)$/s.exec(ref);
  if (!m) return bad("Package ref must start with npm: or jsr:");
  const registry = m[1] as PackageRegistry;
  let rest = m[2];
  let appId: string | undefined;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    appId = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
    if (appId === "") return bad("Empty #app-id fragment");
  }
  // The version separator is the first `@` after position 0 (position 0 is the scope marker).
  const at = rest.indexOf("@", 1);
  let name = rest;
  let range: string | undefined;
  if (at >= 0) {
    name = rest.slice(0, at);
    range = rest.slice(at + 1);
    if (range === "") return bad("Empty version range");
  }
  validatePackageName(registry, name);
  return {
    registry,
    name,
    ...(range !== undefined ? { range } : {}),
    ...(appId !== undefined ? { appId } : {}),
  };
}

/** Stable identity key `<registry>:<name>` (no range, no fragment). */
export function packageKey(ref: PackageRef): string {
  return `${ref.registry}:${ref.name}`;
}

const SEGMENT = /^[a-z0-9~][a-z0-9._~-]*$/;
const JSR_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** Validate a package name for the registry BEFORE any fetch. */
export function validatePackageName(registry: PackageRegistry, name: string): void {
  if (typeof name !== "string" || name === "") bad("Empty package name");
  if (name.length > 214) bad("Package name longer than 214 characters");
  if (name !== name.toLowerCase()) bad("Package name must be lowercase");
  const parts = name.split("/");
  const scoped = name.startsWith("@");
  if (registry === "jsr" && !scoped) bad("jsr package names must be scoped (@scope/name)");
  if (scoped ? parts.length !== 2 : parts.length !== 1) bad("Malformed package name");
  const seg = registry === "jsr" ? JSR_SEGMENT : SEGMENT;
  for (let i = 0; i < parts.length; i++) {
    const raw = i === 0 && scoped ? parts[0].slice(1) : parts[i];
    if (raw === "" || raw.startsWith(".") || raw.startsWith("_")) {
      bad("Package name must not start with '.' or '_'");
    }
    if (!seg.test(raw)) bad("Package name has characters that are not url-safe");
    if (raw === "node_modules" || raw === "favicon.ico") bad("Reserved package name");
  }
}

type VersionInfo = { yanked?: boolean; deprecated?: string };

const PRERELEASE_IN_RANGE = /\d+\.\d+\.\d+-[0-9A-Za-z]/;

function isPrerelease(v: string): boolean {
  try {
    return (parse(v).prerelease?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

function compareVersions(a: string, b: string): number {
  const x = parse(a), y = parse(b);
  for (const k of ["major", "minor", "patch"] as const) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return 0;
}

/**
 * Pick the exact version from `versions` for `range` (and optional dist-`tags`).
 * npm: absent range -> `latest` tag; jsr: highest non-yanked stable. Prereleases are excluded
 * unless the range names one; yanked (jsr) versions are never picked; deprecated npm versions
 * are allowed (the caller reports the deprecation).
 */
export function selectVersion(
  registry: PackageRegistry,
  versions: Record<string, VersionInfo> | string[],
  range?: string,
  tags?: Record<string, string>,
): string {
  const info: Record<string, VersionInfo> = Array.isArray(versions)
    ? Object.fromEntries(versions.map((v) => [v, {}]))
    : versions;
  const usable = (v: string) => !(registry === "jsr" && info[v]?.yanked);
  const all = Object.keys(info).filter((v) => {
    try {
      parse(v);
      return true;
    } catch {
      return false;
    }
  });
  const fail = (msg: string): never => {
    throw new SourceError("not_found", msg);
  };

  if (range === undefined || range === "") {
    if (registry === "npm") {
      const latest = tags?.latest;
      if (!latest || !Object.hasOwn(info, latest)) return fail("Package has no 'latest' dist-tag");
      return latest;
    }
    const stable = all.filter((v) => usable(v) && !isPrerelease(v)).sort(compareVersions);
    if (!stable.length) return fail("Package has no non-yanked stable version");
    return stable[stable.length - 1];
  }

  if (tags && Object.hasOwn(tags, range) && Object.hasOwn(info, tags[range])) {
    if (!usable(tags[range])) return fail("Tagged version is yanked");
    return tags[range];
  }
  if (Object.hasOwn(info, range)) {
    if (!usable(range)) return fail(`Version ${range} is yanked`);
    return range;
  }
  let parsed;
  try {
    parsed = parseRange(range);
  } catch {
    return bad(`Invalid version range: ${range}`);
  }
  const allowPre = PRERELEASE_IN_RANGE.test(range);
  const candidates = all.filter((v) => usable(v) && (allowPre || !isPrerelease(v)));
  const byFormat = new Map(candidates.map((v) => [formatV(parse(v)), v]));
  const best = maxSatisfying(candidates.map((v) => parse(v)), parsed);
  if (!best) return fail(`No version satisfies ${range}`);
  return byFormat.get(formatV(best)) ?? formatV(best);
}

function formatV(
  v: { major: number; minor: number; patch: number; prerelease?: unknown[]; build?: unknown[] },
): string {
  const pre = v.prerelease?.length ? `-${v.prerelease.join(".")}` : "";
  const build = v.build?.length ? `+${v.build.join(".")}` : "";
  return `${v.major}.${v.minor}.${v.patch}${pre}${build}`;
}

const DEP_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "bundledDependencies",
  "bundleDependencies",
];

/** P2 dependency policy: refuse any of the six dependency fields (even `{}`). */
export function assertNoDependencies(rootPkgJson: Record<string, unknown>): void {
  for (const f of DEP_FIELDS) {
    if (Object.hasOwn(rootPkgJson, f)) {
      throw new SourceError(
        "npm_dependencies_forbidden",
        `package.json declares '${f}'; packages must be dependency-free`,
      );
    }
  }
}

/** jsr root config: an `imports` value of `npm:`/`jsr:` is a dependency. */
export function assertNoPackageImports(config: Record<string, unknown>): void {
  const imports = config.imports;
  if (imports && typeof imports === "object") {
    for (const v of Object.values(imports as Record<string, unknown>)) {
      if (typeof v === "string" && /^\s*(npm|jsr):/.test(v)) {
        throw new SourceError(
          "npm_dependencies_forbidden",
          "root config imports an npm:/jsr: dependency",
        );
      }
    }
  }
}

/** Refuse an entry path with a `node_modules` segment (call for EVERY entry, links included). */
export function assertNoNodeModules(p: string): void {
  if (p.split(/[\\/]/).includes("node_modules")) {
    throw new SourceError("npm_dependencies_forbidden", "archive contains a node_modules entry");
  }
}

/**
 * Refuse unsafe archive / manifest entry paths (`unsafe_entry`). Strips exactly one leading `/`
 * (JSR manifest keys are rooted) and returns the relative path.
 */
export function assertSafeEntryPath(p: string): string {
  const unsafe = (): never => {
    throw new SourceError("unsafe_entry", "Unsafe package entry path");
  };
  if (typeof p !== "string") return unsafe();
  const rel = p.startsWith("/") ? p.slice(1) : p;
  if (rel === "" || rel.includes("\\") || rel.includes("\0")) return unsafe();
  if (/%(2e|2f|5c|00)/i.test(rel)) return unsafe();
  if (/^[A-Za-z]:/.test(rel)) return unsafe();
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return unsafe();
  }
  return rel;
}
