/**
 * OAuth2 refresh lifecycle — the pure half of rfcs/auth.md §Refresh lifecycle.
 *
 * The host is the ONE refresher (ADR-0003 D-C2): it refreshes on use (`isExpiring`,
 * `TOKEN_SKEW_MS`) and on a background keep-alive schedule. This module decides WHEN a
 * keep-alive refresh is due, builds the built-in `grant_type=refresh_token` request, and merges
 * the vendor's answer into the stored credential. No I/O: the host sends the request through its
 * own guarded egress and owns every write-back.
 */

/** Refresh in the background when the access token expires in less than this. */
export const KEEPALIVE_LEAD_MS = 60 * 60 * 1000;
/** Refresh at least this often even when the access token is far from expiry. */
export const KEEPALIVE_DEFAULT_MAX_IDLE_MS = 7 * 86_400_000;
/** A Connection whose refresh is failing is retried this often. */
export const KEEPALIVE_FAILURE_RETRY_MS = 60 * 60 * 1000;
/** Failing for this long → the host gives up and marks the Connection `broken`. */
export const KEEPALIVE_GIVE_UP_MS = 72 * 60 * 60 * 1000;

/**
 * True when an OAuth2 auth can be refreshed by the host: it defines a `refresh` hook, or the
 * built-in refresh is not disabled (`oauth2.builtinRefresh: false`). Any other auth type: false.
 * Whether the stored credential actually carries a refresh token is the caller's check.
 */
export function isRefreshable(
  auth: { type: string; oauth2?: { builtinRefresh?: boolean } },
  hasRefreshHook: boolean,
): boolean {
  if (auth.type !== "oauth2") return false;
  return hasRefreshHook || auth.oauth2?.builtinRefresh !== false;
}

/**
 * Longest time allowed between two refreshes: a third of the refresh token's lifetime, so a
 * sliding refresh token is renewed well before it lapses even across a failed attempt, capped at
 * {@link KEEPALIVE_DEFAULT_MAX_IDLE_MS}. A missing or non-positive TTL means "does not expire".
 */
export function keepAliveMaxIdleMs(refreshTokenTtlSeconds?: number): number {
  if (
    refreshTokenTtlSeconds === undefined || !Number.isFinite(refreshTokenTtlSeconds) ||
    refreshTokenTtlSeconds <= 0
  ) {
    return KEEPALIVE_DEFAULT_MAX_IDLE_MS;
  }
  return Math.min((refreshTokenTtlSeconds * 1000) / 3, KEEPALIVE_DEFAULT_MAX_IDLE_MS);
}

/** Everything {@link keepAliveDecision} reads. Every instant is epoch MILLISECONDS. */
export interface KeepAliveInput {
  now: number;
  /** Access-token expiry. */
  expiresAt?: number;
  /** Last successful refresh, or the original grant. */
  lastRefreshedAt?: number;
  /** Set while refreshes fail; cleared by the next success. */
  refreshFailingSince?: number;
  /** Last refresh attempt, success or failure. */
  lastAttemptAt?: number;
  refreshTokenTtlSeconds?: number;
}

export type KeepAliveDecision =
  | { due: false }
  | { due: true; reason: "expiring" | "max_idle" | "retry" }
  | { giveUp: true };

/**
 * Is a background refresh due for one Connection?
 *
 * 1. Failing for at least {@link KEEPALIVE_GIVE_UP_MS} → `giveUp` (the host marks it `broken`).
 * 2. Still failing → due (`retry`) only once {@link KEEPALIVE_FAILURE_RETRY_MS} has passed since
 *    the last attempt (or since the failure began, when no attempt time is recorded); otherwise
 *    not due — a failing Connection never retries faster than hourly, expiring or not.
 * 3. Access token expires within {@link KEEPALIVE_LEAD_MS} → due (`expiring`).
 * 4. {@link keepAliveMaxIdleMs} has passed since the last refresh, or no refresh/grant time is
 *    known at all → due (`max_idle`).
 * 5. Otherwise not due.
 */
export function keepAliveDecision(i: KeepAliveInput): KeepAliveDecision {
  if (i.refreshFailingSince !== undefined) {
    if (i.now - i.refreshFailingSince >= KEEPALIVE_GIVE_UP_MS) return { giveUp: true };
    const last = i.lastAttemptAt ?? i.refreshFailingSince;
    return i.now - last >= KEEPALIVE_FAILURE_RETRY_MS
      ? { due: true, reason: "retry" }
      : { due: false };
  }
  if (i.expiresAt !== undefined && i.expiresAt - KEEPALIVE_LEAD_MS <= i.now) {
    return { due: true, reason: "expiring" };
  }
  if (
    i.lastRefreshedAt === undefined ||
    i.lastRefreshedAt + keepAliveMaxIdleMs(i.refreshTokenTtlSeconds) <= i.now
  ) {
    return { due: true, reason: "max_idle" };
  }
  return { due: false };
}

