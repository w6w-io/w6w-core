/**
 * App — the unit of integration: identity, presentation, and provenance.
 * See rfcs/app.md.
 */
import type { ImageObject } from "./image.ts";
import type { ActionDefinition } from "./action.ts";
import type { AuthDefinition } from "./auth.ts";

export type Maturity = "alpha" | "beta" | "stable" | "deprecated";
export type Visibility = "private" | "unlisted" | "public";

export interface Classification {
  /** Defaults to `"stable"`. */
  maturity?: Maturity;
  /** Defaults to `"public"`. */
  visibility?: Visibility;
}

export interface Appearance {
  icon: ImageObject;
  brandColor?: string;
  darkMode?: {
    icon?: ImageObject;
    brandColor?: string;
  };
}

export interface Author {
  name: string;
  email?: string;
  url?: string;
}

export interface AppManifest {
  /** Schema version this manifest targets (`"1"`, `"2"`, ...). */
  manifestVersion: string;
  /** Globally unique reverse-DNS id (`com.example.app-name`). Immutable across versions. */
  id: string;
  /** Machine-friendly short name. Lowercase, kebab-case, ASCII. */
  name: string;
  displayName: string;
  /** Semantic version of this manifest release. */
  version: string;
  classification?: Classification;
  /** One-line summary, <= 200 chars. */
  description: string;
  /** Markdown prose, inline or referenced file path. */
  longDescription?: string;
  /** 1-3 entries from the host registry's controlled vocabulary. */
  categories: string[];
  keywords?: string[];
  appearance: Appearance;
  screenshots?: ImageObject[];
  author: Author;
  publisher?: string;
  homepage?: string;
  repository?: string;
  documentation?: string;
  support?: string;
  bugs?: string;
  /** SPDX identifier. */
  license: string;
  privacyPolicy?: string;
  termsOfService?: string;
  /** BCP-47 tag. Defaults to `en`. */
  defaultLocale?: string;
  localizations?: Record<string, Partial<AppManifest>>;
  engines?: Record<string, string>;

  // NOTE: Ahead of the spec. The runtime mediates all network on behalf of an
  // app and enforces an egress allowlist host-side. Apps must declare the hosts
  // their hooks may reach. OAuth endpoint hosts are allowed implicitly.
  // Backport into the App RFC.
  /** Network egress policy. */
  network?: {
    /** Hostnames the app's hooks may reach (e.g. `"api.sendgrid.com"`). */
    allow?: string[];
  };
}

/**
 * An action of any param/output type. Each action is authored with its own
 * `ActionDefinition<Input, Output>`; the collection doesn't need that typing,
 * and execute's contravariant params make the specific types unassignable to a
 * single concrete element type.
 */
// deno-lint-ignore no-explicit-any
export type AnyActionDefinition = ActionDefinition<any, any>;

/**
 * An app's behavior, exported as the default from its entry module (`index.ts`).
 * Identity/presentation stays in package.json; this is the code half.
 *
 * ```ts
 * import sendEmail from "./actions/send-email.ts";
 * import apiKey from "./auth/api-key.ts";
 * export default { actions: [sendEmail], auth: [apiKey] } satisfies AppDefinition;
 * ```
 */
export interface AppDefinition {
  actions: AnyActionDefinition[];
  auth?: AuthDefinition[];
}

/**
 * The `w6w` block inside an app's `package.json`. This is how apps declare
 * themselves without a standalone manifest file: native package.json fields
 * (`version`, `description`, `author`, `license`, `homepage`, `repository`,
 * `bugs`, `keywords`) are reused, and everything App-specific goes here.
 *
 * Only the fields npm's schema can't express are required (`id`, `displayName`,
 * `appearance`); the rest fall back to native package.json fields or defaults.
 *
 * NOTE: ahead of the App RFC — backport alongside the other wiring fields.
 */
export type W6WPackageMetadata =
  & Partial<AppManifest>
  & Pick<AppManifest, "id" | "displayName" | "appearance">
  & {
    /** Entry module exporting the AppDefinition. Defaults to package `main`, then `./index.ts`. */
    entry?: string;
    /** Opt-in: load the identity manifest from a separate file instead of package.json. */
    manifest?: string;
  };
