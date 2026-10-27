/**
 * `google-service-account.v1` — a pure, stateless, host-side provider (D-A1).
 *
 * The only destination is {@link GOOGLE_TOKEN_ENDPOINT}, reached through the injected
 * `TokenEgress`; the key's own `token_uri` is dropped on validation and never used.
 * Scopes and delegation are read from `approved` only (D-D2). Failures are
 * `W6WError(code, "auth", <fixed message>, details)`; upstream bodies are never copied (D-C5).
 */

import { W6WError } from "@w6w/runtime";
import type {
  ApprovedBinding,
  CredentialErrorCode,
  CredentialProvider,
  DerivedToken,
  TokenEgress,
} from "@w6w/types";
import { importSigningKey, normalizePem, pkcs8Body, signJwt } from "./rs256.ts";

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export type GoogleServiceAccountSource = {
  type: "service_account";
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
  client_id?: string;
};

export interface CredentialErrorDetails {
  retryable: boolean;
  status: number | null;
  oauthError?: string;
  field?: string;
}

const MESSAGES = {
  source_not_object: "Service account key must be a JSON object.",
  wrapper_invalid: "Service account key wrapper must contain only serviceAccountKey.",
  type: "Service account key type must be service_account.",
  client_email: "Service account key requires a client_email.",
  private_key: "Service account key requires a PKCS8 private_key.",
  optional_field: "Service account key has a non-string optional field.",
  delegatedUser: "A delegated user is required for this service account.",
  key_import: "Service account private key could not be imported.",
  no_scopes: "No approved scopes for this authorization.",
  egress_failed: "Token exchange could not reach the token endpoint.",
  upstream_transient: "Token exchange failed upstream; retry later.",
  delegation: "Delegation was rejected for the requested user.",
  rejected: "Token exchange was rejected.",
  malformed: "Token exchange returned an invalid response.",
} as const;

export type CredentialMessageKey = keyof typeof MESSAGES;

/** Throw a typed credential failure with a fixed message. Never sets `cause`. */
export function fail(
  code: CredentialErrorCode,
  message: CredentialMessageKey,
  details: CredentialErrorDetails,
): never {
  throw new W6WError(code, "auth", MESSAGES[message], details);
}

function invalid(message: CredentialMessageKey, field: string): never {
  return fail("credential_invalid", message, { retryable: false, status: null, field });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseObject(v: unknown): Record<string, unknown> | null {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return isObject(v) ? v : null;
}

const OPTIONAL_KEYS = ["private_key_id", "project_id", "client_id"] as const;

export function validateSource(payload: unknown): GoogleServiceAccountSource {
  let obj = parseObject(payload);
  if (obj === null) invalid("source_not_object", "source");
  // R-1: the single-key field-value wrapper `{ serviceAccountKey: <object | JSON string> }`.
  if ("serviceAccountKey" in obj) {
    if (Object.keys(obj).length !== 1) invalid("wrapper_invalid", "serviceAccountKey");
    obj = parseObject(obj.serviceAccountKey);
    if (obj === null) invalid("source_not_object", "serviceAccountKey");
  }
  if (obj.type !== "service_account") invalid("type", "type");
  const email = obj.client_email;
  if (typeof email !== "string" || email.trim() === "") invalid("client_email", "client_email");
  const rawKey = obj.private_key;
  if (typeof rawKey !== "string") invalid("private_key", "private_key");
  const key = normalizePem(rawKey);
  if (!key.includes("BEGIN PRIVATE KEY") || pkcs8Body(key) === null) {
    invalid("private_key", "private_key");
  }
  const out: GoogleServiceAccountSource = {
    type: "service_account",
    client_email: email,
    private_key: key,
  };
  for (const k of OPTIONAL_KEYS) {
    if (!(k in obj) || obj[k] === undefined) continue;
    const v = obj[k];
    if (typeof v !== "string") invalid("optional_field", k);
    out[k] = v;
  }
  return out;
}

const DISPLAY_KEYS = ["client_email", "private_key_id", "client_id", "project_id"] as const;

export function displayOf(source: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObject(source)) return out;
  for (const k of DISPLAY_KEYS) {
    const v = source[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

const OAUTH_ERRORS = new Set([
  "invalid_grant",
  "unauthorized_client",
  "invalid_client",
  "invalid_scope",
  "invalid_request",
  "access_denied",
  "unsupported_grant_type",
]);

async function readJson(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text());
  } catch {
    return undefined;
  }
}

async function deriveAuthorization(i: {
  source: unknown;
  binding: unknown;
  approved: ApprovedBinding;
  egress: TokenEgress;
  now?: number;
}): Promise<DerivedToken> {
  const src = validateSource(i.source);
  // Authority comes from `approved` only; `binding` never feeds the claims (D-D2).
  const scopes = i.approved.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    fail("scope_not_approved", "no_scopes", { retryable: false, status: null });
  }
  let key: CryptoKey;
  try {
    key = await importSigningKey(src.private_key);
  } catch {
    return fail("credential_invalid", "key_import", {
      retryable: false,
      status: null,
      field: "private_key",
    });
  }
  const now = i.now ?? Date.now();
  const iat = Math.floor(now / 1000);
  const sub = i.approved.delegatedUser;
  const sent = typeof sub === "string" && sub !== "";
  const header: Record<string, unknown> = { alg: "RS256", typ: "JWT" };
  if (src.private_key_id !== undefined) header.kid = src.private_key_id;
  const claims: Record<string, unknown> = {
    iss: src.client_email,
    scope: scopes.join(" "),
    aud: GOOGLE_TOKEN_ENDPOINT,
    iat,
    exp: iat + 3600,
  };
  if (sent) claims.sub = sub;
  const jwt = await signJwt(key, header, claims);

  let res: Response;
  try {
    res = await i.egress(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    });
  } catch {
    return fail("credential_invalid", "egress_failed", { retryable: true, status: null });
  }

  const status = res.status;
  if (status < 200 || status >= 300) {
    if (status === 429 || status >= 500) {
      return fail("credential_invalid", "upstream_transient", { retryable: true, status });
    }
    const body = await readJson(res);
    const err = isObject(body) ? body.error : undefined;
    const details: CredentialErrorDetails = { retryable: false, status };
    if (typeof err === "string" && OAUTH_ERRORS.has(err)) details.oauthError = err;
    if (sent && status >= 400 && (err === "unauthorized_client" || err === "invalid_grant")) {
      return fail("delegation_rejected", "delegation", details);
    }
    return fail("credential_invalid", "rejected", details);
  }

  const body = await readJson(res);
  const malformed = (): never =>
    fail("credential_invalid", "malformed", { retryable: false, status });
  if (!isObject(body)) return malformed();
  const { access_token, expires_in, token_type } = body;
  if (typeof access_token !== "string" || access_token === "") return malformed();
  if (typeof expires_in !== "number" || !Number.isFinite(expires_in) || expires_in <= 0) {
    return malformed();
  }
  if (typeof token_type !== "string" || token_type.toLowerCase() !== "bearer") return malformed();
  return { accessToken: access_token, tokenType: "Bearer", expiresAt: now + expires_in * 1000 };
}

export const googleServiceAccountV1: CredentialProvider = Object.freeze({
  contract: "google-service-account.v1",
  version: "1.0.0",
  capabilities: Object.freeze({
    handoffable: false,
    crossConnectionTokenReuse: false,
    delegation: true,
  }),
  validateSource,
  displayOf,
  deriveAuthorization,
});