/** The stored OAuth2 credential the built-in refresh reads and writes. */
export interface OAuthCredentialShape {
  accessToken: string;
  refreshToken?: string;
  /** Access-token expiry, epoch MILLISECONDS. */
  expiresAt?: number;
  /** Space-separated scopes, as the vendor echoed them. */
  scope?: string;
  tokenType?: string;
}

/** Inputs to {@link oauth2RefreshRequest}. */
export interface OAuth2RefreshRequestInput {
  refreshToken: string;
  /** Sent only when given; most vendors re-issue the originally granted scopes without it. */
  scope?: string;
  clientId: string;
  clientSecret?: string;
  /** `basic` = client_secret_basic, `body` = client_secret_post (or a public client). */
  clientAuth: "body" | "basic";
}

/**
 * The built-in refresh grant (RFC 6749 §6): `grant_type=refresh_token`, the refresh token, and
 * `scope` when given. Client authentication matches the code exchange the Connection was made
 * with — `basic` puts `client_id:client_secret` in an `Authorization: Basic` header, `body` puts
 * `client_id` (and `client_secret`, when there is one) in the form. A `basic` client without a
 * secret is a public client and falls back to `client_id` in the body.
 *
 * The body is form-encoded; a host whose auth declares `tokenBodyFormat: "json"` sends the same
 * parameters as a JSON object instead.
 */
export function oauth2RefreshRequest(
  i: OAuth2RefreshRequestInput,
): { headers: Record<string, string>; body: URLSearchParams } {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: i.refreshToken });
  if (i.scope) body.set("scope", i.scope);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (i.clientAuth === "basic" && i.clientSecret !== undefined && i.clientSecret !== "") {
    const bytes = new TextEncoder().encode(`${i.clientId}:${i.clientSecret}`);
    headers.authorization = `Basic ${
      btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    }`;
  } else {
    body.set("client_id", i.clientId);
    if (i.clientSecret) body.set("client_secret", i.clientSecret);
  }
  return { headers, body };
}

const OAUTH_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * A token response the built-in refresh cannot use. The message is service-authored: it names at
 * most the vendor's OAuth error CODE (`code`, only when well-formed), never vendor text.
 */
export class OAuthRefreshError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(code ? `${message} (${code})` : message);
    this.name = "OAuthRefreshError";
    if (code) this.code = code;
  }
}

function expiresInSeconds(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Merge a parsed token response into the stored credential.
 *
 * - `accessToken` is replaced; a response without one throws {@link OAuthRefreshError}.
 * - `refreshToken` is replaced when the vendor rotates it, else the old one is kept.
 * - `expiresAt` = `now + expires_in`, else `now + accessTokenTtlSeconds`, else unset (never the
 *   previous value: that instant belongs to the old token).
 * - `scope` / `tokenType` are replaced when the response carries them.
 * - Any other member of `prev` (vendor extras a hook stored) is kept untouched.
 */
export function mergeRefreshedCredential(
  prev: OAuthCredentialShape,
  res: unknown,
  opts: { now: number; accessTokenTtlSeconds?: number },
): OAuthCredentialShape {
  if (!res || typeof res !== "object" || Array.isArray(res)) {
    throw new OAuthRefreshError("oauth-refresh: token response is not an object");
  }
  const r = res as Record<string, unknown>;
  const accessToken = typeof r.access_token === "string" ? r.access_token : "";
  if (!accessToken) {
    const code = typeof r.error === "string" && OAUTH_ERROR_CODE.test(r.error)
      ? r.error
      : undefined;
    throw new OAuthRefreshError(
      r.error !== undefined
        ? "oauth-refresh: token endpoint rejected the refresh"
        : "oauth-refresh: token response missing access_token",
      code,
    );
  }
  const out: OAuthCredentialShape = { ...prev, accessToken };
  if (typeof r.refresh_token === "string" && r.refresh_token !== "") {
    out.refreshToken = r.refresh_token;
  }
  if (typeof r.scope === "string") out.scope = r.scope;
  if (typeof r.token_type === "string") out.tokenType = r.token_type;
  const ttl = expiresInSeconds(r.expires_in) ?? expiresInSeconds(opts.accessTokenTtlSeconds);
  if (ttl !== undefined) out.expiresAt = opts.now + ttl * 1000;
  else delete out.expiresAt;
  return out;
}
