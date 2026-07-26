/**
 * Spec-rule validation over the logical model (`@w6w/types`). Distinct from the
 * loader's structural parse: this enforces the RFC rules (id reverse-DNS, semver
 * version, 1–3 categories, type enums, OAuth endpoints, …) and returns all
 * problems at once.
 *
 * A reference, hand-rolled validator until generated JSON Schema lands.
 */

export interface ValidationError {
  /** Dotted path to the offending field, e.g. `appearance.icon`. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
}

const PARAM_TYPES = [
  "string",
  "text",
  "number",
  "boolean",
  "select",
  "multiselect",
  "date",
  "datetime",
  "secret",
  "file",
  "json",
  "code",
  "group",
  "section",
  "array",
];
const ACTION_TYPES = ["read", "search", "perform"];
const HEALTH_KINDS = ["service", "credential", "quota", "dependency"];
const HEALTH_SCOPES = ["app", "connection"];
const HEALTH_CREDENTIALS = ["none", "context", "signed"];
const HEALTH_SEVERITIES = ["fatal", "degraded", "informational"];
/** Selector prefixes a `covers` entry may use, besides the bare `*`. */
const COVERS_PREFIXES = ["action", "resource", "auth", "component"];
const AUTH_TYPES = ["oauth2", "apiKey", "basic", "bearer", "custom"];

/**
 * Controlled vocabulary for App `categories`. Mirrors `rfcs/categories.md`.
 * Adding a slug here is non-breaking; renaming or removing one is breaking and
 * requires a `manifestVersion` bump.
 */
export const CATEGORIES: readonly string[] = [
  "ai",
  "analytics",
  "calendar",
  "cms",
  "communication",
  "commerce",
  "crm",
  "databases",
  "data-warehousing",
  "developer-tools",
  "devops",
  "documents",
  "email",
  "finance",
  "forms",
  "hr",
  "iot",
  "legal",
  "marketing",
  "monitoring",
  "productivity",
  "project-management",
  "search",
  "security",
  "social-media",
  "spreadsheets",
  "storage",
  "support",
  "version-control",
  "video",
  "other",
];

const CATEGORY_SET = new Set(CATEGORIES);

/**
 * Return the entries from `manifest.categories` that aren't in the controlled
 * vocabulary. Hosts that want to enforce / warn on unknown categories call this
 * alongside `validateApp` — the validator itself accepts unknown slugs, per the
 * categories RFC ("hosts MAY accept out-of-vocabulary entries").
 */
export function unknownCategories(manifest: unknown): string[] {
  if (!isObject(manifest) || !Array.isArray(manifest.categories)) return [];
  return manifest.categories.filter((c): c is string =>
    typeof c === "string" && !CATEGORY_SET.has(c)
  );
}

const RE_ID = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/; // reverse-DNS
const RE_NAME = /^[a-z0-9-]+$/; // kebab-case
const RE_KEY = /^[A-Za-z0-9_-]+$/;
const RE_SEMVER = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

class Ctx {
  readonly errors: ValidationError[] = [];

  err(path: string, message: string): void {
    this.errors.push({ path, message });
  }

  /** Require a non-empty string; returns it for further checks, else undefined. */
  reqString(v: unknown, path: string): string | undefined {
    if (typeof v !== "string" || v.length === 0) {
      this.err(path, "is required and must be a non-empty string");
      return undefined;
    }
    return v;
  }

  match(v: string | undefined, re: RegExp, path: string, hint: string): void {
    if (v !== undefined && !re.test(v)) this.err(path, `must ${hint}`);
  }

  enum(v: unknown, allowed: string[], path: string): void {
    if (typeof v !== "string" || !allowed.includes(v)) {
      this.err(path, `must be one of: ${allowed.join(", ")}`);
    }
  }

