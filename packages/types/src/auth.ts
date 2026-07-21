/**
 * Auth — how a user connects their account to an App.
 * See rfcs/auth.md.
 */
import type { Param } from "./param.ts";
import type { AfterConnectHook, ExchangeHook, Hook, RefreshHook, SignHook } from "./hooks.ts";

export type AuthType =
  | "oauth2"
  | "apiKey"
  | "basic"
  | "bearer"
  | "custom"
  | "tenantAuth"
  | "jit";

export interface OAuth2Config {
  authorizationUrl: string;
  tokenUrl: string;
  refreshUrl?: string;
  revokeUrl?: string;
  scopes?: string[];
  /** Defaults to `" "`. */
  scopeSeparator?: string;
  /** Defaults to `true`. */
  pkce?: boolean;
  extraAuthParams?: Record<string, string>;
}

export interface ApiKeyConfig {
  in: "header" | "query" | "body";
  name: string;
  prefix?: string;
}

/**
 * `tenantAuth` — a credential sourced from the **tenant**, not entered by the
 * user. There is no connect flow and no user-collected `fields`: the host mints
 * the live credential from a per-tenant "app link" (see the host's tenant-auth
 * model) keyed by the acting principal's subject, and hands it to this method's
 * `sign` hook exactly like a `bearer` credential.
 *
 * This is a platform-agnostic primitive: any partner that embeds w6w as a tenant
 * can expose its own API to its users' workflows with zero per-user setup. The
 * App only *declares* it uses tenant auth; the link config + secrets live host-
 * side and never ship in the app package.
 */
export interface TenantAuthConfig {
  /**
   * Names the tenant app-link this method binds to. The host looks up
   * `tenant_app_link(tenant, link)` for the acting principal's tenant to mint
   * the credential. Defaults to the App's id when omitted.
   */
  link?: string;
  /**
   * Optional resource-naming prefix (e.g. `"urn:partner:"`) the App uses to
   * recognize/round-trip the partner's resource identifiers. Purely a
   * convention surfaced to the editor; the platform does not interpret it.
   */
  resourcePrefix?: string;
}

/**
 * `jit` (just-in-time) — like {@link TenantAuthConfig | tenantAuth}, a
 * host-sourced credential with no connect flow and no user `fields`. The
 * difference is provenance: instead of the host minting a token from a
 * per-tenant app-link, the credential **is the caller's own inbound token**
 * (the JWT the tenant minted to authenticate the request), forwarded to this
 * method's `sign` hook exactly like a `bearer` credential.
 *
 * Use it when the App's API accepts the same token the caller already presents
 * — the zero-config path: no `tenant_app_link`, no token endpoint. The token is
 * supplied fresh per request and never stored (a `jit` Connection holds only a
 * `{ via: "jit" }` reference). It is unavailable to background/scheduled runs,
 * which carry no inbound token.
 *
 * When the App's API needs a *different* audience than the caller's token, use
 * `tenantAuth` with `subject_mode = token_exchange` (RFC 8693) instead.
 */
export interface JitConfig {
  /**
   * Optional resource-naming prefix (e.g. `"urn:partner:"`), the same
   * editor-only convention as {@link TenantAuthConfig.resourcePrefix}.
   */
  resourcePrefix?: string;
}

/**
 * An Auth method's serializable configuration — its metadata minus the hook
 * functions. This is what `describe()` returns. It is the `AuthDefinition` with
 * its hooks stripped.
 *
 * NOTE: `key` is new — Auth methods used to be referenced by filename. Now that
 * they're code, a Connection references its method by `key`. Backport to the
 * Auth RFC.
 */
export interface Auth {
  /** Machine name. Unique within the App. Referenced by `Connection.auth`. */
  key: string;
  type: AuthType;
  displayName: string;
  description?: string;
  /** Template rendered with variables set by `afterConnect`, e.g. `"{{user.name}} — {{team.name}}"`. */
  connectionLabel?: string;
  /** Inputs collected from the user at connect time. */
  fields?: Param[];
  oauth2?: OAuth2Config;
  apiKey?: ApiKeyConfig;
  tenantAuth?: TenantAuthConfig;
  jit?: JitConfig;
}

/**
 * An auth module's exported shape: config and lifecycle hooks co-located, the
 * same code-first model as ActionDefinition. Only `test` is required.
 */
export interface AuthDefinition extends Auth {
  /** Setup before the user is prompted. */
  preflight?: Hook;
  /** Exchange auth code / form input for the stored opaque credential. */
  exchange?: ExchangeHook;
  /** Required. Validates the credential is live. */
  test: Hook<{ credential: unknown }, { ok: boolean; message?: string }>;
  /** Fetch display data for `connectionLabel`. */
  afterConnect?: AfterConnectHook;
  /** Inject auth into every outbound request. Only hook that reads the credential. */
  sign?: SignHook;
  /** Refresh the credential when it expires or is rejected. */
  refresh?: RefreshHook;
  /** Revoke the credential on disconnect. */
  revoke?: Hook<{ credential: unknown }, void>;
}

/** Lifecycle hook names, in lifecycle order. */
export const AUTH_HOOK_KINDS = [
  "preflight",
  "exchange",
  "test",
  "afterConnect",
  "sign",
  "refresh",
  "revoke",
] as const;

export type AuthHookKind = typeof AUTH_HOOK_KINDS[number];
