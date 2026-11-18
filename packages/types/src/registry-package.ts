/**
 * Built-package index (`index.json` written by `@w6w/app-build` pack mode) and the
 * parser a host uses before trusting a registry package.
 */

export interface PackIndexApp {
  id: string;
  version: string;
  execSha256: string;
  digest: string;
  digestVersion: 1 | 2;
  sourceDigest: string;
}

export interface PackIndexFailure {
  /** The pack entry's `path` (or the CLI's app-dir argument). */
  path: string;
  /** `BuildError.code`, else `"unexpected"`. */
  code: string;
  message: string;
}

/** The shape of `<outRoot>/index.json`. No absolute paths: byte-identical across out dirs. */
export interface PackIndex {
  apps: PackIndexApp[];
  failures: PackIndexFailure[];
}

/** Thrown by {@link parseRegistryPackageIndex} / {@link assertSafeEntryPath}. */
export class RegistryPackageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RegistryPackageError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

function bad(code: string, message: string): never {
  throw new RegistryPackageError(code, message);
}

/** Refuse an id/version/entry path with `/`, `\`, `..`, empty or absolute segments. */
export function assertSafeEntryPath(p: string): string {
  if (typeof p !== "string" || p === "") bad("unsafe_entry", "empty path");
  if (p.includes("\\")) bad("unsafe_entry", `backslash in path: ${JSON.stringify(p)}`);
  if (p.includes("\0")) bad("unsafe_entry", "NUL in path");
  if (p.startsWith("/")) bad("unsafe_entry", `absolute path: ${JSON.stringify(p)}`);
  for (const seg of p.split("/")) {
    if (seg === "" || seg === "." || seg === "..") {
      bad("unsafe_entry", `unsafe segment in path: ${JSON.stringify(p)}`);
    }
  }
  return p;
}

/** An id or version is ONE path segment: no separator at all. */
function assertSingleSegment(what: string, v: unknown): string {
  if (typeof v !== "string") bad("invalid_index", `${what} must be a string`);
  assertSafeEntryPath(v);
  if (v.includes("/")) bad("unsafe_entry", `${what} contains '/': ${JSON.stringify(v)}`);
  if (v.includes("..")) bad("unsafe_entry", `${what} contains '..': ${JSON.stringify(v)}`);
  return v;
}

function str(what: string, v: unknown): string {
  if (typeof v !== "string" || v === "") bad("invalid_index", `${what} must be a non-empty string`);
  return v;
}

/** Parse + validate a built-package `index.json` (already JSON-decoded). */
export function parseRegistryPackageIndex(raw: unknown): PackIndex {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    bad("invalid_index", "index must be an object");
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.apps)) bad("invalid_index", "apps must be an array");
  if (!Array.isArray(o.failures)) bad("invalid_index", "failures must be an array");
  if (o.failures.length > 0) {
    bad("build_failures", `index lists ${o.failures.length} build failure(s)`);
  }
  const seen = new Set<string>();
  const apps: PackIndexApp[] = o.apps.map((a: unknown, i: number) => {
    if (typeof a !== "object" || a === null) bad("invalid_index", `apps[${i}] must be an object`);
    const r = a as Record<string, unknown>;
    const id = assertSingleSegment(`apps[${i}].id`, r.id);
    const version = assertSingleSegment(`apps[${i}].version`, r.version);
    if (seen.has(id)) bad("duplicate_id", `duplicate app id: ${id}`);
    seen.add(id);
    if (typeof r.execSha256 !== "string" || !HEX64.test(r.execSha256)) {
      bad("invalid_index", `apps[${i}].execSha256 must be 64 lowercase hex chars`);
    }
    if (r.digestVersion !== 1 && r.digestVersion !== 2) {
      bad("invalid_index", `apps[${i}].digestVersion must be 1 or 2`);
    }
    return {
      id,
      version,
      execSha256: r.execSha256,
      digest: str(`apps[${i}].digest`, r.digest),
      digestVersion: r.digestVersion,
      sourceDigest: str(`apps[${i}].sourceDigest`, r.sourceDigest),
    };
  });
  return { apps, failures: [] };
}
