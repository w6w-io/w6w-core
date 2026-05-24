/**
 * Auth — how a user connects their account to an App.
 * See rfcs/auth.md.
 */
import type { Param } from "./param.ts";
import type { AfterConnectHook, ExchangeHook, Hook, RefreshHook, SignHook } from "./hooks.ts";

export type AuthType = "oauth2" | "apiKey" | "basic" | "bearer" | "custom";

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
