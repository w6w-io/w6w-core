/**
 * Pure, host-realm helpers for the credential seam (`prepareAuthorization` in
 * runtime.ts). Nothing here imports from runtime.ts, and nothing here runs in
 * the sandbox: these are the types a host implements and the helpers a host's
 * token cache shares with core, so the cache key and the skew rule are defined
 * once.
 */
import type { Connection, ResolvedAuthorization } from "@w6w/types";

/** Why the host is asking for an authorization — lets a resolver audit or scope its answer. */
export type CredentialPurpose = "invoke" | "trigger" | "fields" | "health" | "test" | "socket";

/**
 * The host-injected owner of the credential source and its refresh. When set,
 * the runtime never reads `connection.credential` and never runs the Auth
 * `refresh` hook itself: it asks the resolver, once per preparation.
 */
export interface CredentialResolver {
  prepare(i: {
    connection: Connection;
    authKey: string;
    purpose: CredentialPurpose;
  }): Promise<ResolvedAuthorization>;
}

/**
 * The ONLY canonical scope form for cache keys and approval comparisons:
 * trim each entry, drop empty strings, dedupe, sort (default code-unit order).
 * An entry is never split on inner whitespace.
 */
export function normalizeScopes(scopes: string[]): string[] {
  const out = new Set<string>();
  for (const s of scopes) {
    const t = s.trim();
    if (t !== "") out.add(t);
  }
  return [...out].sort();
}

export interface AuthorizationCacheKeyInput {
  tenant: string;
  account: string;
  credentialId: string;
  revision: number;
  providerVersion: string;
  bindingRevision: number;
  scopes: string[];
  delegatedUser: string | null;
  audience: string | null;
}

/**
 * A stable cache key for one derived authorization. The nine fields are
 * encoded as a JSON array in a fixed order — JSON escapes every delimiter
 * inside a value, so no two distinct inputs share an encoding (a bare
 * delimiter join would let `tenant:"a|b"` collide with `account:"b|c"`).
 * Scopes are normalized first, so order and duplicates do not matter.
 */
export function authorizationCacheKey(i: AuthorizationCacheKeyInput): string {
  return JSON.stringify([
    i.tenant,
    i.account,
    i.credentialId,
    i.revision,
    i.providerVersion,
    i.bindingRevision,
    normalizeScopes(i.scopes),
    i.delegatedUser,
    i.audience,
  ]);
}

/** Refresh a token this long before it actually expires. */
export const TOKEN_SKEW_MS = 60_000;

/**
 * Is a token (expiring at `expiresAt`, epoch MILLISECONDS) due for renewal?
 * True exactly when `expiresAt - skewMs <= now`.
 */
export function isExpiring(
  expiresAt: number,
  now: number = Date.now(),
  skewMs: number = TOKEN_SKEW_MS,
): boolean {
  return expiresAt - skewMs <= now;
}