  result(): ValidationResult {
    return { ok: this.errors.length === 0, errors: this.errors };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkParam(ctx: Ctx, p: unknown, path: string): void {
  if (!isObject(p)) {
    ctx.err(path, "must be an object");
    return;
  }
  ctx.match(
    ctx.reqString(p.key, `${path}.key`),
    RE_KEY,
    `${path}.key`,
    "be alphanumeric (with - or _)",
  );
  ctx.reqString(p.label, `${path}.label`);
  ctx.enum(p.type, PARAM_TYPES, `${path}.type`);

  // A `section` is a layout-only container: it requires `section` + `children`,
  // and a `collapsible` section also requires a `title` (its <summary> heading).
  if (p.type === "section") {
    ctx.enum(p.section, ["collapsible", "group"], `${path}.section`);
    if (!Array.isArray(p.children)) ctx.err(`${path}.children`, "is required for a section");
    if (p.section === "collapsible") ctx.reqString(p.title, `${path}.title`);
  }

  // Recurse into nested params (section / group children) so their key/label/type
  // are validated too.
  if (Array.isArray(p.children)) checkParams(ctx, p.children, `${path}.children`);
}

function checkParams(ctx: Ctx, params: unknown, path: string): void {
  if (params === undefined) return;
  if (!Array.isArray(params)) {
    ctx.err(path, "must be an array");
    return;
  }
  params.forEach((p, i) => checkParam(ctx, p, `${path}[${i}]`));
}

/** Validate an Action's config (the serializable part — no `execute`). */
export function validateAction(action: unknown, path = "action"): ValidationResult {
  const ctx = new Ctx();
  validateActionInto(ctx, action, path);
  return ctx.result();
}

function validateActionInto(ctx: Ctx, action: unknown, path: string): void {
  if (!isObject(action)) {
    ctx.err(path, "must be an object");
    return;
  }
  ctx.match(
    ctx.reqString(action.key, `${path}.key`),
    RE_NAME,
    `${path}.key`,
    "be lowercase kebab-case",
  );
  ctx.enum(action.type, ACTION_TYPES, `${path}.type`);
  ctx.reqString(action.title, `${path}.title`);
  checkParams(ctx, action.params, `${path}.params`);

  // A tagged Action is projected into the health surface and invoked with `{}`,
  // so it has to be safe to call unattended.
  if (action.healthCheck !== undefined) {
    if (!isObject(action.healthCheck)) {
      ctx.err(`${path}.healthCheck`, "must be an object");
      return;
    }
    if (action.type !== "read") {
      ctx.err(`${path}.healthCheck`, "is only valid on a `read` action");
    }
    const params = Array.isArray(action.params) ? action.params : [];
    for (const [i, p] of params.entries()) {
      if (isObject(p) && p.required === true && p.default === undefined) {
        ctx.err(
          `${path}.params[${i}]`,
          "is required with no default, so this action cannot be used as a health check",
        );
      }
    }
    validateHealthCheckInto(ctx, {
      ...action.healthCheck,
      key: (action.healthCheck as Record<string, unknown>).key ?? action.key,
      title: (action.healthCheck as Record<string, unknown>).title ?? action.title,
    }, `${path}.healthCheck`);
  }
}

/**
 * Validate a Health Check's config (the serializable part — no `check` hook).
 * See rfcs/healthcheck.md.
 */
export function validateHealthCheck(check: unknown, path = "healthCheck"): ValidationResult {
  const ctx = new Ctx();
  validateHealthCheckInto(ctx, check, path);
  return ctx.result();
}

function validateHealthCheckInto(ctx: Ctx, check: unknown, path: string): void {
  if (!isObject(check)) {
    ctx.err(path, "must be an object");
    return;
  }
  const key = ctx.reqString(check.key, `${path}.key`);
  // `auth:` is reserved for checks derived from an Auth method's `test` hook.
  if (key !== undefined && key.startsWith("auth:")) {
    ctx.err(`${path}.key`, "must not use the reserved `auth:` prefix (those are derived)");
  } else {
    ctx.match(key, RE_NAME, `${path}.key`, "be lowercase kebab-case");
  }
  ctx.reqString(check.title, `${path}.title`);
  ctx.enum(check.kind, HEALTH_KINDS, `${path}.kind`);
  if (check.scope !== undefined) ctx.enum(check.scope, HEALTH_SCOPES, `${path}.scope`);
  if (check.credential !== undefined) {
    ctx.enum(check.credential, HEALTH_CREDENTIALS, `${path}.credential`);
  }
  if (check.severity !== undefined) {
    ctx.enum(check.severity, HEALTH_SEVERITIES, `${path}.severity`);
  }

  if (check.covers !== undefined) {
    if (!Array.isArray(check.covers)) {
      ctx.err(`${path}.covers`, "must be an array of selectors");
    } else {
      check.covers.forEach((c, i) => {
        if (typeof c !== "string") {
          ctx.err(`${path}.covers[${i}]`, "must be a string");
        } else if (c !== "*" && !COVERS_PREFIXES.some((p) => c.startsWith(`${p}:`))) {
          ctx.err(
            `${path}.covers[${i}]`,
            `must be "*" or one of: ${COVERS_PREFIXES.map((p) => `${p}:<id>`).join(", ")}`,
          );
        }
      });
    }
  }

  if (check.minIntervalSeconds !== undefined) {
    const n = check.minIntervalSeconds;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      ctx.err(`${path}.minIntervalSeconds`, "must be a non-negative number");
    }
  }

  // A check either probes or declares that nothing to probe exists. Never both,
  // never neither — `hasHook` is supplied by the loader, which can see the
  // function; a config-only caller passes it explicitly.
  const declaresUnavailable = check.unavailable !== undefined;
  if (declaresUnavailable) {
    if (!isObject(check.unavailable)) {
      ctx.err(`${path}.unavailable`, "must be an object");
    } else {
      ctx.reqString(check.unavailable.reason, `${path}.unavailable.reason`);
    }
    if (check.check !== undefined) {
      ctx.err(path, "declares both `unavailable` and a `check` hook — it must be exactly one");
    }
  }

  const allow = isObject(check.network) ? check.network.allow : undefined;
  if (allow !== undefined) {
    if (!Array.isArray(allow) || allow.some((h) => typeof h !== "string")) {
      ctx.err(`${path}.network.allow`, "must be an array of hostname strings");
    }
    // The security rule from the RFC: widening egress without forcing an
    // unsigned posture would hand a third-party host the user's credential.
    const posture = check.credential ?? (check.kind === "service" ? "none" : "signed");
    if (posture === "signed") {
      ctx.err(
        `${path}.network.allow`,
        'requires `credential` of "none" or "context" — a signed request must never reach a host outside the app allowlist',
      );
    }
  }
}

/** Validate an Auth method's config (no hook functions). */
export function validateAuth(auth: unknown, path = "auth"): ValidationResult {
  const ctx = new Ctx();
  validateAuthInto(ctx, auth, path);
  return ctx.result();
}

function validateAuthInto(ctx: Ctx, auth: unknown, path: string): void {
  if (!isObject(auth)) {
    ctx.err(path, "must be an object");
    return;
  }
  ctx.match(
    ctx.reqString(auth.key, `${path}.key`),
    RE_KEY,
    `${path}.key`,
    "be alphanumeric (with - or _)",
  );
  ctx.enum(auth.type, AUTH_TYPES, `${path}.type`);
  ctx.reqString(auth.displayName, `${path}.displayName`);
  checkParams(ctx, auth.fields, `${path}.fields`);

  if (auth.type === "oauth2") {
    const o = auth.oauth2;
    if (!isObject(o)) {
      ctx.err(`${path}.oauth2`, "is required for oauth2 auth");
    } else {
      checkUrl(ctx, o.authorizationUrl, `${path}.oauth2.authorizationUrl`);
      checkUrl(ctx, o.tokenUrl, `${path}.oauth2.tokenUrl`);
    }
  }
  if (auth.type === "apiKey") {
    const a = auth.apiKey;
    if (!isObject(a)) {
      ctx.err(`${path}.apiKey`, "is required for apiKey auth");
    } else {
      ctx.enum(a.in, ["header", "query", "body"], `${path}.apiKey.in`);
      ctx.reqString(a.name, `${path}.apiKey.name`);
    }
  }
}

function checkUrl(ctx: Ctx, v: unknown, path: string): void {
  const s = ctx.reqString(v, path);
  if (s === undefined) return;
  try {
    new URL(s);
  } catch {
    ctx.err(path, "must be a valid URL");
  }
}

/** Validate an App manifest (identity + presentation). */
export function validateApp(manifest: unknown): ValidationResult {
  const ctx = new Ctx();
  if (!isObject(manifest)) {
    ctx.err("", "manifest must be an object");
    return ctx.result();
  }

  ctx.reqString(manifest.manifestVersion, "manifestVersion");
  ctx.match(ctx.reqString(manifest.id, "id"), RE_ID, "id", "be reverse-DNS (e.g. com.acme.app)");
  ctx.match(ctx.reqString(manifest.name, "name"), RE_NAME, "name", "be lowercase kebab-case");
  ctx.reqString(manifest.displayName, "displayName");
  ctx.match(
    ctx.reqString(manifest.version, "version"),
    RE_SEMVER,
    "version",
    "be semver (MAJOR.MINOR.PATCH)",
  );

  const desc = ctx.reqString(manifest.description, "description");
  if (desc !== undefined && desc.length > 200) ctx.err("description", "must be <= 200 characters");

  if (!Array.isArray(manifest.categories) || manifest.categories.length < 1) {
    ctx.err("categories", "is required and must have 1–3 entries");
  } else if (manifest.categories.length > 3) {
    ctx.err("categories", "must have at most 3 entries");
  }

  if (!isObject(manifest.appearance)) {
    ctx.err("appearance", "is required");
  } else if (!isObject(manifest.appearance.icon)) {
    ctx.err("appearance.icon", "is required");
  }

  if (!isObject(manifest.author)) {
    ctx.err("author", "is required");
  } else {
    ctx.reqString(manifest.author.name, "author.name");
  }

  ctx.reqString(manifest.license, "license");

  if (manifest.network !== undefined) {
    const allow = (manifest.network as Record<string, unknown>).allow;
    if (
      allow !== undefined && (!Array.isArray(allow) || allow.some((h) => typeof h !== "string"))
    ) {
      ctx.err("network.allow", "must be an array of hostname strings");
    }
  }

  return ctx.result();
}
