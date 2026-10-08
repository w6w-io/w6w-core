/**
 * App artifact format v1 — the build output a host can run without the app's
 * source tree: `app.js` (one ESM module), an optional `app.js.map`, and this
 * manifest describing them. Pure: no filesystem, no network; the builder walks
 * the filesystem and hands bytes in.
 */
import type { Action } from "./action.ts";
import type { AppManifest } from "./app.ts";
import { AUTH_HOOK_KINDS } from "./auth.ts";
import type { Auth, AuthHookKind } from "./auth.ts";
import { sha256HexBytes } from "./digest.ts";
import type { HealthCheck } from "./health.ts";
import type { InterfaceConformance } from "./interface.ts";
import { TRIGGER_HOOK_KINDS } from "./trigger.ts";
import type { Trigger, TriggerHookKind } from "./trigger.ts";

/** One auth method's extracted config plus the names of the hooks it actually defines. */
export interface DescribedAuth {
  auth: Auth;
  hooks: AuthHookKind[];
}

/** One trigger's extracted config plus the names of the hooks it actually defines. */
export interface DescribedTrigger {
  trigger: Trigger;
  hooks: TriggerHookKind[];
}

/** A health check's config plus whether it actually carries a probe. */
export interface DescribedHealthCheck {
  check: HealthCheck;
  /** False for an `unavailable` declaration, which has nothing to run. */
  hasHook: boolean;
}

/**
 * The manifest that accompanies a built `app.js`.
 *
 * The `app.js` contract: exactly one ESM module with zero `import` / `import()`
 * (everything bundled in), whose default export is the app's `AppDefinition`.
 */
export interface AppArtifactManifest {
  /** Format version of this envelope. */
  artifactVersion: 1;
  /** The app id; always equal to `manifest.id`. */
  id: string;
  /** The app version; always equal to `manifest.version`. */
  version: string;
  /**
   * The app manifest AFTER asset inlining (icons, screenshots are data URIs).
   * Carries no `assetsRoot` — that is a host-side absolute path.
   */
  manifest: AppManifest;
  /** The app's actions as described by running the module. */
  actions: Action[];
  /** Auth methods with the hooks each defines. */
  auth: DescribedAuth[];
  /** Health checks with whether each carries a probe. */
  healthChecks: DescribedHealthCheck[];
  /** Triggers with the hooks each defines. */
  triggers: DescribedTrigger[];
  /** Interface conformance declarations. */
  interfaces: InterfaceConformance[];
  /** The `app.js` blob: sha-256 (64 lowercase hex), byte length, module format. */
  exec: { sha256: string; bytes: number; format: "esm" };
  /** The optional source map blob. Present iff `buildInfo.sourcemap`. */
  map?: { sha256: string; bytes: number };
  /** Digest of the app's source files (see {@link sourceDigestOf}). */
  sourceDigest: string;
  /** How the artifact was produced. */
  buildInfo: { builder: string; denoVersion: string; minify: boolean; sourcemap: boolean };
}

export type ParseArtifactResult =
  | { ok: true; value: AppArtifactManifest }
  | { ok: false; errors: string[] };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const TOP_KEYS = new Set([
  "artifactVersion",
  "id",
  "version",
  "manifest",
  "actions",
  "auth",
  "healthChecks",
  "triggers",
  "interfaces",
  "exec",
  "map",
  "sourceDigest",
  "buildInfo",
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Exactly-these-keys check for a nested envelope object. */
function checkKeys(o: Record<string, unknown>, path: string, keys: string[], errors: string[]) {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) errors.push(`${path}.${k}: unknown key`);
  }
  for (const k of keys) {
    if (!(k in o)) errors.push(`${path}.${k}: missing`);
  }
}

