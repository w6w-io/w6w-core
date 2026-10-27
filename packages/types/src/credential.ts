/**
 * Credential — a stored, tenant-owned secret source that Connections bind to,
 * plus the provider seam that derives short-lived authorization from it.
 *
 * Types and `as const` tuples only; the few helpers below are pure string
 * functions. Runtime behaviour (resolution, providers, token stores) lives in
 * the host and in `@w6w/runtime`.
 */

/** A credential contract id: `<name>.v<N>`, e.g. `google-service-account.v1`. */
export const CREDENTIAL_CONTRACT_ID_RE = /^[a-z0-9-]+\.v[0-9]+$/;

/**
 * The contract id of a credential normalised from a pre-credential Connection:
 * one per (app, auth key). Never matches {@link CREDENTIAL_CONTRACT_ID_RE}.
 */
export function legacyContractId(appId: string, authKey: string): string {
  return `legacy:${appId}#${authKey}`;
}

/** True for every `legacy:*` contract (prefix semantics). */
export function isLegacyContractId(id: string): boolean {
  return id.startsWith("legacy:");
}

export type CredentialStatus = "active" | "disabled" | "revoked";

/** A credential as exposed to callers. There is never a payload or ciphertext member. */
export interface CredentialRecord {
  id: string;
  tenant: string;
  account: string;
  createdBy: string;
  name: string;
  contract: string;
  revision: number;
  refreshSeq: number;
  status: CredentialStatus;
  display: Record<string, string>;
  ownerConnectionId: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

/** Non-secret, per-Connection inputs that narrow how a credential is used. */
export interface ConnectionBinding {
  scopes?: string[];
  delegatedUser?: string;
  settings?: Record<string, string | number | boolean>;
}

/** The binding as approved by the host (what a derived token may actually carry). */
export interface ApprovedBinding {
  scopes: string[];
  delegatedUser: string | null;
}

/** A short-lived token derived from a credential source. */
export interface DerivedToken {
  accessToken: string;
  tokenType: "Bearer";
  /** Epoch MILLISECONDS (compare against `Date.now()`). */
  expiresAt: number;
}

/** What the host hands the runtime for one invocation. */
export type ResolvedAuthorization =
  | { kind: "none" }
  | {
    kind: "legacyOpaque";
    source: "stored" | "tenantAuth" | "jit";
    credential: unknown;
    sourceRevision: number | null;
  }
  | { kind: "derived"; token: DerivedToken; expiresAt: number; sourceRevision: number };

/** Host-injected egress for a provider's token exchange; the provider never owns a destination. */
export type TokenEgress = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<Response>;

export interface CredentialProvider {
  contract: string;
  version: string;
  capabilities: {
    handoffable: boolean;
    crossConnectionTokenReuse: boolean;
    delegation: boolean;
  };
  validateSource(payload: unknown): unknown;
  displayOf(source: unknown): Record<string, string>;
  deriveAuthorization(i: {
    source: unknown;
    binding: ConnectionBinding;
    approved: ApprovedBinding;
    egress: TokenEgress;
    now?: number;
  }): Promise<DerivedToken>;
  revoke?(i: { source: unknown; egress: TokenEgress }): Promise<void>;
}

export interface CredentialProviderRegistry {
  get(contract: string): CredentialProvider | undefined;
  contracts(): string[];
}

/** A persisted derived token. `"jit"` is unrepresentable: a JIT token is never stored. */
export interface StoredToken {
  token: DerivedToken;
  source: "provider" | "oauthRefresh" | "tenantAuth";
  sourceRevision: number;
  bindingRevision: number;
  version: number;
}

export interface TokenStore {
  get(key: string): Promise<StoredToken | null>;
  compareAndSet(key: string, expectedVersion: number, value: StoredToken): Promise<boolean>;
  lease(key: string, ttlMs: number): Promise<boolean>;
}

/** Resolution-time failure codes. Management-route codes are server-local. */
export const CREDENTIAL_ERROR_CODES = [
  "credential_disabled",
  "credential_missing",
  "credential_revoked",
  "delegation_rejected",
  "provider_unsupported",
  "scope_not_approved",
  "auth_not_found",
  "jit_unavailable_in_background",
  "credential_invalid",
] as const;

export type CredentialErrorCode = (typeof CREDENTIAL_ERROR_CODES)[number];
