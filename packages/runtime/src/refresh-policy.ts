/**
 * Credential refresh lifecycle — the pure half of rfcs/auth.md §Refresh lifecycle.
 *
 * The host is the ONE refresher (ADR-0003 D-C2): it refreshes on use (`isExpiring`,
 * `TOKEN_SKEW_MS`) and on a background keep-alive schedule, by an auth's `refresh` hook (any
 * auth with a stored credential) or by the built-in OAuth2 grant. This module decides WHEN a
 * keep-alive refresh is due, builds the built-in `grant_type=refresh_token` request, merges the
 * vendor's answer into the stored credential, and normalizes a `refresh` hook's result. No I/O:
 * the host sends the request through its own guarded egress and owns every write-back.
 */

/** Refresh in the background when the REFRESH token expires in less than this. */
export const KEEPALIVE_LEAD_MS = 60 * 60 * 1000;
/** Refresh at least this often, whatever the refresh token's lifetime. */
export const KEEPALIVE_DEFAULT_MAX_IDLE_MS = 7 * 86_400_000;
/** A Connection whose refresh is failing is retried this often. */
export const KEEPALIVE_FAILURE_RETRY_MS = 60 * 60 * 1000;
/** Failing for this long → the host gives up and marks the Connection `broken`. */
export const KEEPALIVE_GIVE_UP_MS = 72 * 60 * 60 * 1000;

/**
 * Auth types whose credential is never stored, or is derived by a host credential provider from a
 * stored key: nothing for a refresh (hook or built-in) to renew, so never refreshable.
 */
const NEVER_REFRESHABLE = new Set(["jit", "tenantAuth", "serviceAccount"]);

/**
 * True when the host can refresh an auth's stored credential: the auth defines a `refresh` hook
 * (any type with a stored credential — `oauth2`, `bearer`, `custom`, `apiKey`, `basic`), or it is
 * `oauth2` and the built-in refresh is not disabled (`oauth2.builtinRefresh: false`). `jit`,
 * `tenantAuth` and `serviceAccount`: never. Whether the stored credential actually carries a
 * refresh token (which only the built-in refresh needs) is the caller's check.
 */