function checkBlob(v: unknown, path: string, extra: string[], errors: string[]) {
  if (!isObj(v)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  checkKeys(v, path, ["sha256", "bytes", ...extra], errors);
  if (typeof v.sha256 !== "string" || !SHA256_HEX.test(v.sha256)) {
    errors.push(`${path}.sha256: must be 64 lowercase hex characters`);
  }
  if (typeof v.bytes !== "number" || !Number.isSafeInteger(v.bytes) || v.bytes < 0) {
    errors.push(`${path}.bytes: must be a non-negative safe integer`);
  }
}

function checkHooks(v: unknown, path: string, allowed: readonly string[], errors: string[]) {
  if (!Array.isArray(v) || !v.every((h) => typeof h === "string" && allowed.includes(h))) {
    errors.push(`${path}: must be an array of known hook kinds`);
  }
}

/**
 * Parse an untrusted value as an {@link AppArtifactManifest}. Strict (unknown keys
 * are errors), total (never throws) and exhaustive (reports every problem found).
 * Nested Action / Auth bodies are shape-checked only; their full validation is the
 * validator package's job.
 */
export function parseAppArtifactManifest(value: unknown): ParseArtifactResult {
  const errors: string[] = [];
  if (!isObj(value)) return { ok: false, errors: ["artifact: must be an object"] };
  const v = value;
  for (const k of Object.keys(v)) {
    if (!TOP_KEYS.has(k)) errors.push(`${k}: unknown key`);
  }
  if (v.artifactVersion !== 1) errors.push("artifactVersion: must be 1");
  if (!nonEmpty(v.id)) errors.push("id: must be a non-empty string");
  if (!nonEmpty(v.version)) errors.push("version: must be a non-empty string");

  if (!isObj(v.manifest)) {
    errors.push("manifest: must be an object");
  } else {
    if ("assetsRoot" in v.manifest) errors.push("manifest.assetsRoot: must not be present");
    if (nonEmpty(v.id) && v.manifest.id !== v.id) errors.push("id: must equal manifest.id");
    if (nonEmpty(v.version) && v.manifest.version !== v.version) {
      errors.push("version: must equal manifest.version");
    }
  }

  if (!Array.isArray(v.actions)) {
    errors.push("actions: must be an array");
  } else {
    v.actions.forEach((a, i) => {
      if (!isObj(a) || !nonEmpty(a.key)) {
        errors.push(`actions[${i}].key: must be a non-empty string`);
      }
    });
  }

  if (!Array.isArray(v.auth)) {
    errors.push("auth: must be an array");
  } else {
    v.auth.forEach((a, i) => {
      if (!isObj(a)) return void errors.push(`auth[${i}]: must be an object`);
      checkKeys(a, `auth[${i}]`, ["auth", "hooks"], errors);
      if (!isObj(a.auth)) errors.push(`auth[${i}].auth: must be an object`);
      checkHooks(a.hooks, `auth[${i}].hooks`, AUTH_HOOK_KINDS, errors);
    });
  }

  if (!Array.isArray(v.triggers)) {
    errors.push("triggers: must be an array");
  } else {
    v.triggers.forEach((t, i) => {
      if (!isObj(t)) return void errors.push(`triggers[${i}]: must be an object`);
      checkKeys(t, `triggers[${i}]`, ["trigger", "hooks"], errors);
      if (!isObj(t.trigger) || !nonEmpty(t.trigger.key)) {
        errors.push(`triggers[${i}].trigger.key: must be a non-empty string`);
      }
      checkHooks(t.hooks, `triggers[${i}].hooks`, TRIGGER_HOOK_KINDS, errors);
    });
  }

  if (!Array.isArray(v.healthChecks)) {
    errors.push("healthChecks: must be an array");
  } else {
    v.healthChecks.forEach((h, i) => {
      if (!isObj(h)) return void errors.push(`healthChecks[${i}]: must be an object`);
      checkKeys(h, `healthChecks[${i}]`, ["check", "hasHook"], errors);
      if (!isObj(h.check) || !nonEmpty(h.check.key)) {
        errors.push(`healthChecks[${i}].check.key: must be a non-empty string`);
      }
      if (typeof h.hasHook !== "boolean") {
        errors.push(`healthChecks[${i}].hasHook: must be a boolean`);
      }
    });
  }

  if (!Array.isArray(v.interfaces)) errors.push("interfaces: must be an array");

  checkBlob(v.exec, "exec", ["format"], errors);
  if (isObj(v.exec) && v.exec.format !== "esm") errors.push('exec.format: must be "esm"');
  if ("map" in v && v.map !== undefined) checkBlob(v.map, "map", [], errors);

  if (typeof v.sourceDigest !== "string" || !SHA256_HEX.test(v.sourceDigest)) {
    errors.push("sourceDigest: must be 64 lowercase hex characters");
  }

  if (!isObj(v.buildInfo)) {
    errors.push("buildInfo: must be an object");
  } else {
    const b = v.buildInfo;
    checkKeys(b, "buildInfo", ["builder", "denoVersion", "minify", "sourcemap"], errors);
    if (!nonEmpty(b.builder)) errors.push("buildInfo.builder: must be a non-empty string");
    if (!nonEmpty(b.denoVersion)) errors.push("buildInfo.denoVersion: must be a non-empty string");
    if (typeof b.minify !== "boolean") errors.push("buildInfo.minify: must be a boolean");
    if (typeof b.sourcemap !== "boolean") {
      errors.push("buildInfo.sourcemap: must be a boolean");
    } else if (b.sourcemap !== (v.map !== undefined)) {
      errors.push("buildInfo.sourcemap: must be true iff map is present");
    }
  }

  return errors.length === 0
    ? { ok: true, value: v as unknown as AppArtifactManifest }
    : { ok: false, errors };
}

/** True iff `bytes` hash to `expected`. A malformed `expected` is `false`; never throws. */
export async function verifySha256(bytes: Uint8Array, expected: string): Promise<boolean> {
  try {
    if (typeof expected !== "string" || !SHA256_HEX.test(expected)) return false;
    return (await sha256HexBytes(bytes)) === expected;
  } catch {
    return false;
  }
}

function assertSha(sha256: string): void {
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
    throw new TypeError("sha256 must be 64 lowercase hex characters");
  }
}

