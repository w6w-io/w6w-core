/**
 * Auth — how a user connects their account to an App.
 * See rfcs/auth.md.
 */
import type { Param } from "./param.ts";

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

/** Lifecycle hooks. Only `test` is required. */
export interface AuthHooks {
  /** Setup before the user is prompted. */
  preflight?: string;
  /** Exchange auth code / form input for the stored opaque credential. */
  exchange?: string;
  /** Required. Validates the credential is live. */
  test: string;
  /** Fetch display data for `connectionLabel`. */
  afterConnect?: string;
  /** Inject auth into every outbound request. Only place that reads the credential. */
  sign?: string;
  /** Refresh the credential when it expires or is rejected. */
  refresh?: string;
  /** Revoke the credential on disconnect. */
  revoke?: string;
}

export interface Auth {
  manifestVersion: string;
  type: AuthType;
  displayName: string;
  description?: string;
  /** Template rendered with variables set by `afterConnect`, e.g. `"{{user.name}} — {{team.name}}"`. */
  connectionLabel?: string;
  /** Inputs collected from the user at connect time. */
  fields?: Param[];
  oauth2?: OAuth2Config;
  apiKey?: ApiKeyConfig;
  hooks?: AuthHooks;
}
