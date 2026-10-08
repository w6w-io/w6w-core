/**
 * Content addressing for AppVersion. The digest is a sha-256 over the
 * canonicalized `{ manifest, actions, auth, triggers?, health?, interfaces?, exec? }`
 * produced by `@w6w/runtime.describe()` (plus, for built artifacts, the sha-256 of `app.js`).
 *
 * Canonical JSON: keys sorted at every object level; `undefined` omitted;
 * arrays in source order; numbers and strings in their JSON form. This matches
 * the spec in registry.md.
 *
 * Backward compat: `triggers`, `health`, `interfaces` and `exec` are dropped from
 * the digest input when empty or absent, so apps without them produce the same
 * byte-identical digest they did before those fields existed (digest v1).
 *
 * Pure: no filesystem, no network. Moved here from the registry so builders and
 * hosts share one implementation.
 */
import type { Action } from "./action.ts";
import type { AppManifest } from "./app.ts";
import type { Auth } from "./auth.ts";
import type { HealthCheck } from "./health.ts";
import type { InterfaceConformance } from "./interface.ts";
import type { Trigger } from "./trigger.ts";

/** The digest scheme version produced when `exec` is present (v1 = no `exec`). */
export const DIGEST_VERSION = 2;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Canonical-JSON-serialize a value: sorted keys, dropped `undefined`. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** sha-256 of raw bytes → lowercase hex. The one hex implementation. Web Crypto (Deno, browsers, Node 20+). */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** sha-256 of UTF-8 text → lowercase hex. */
export function sha256Hex(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

export interface DigestInput {
  manifest: AppManifest;
  actions: Action[];
  auth: Auth[];
  /**
   * Optional. When omitted or empty, canonicalJson drops the field so the
   * digest stays byte-identical to what a pre-Trigger-RFC registry produced.
   */
  triggers?: Trigger[];
  /**
   * Optional. When omitted or empty, canonicalJson drops the field so the
   * digest stays byte-identical to what a pre-HealthCheck registry produced.
   * Callers pass only declared + promoted checks (derived `auth:*` stripped).
   */
  health?: HealthCheck[];
  /**
   * Optional. When omitted or empty, canonicalJson drops the field so the
   * digest stays byte-identical to what a pre-Interface registry produced.
   */
  interfaces?: InterfaceConformance[];
  /**
   * Optional. The sha-256 (64 lowercase hex) of a built artifact's `app.js`.
   * When present the digest covers the code (digest v2); when absent the digest
   * is byte-identical to v1. A malformed value throws `TypeError`.
   */
  exec?: string;
}

function assertExec(exec: string | undefined): void {
  if (exec !== undefined && !(typeof exec === "string" && SHA256_HEX.test(exec))) {
    throw new TypeError("digest input `exec` must be 64 lowercase hex characters");
  }
}

/** Compute the registry's content digest for a described app. */
export async function digestDescription(input: DigestInput): Promise<string> {
  assertExec(input.exec);
  // Drop the runtime-internal `assetsRoot` (an absolute host-side path) before
  // digesting — it would otherwise make the digest depend on where the app was
  // resolved on the local filesystem. Everything else stays.
  const manifest = { ...input.manifest };
  delete (manifest as { assetsRoot?: string }).assetsRoot;
  const triggers = input.triggers && input.triggers.length > 0 ? input.triggers : undefined;
  const health = input.health && input.health.length > 0 ? input.health : undefined;
  const interfaces = input.interfaces && input.interfaces.length > 0 ? input.interfaces : undefined;
  return await sha256Hex(canonicalJson({
    manifest,
    actions: input.actions,
    auth: input.auth,
    triggers,
    health,
    interfaces,
    exec: input.exec,
  }));
}

/** `digestDescription` plus which scheme produced it: `2` iff `exec` is present, else `1`. */
export async function digestDescriptionVersioned(
  input: DigestInput,
): Promise<{ digest: string; digestVersion: 1 | 2 }> {
  const digest = await digestDescription(input);
  return { digest, digestVersion: input.exec !== undefined ? 2 : 1 };
}