/** Blob-store key of an `app.js` with this sha-256. Throws `TypeError` on a malformed sha. */
export function blobKeyExec(sha256: string): string {
  assertSha(sha256);
  return `apps/exec/${sha256}.js`;
}

/** Blob-store key of an `app.js.map` with this sha-256. Throws `TypeError` on a malformed sha. */
export function blobKeyMap(sha256: string): string {
  assertSha(sha256);
  return `apps/map/${sha256}.js.map`;
}

/**
 * Digest of a set of source files. Files are sorted by path (JS string order) and
 * each contributes `UTF-8(path) 0x00 ASCII-decimal(length) 0x00 bytes`; the
 * concatenation is sha-256 hashed. The length field keeps `(a,"bc")` distinct
 * from `(ab,"c")`. Paths must be POSIX-relative with no empty / `.` / `..`
 * segments, no `\`, and unique, else `TypeError`.
 */
export async function sourceDigestOf(
  files: { path: string; bytes: Uint8Array }[],
): Promise<string> {
  const seen = new Set<string>();
  for (const f of files) {
    const p = f.path;
    if (typeof p !== "string" || p.length === 0) throw new TypeError("source path is empty");
    if (p.startsWith("/")) throw new TypeError(`source path is absolute: ${p}`);
    if (p.includes("\\")) throw new TypeError(`source path contains a backslash: ${p}`);
    for (const seg of p.split("/")) {
      if (seg === "" || seg === "." || seg === "..") {
        throw new TypeError(`source path has an invalid segment: ${p}`);
      }
    }
    if (seen.has(p)) throw new TypeError(`duplicate source path: ${p}`);
    seen.add(p);
  }
  const enc = new TextEncoder();
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts: Uint8Array[] = [];
  for (const f of sorted) {
    parts.push(enc.encode(f.path), new Uint8Array([0]));
    parts.push(enc.encode(String(f.bytes.length)), new Uint8Array([0]), f.bytes);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.length;
  }
  return await sha256HexBytes(all);
}