export function isRefreshable(
  auth: { type: string; oauth2?: { builtinRefresh?: boolean } },
  hasRefreshHook: boolean,
): boolean {
  if (NEVER_REFRESHABLE.has(auth.type)) return false;
  if (hasRefreshHook) return true;
  return auth.type === "oauth2" && auth.oauth2?.builtinRefresh !== false;
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

/**
 * Everything {@link keepAliveDecision} reads. Every instant is epoch MILLISECONDS.
 *
 * The access token's expiry is deliberately NOT an input: keep-alive keeps the REFRESH token
 * alive. A short-lived access token is the on-use refresh's job (`isExpiring`), so an idle
 * Connection with 1 h access tokens is refreshed once per max-idle window, not every hour.
 */
export interface KeepAliveInput {
  now: number;
  /**
   * Refresh-token expiry, as the last refresh (or the connect) stated it: an OAuth2
   * `refresh_token_expires_in` (stored as {@link OAuthCredentialShape.refreshTokenExpiresAt}) or
   * a `refresh` hook's `refreshTokenExpiresAt`. Takes precedence over `refreshTokenTtlSeconds`.
   */
  refreshTokenExpiresAt?: number;
  /** Last successful refresh, or the original grant. */
  lastRefreshedAt?: number;
  /** Set while refreshes fail; cleared by the next success. */
  refreshFailingSince?: number;
  /** Last refresh attempt, success or failure. */
  lastAttemptAt?: number;
  /** The auth's declared refresh-token lifetime (auth-level `refreshTokenTtlSeconds`). */
  refreshTokenTtlSeconds?: number;
}

/**
 * - `expiring` — the refresh token expires within {@link KEEPALIVE_LEAD_MS}.
 * - `max_idle` — the longest allowed gap between refreshes has passed.
 * - `retry` — failing, and the hourly retry is due.
 * - `final_retry` — failing for {@link KEEPALIVE_GIVE_UP_MS} without an attempt since that mark
 *   (the host was down, say): one more attempt. When IT fails the host gives up at once.
 */
export type KeepAliveDecision =
  | { due: false }
  | { due: true; reason: "expiring" | "max_idle" | "retry" | "final_retry" }
  | { giveUp: true };

/**
 * The refresh token's lifetime the cadence is planned from, in ms. Precedence: the vendor's last
 * response (`refreshTokenExpiresAt − lastRefreshedAt`) > the declared `refreshTokenTtlSeconds` >
 * unknown (undefined: {@link KEEPALIVE_DEFAULT_MAX_IDLE_MS} alone applies).
 */
function refreshTokenLifetimeMs(i: KeepAliveInput): number | undefined {
  if (
    i.refreshTokenExpiresAt !== undefined && Number.isFinite(i.refreshTokenExpiresAt) &&
    i.lastRefreshedAt !== undefined && i.refreshTokenExpiresAt > i.lastRefreshedAt
  ) {
    return i.refreshTokenExpiresAt - i.lastRefreshedAt;
  }
  const s = i.refreshTokenTtlSeconds;
  return s !== undefined && Number.isFinite(s) && s > 0 ? s * 1000 : undefined;
}

/** The max idle for this input: a third of {@link refreshTokenLifetimeMs}, capped at 7 d. */
function maxIdleFor(i: KeepAliveInput): number {
  const ms = refreshTokenLifetimeMs(i);
  return ms === undefined ? KEEPALIVE_DEFAULT_MAX_IDLE_MS : keepAliveMaxIdleMs(ms / 1000);
}

/**
 * Is a background refresh due for one Connection? Keep-alive exists to keep the REFRESH token
 * alive; the access token's expiry never makes a Connection due (that is the on-use path's job).
 *
 * 1. Failing (`refreshFailingSince` set):
 *    a. for at least {@link KEEPALIVE_GIVE_UP_MS}, AND an attempt has already failed at or past
 *       that mark (`lastAttemptAt ≥ refreshFailingSince + 72 h`) → `giveUp` (the host marks it
 *       `broken`);
 *    b. for at least 72 h, but no attempt since the mark (the host was down) → due
 *       (`final_retry`): one more real attempt; if it fails, the host gives up at once;
 *    c. otherwise due (`retry`) only once {@link KEEPALIVE_FAILURE_RETRY_MS} has passed since the
 *       last attempt (or since the failure began, when no attempt time is recorded).
 * 2. The refresh token expires within {@link KEEPALIVE_LEAD_MS} → due (`expiring`).
 * 3. The max idle has passed since the last refresh, or no refresh/grant time is known at all →
 *    due (`max_idle`). Max idle = a third of the refresh token's lifetime (the vendor's last
 *    response, else the declared TTL), capped at {@link KEEPALIVE_DEFAULT_MAX_IDLE_MS}.
 * 4. Otherwise not due.
 */
export function keepAliveDecision(i: KeepAliveInput): KeepAliveDecision {
  if (i.refreshFailingSince !== undefined) {
    const last = i.lastAttemptAt ?? i.refreshFailingSince;
    if (i.now - i.refreshFailingSince >= KEEPALIVE_GIVE_UP_MS) {
      return last - i.refreshFailingSince >= KEEPALIVE_GIVE_UP_MS
        ? { giveUp: true }
        : { due: true, reason: "final_retry" };
    }
    return i.now - last >= KEEPALIVE_FAILURE_RETRY_MS
      ? { due: true, reason: "retry" }
      : { due: false };
  }
  if (
    i.refreshTokenExpiresAt !== undefined &&
    i.refreshTokenExpiresAt - KEEPALIVE_LEAD_MS <= i.now
  ) {
    return { due: true, reason: "expiring" };
  }
  if (i.lastRefreshedAt === undefined || i.lastRefreshedAt + maxIdleFor(i) <= i.now) {
    return { due: true, reason: "max_idle" };
  }
  return { due: false };
}

/**
 * The earliest instant (epoch ms) at which {@link keepAliveDecision} stops answering "not due" for
 * this input, assuming nothing else changes — when a host that schedules its sweep per Connection
 * should look at it next. It is `≤ now` when the Connection is due (or to be given up) right now.
 */
export function keepAliveNextCheckAt(i: KeepAliveInput): number {
  if (i.refreshFailingSince !== undefined) {
    const last = i.lastAttemptAt ?? i.refreshFailingSince;
    const mark = i.refreshFailingSince + KEEPALIVE_GIVE_UP_MS;
    if (last >= mark) return i.now;
    return Math.min(last + KEEPALIVE_FAILURE_RETRY_MS, mark);
  }
  if (i.lastRefreshedAt === undefined) return i.now;
  let at = i.lastRefreshedAt + maxIdleFor(i);
  if (i.refreshTokenExpiresAt !== undefined) {
    at = Math.min(at, i.refreshTokenExpiresAt - KEEPALIVE_LEAD_MS);
  }
  return at;
}

/** The stored OAuth2 credential the built-in refresh reads and writes. */
export interface OAuthCredentialShape {
  accessToken: string;
  refreshToken?: string;
  /** Access-token expiry, epoch MILLISECONDS. */
  expiresAt?: number;
  /**
   * Refresh-token expiry, epoch MILLISECONDS: `now + refresh_token_expires_in` from the token
   * response that issued (or re-confirmed) the refresh token. Unset when that response had none.
   */
  refreshTokenExpiresAt?: number;
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
 * - `refreshTokenExpiresAt` = `now + refresh_token_expires_in`, else unset: only the latest
 *   response is trusted, so the keep-alive cadence falls back to the declared TTL rather than plan
 *   from an instant that may belong to a spent token (or to a sliding one the refresh just moved).
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
  const rtTtl = expiresInSeconds(r.refresh_token_expires_in);
  if (rtTtl !== undefined) out.refreshTokenExpiresAt = opts.now + rtTtl * 1000;
  else delete out.refreshTokenExpiresAt;
  return out;
}

/** An instant given as epoch ms or an ISO 8601 string, as epoch ms; undefined when neither. */
export function instantMs(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/**
 * The host's normalization of a `refresh` hook's result (rfcs/auth.md §Which refresh runs). The
 * hook returns the COMPLETE new credential and it replaces the stored one: nothing is merged from
 * the old credential, so a hook that wants to keep a member (a non-rotating refresh token, a stored
 * login) returns it. Only the two instants the host plans from are normalized, both to epoch ms:
 *
 * - `expiresAt` — the hook's, when it gives a NEW one. When it gives none, or carries the old
 *   credential's value over unchanged (`{ ...credential, token }`), the old instant belonged to the
 *   old token: `now + accessTokenTtlSeconds` when declared, else unset (never treated as expiring).
 * - `refreshTokenExpiresAt` — the hook's, when it states one. When the refresh token rotated
 *   (`refreshToken` changed) but the expiry was carried over unchanged, it described the old token:
 *   unset, so the cadence falls back to `refreshTokenTtlSeconds`. A non-rotating refresh token keeps
 *   its expiry (an absolute lifetime does not move).
 *
 * An unparseable instant counts as absent. Every other member is returned as the hook gave it.
 */
export function normalizeHookRefreshedCredential(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  opts: { now: number; accessTokenTtlSeconds?: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...next };
  const prevExp = instantMs(prev.expiresAt);
  const exp = instantMs(next.expiresAt);
  if (exp !== undefined && exp !== prevExp) {
    out.expiresAt = exp;
  } else {
    const ttl = opts.accessTokenTtlSeconds;
    if (ttl !== undefined && Number.isFinite(ttl) && ttl > 0) out.expiresAt = opts.now + ttl * 1000;
    else delete out.expiresAt;
  }
  const rtExp = instantMs(next.refreshTokenExpiresAt);
  const rotated = next.refreshToken !== prev.refreshToken;
  if (rtExp === undefined || (rotated && rtExp === instantMs(prev.refreshTokenExpiresAt))) {
    delete out.refreshTokenExpiresAt;
  } else {
    out.refreshTokenExpiresAt = rtExp;
  }
  return out;
}
