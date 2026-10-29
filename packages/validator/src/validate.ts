import { AUTH_TYPES, CREDENTIAL_CONTRACT_ID_RE, isFormResolvedOptions } from "@w6w/types";

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
  /** Non-fatal findings. The key is absent when there are none. */
  warnings?: ValidationError[];
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
const HEALTH_FEED_FORMATS = ["atom", "rss", "auto"];
/** Selector prefixes a `covers` entry may use, besides the bare `*`. */
const COVERS_PREFIXES = ["action", "resource", "auth", "component"];

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
  readonly warnings: ValidationError[] = [];

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

  enum(v: unknown, allowed: readonly string[], path: string): void {
    if (typeof v !== "string" || !allowed.includes(v)) {
      this.err(path, `must be one of: ${allowed.join(", ")}`);
    }
  }

  result(): ValidationResult {
    const result: ValidationResult = { ok: this.errors.length === 0, errors: this.errors };
    if (this.warnings.length > 0) result.warnings = this.warnings;
    return result;
  }
}

function checkPorts(ctx: Ctx, ports: unknown, path: string): void {
  if (ports === undefined) return;
  if (!isObject(ports)) {
    ctx.err(path, "must be an object");
    return;
  }
  for (const side of ["in", "out"]) {
    const v = ports[side];
    if (v === undefined || v === "many") continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      ctx.err(`${path}.${side}`, 'must be an integer >= 0 or "many"');
    }
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
  if (Array.isArray(p.children)) checkParamList(ctx, p.children, `${path}.children`);
}

/** Check a form root: the structural rules, then its `when` overlays (whole-form scope). */
function checkParams(ctx: Ctx, params: unknown, path: string): void {
  if (params === undefined) return;
  checkParamList(ctx, params, path);
  for (const e of checkParamWhen(params, path)) ctx.err(e.path, e.message);
}

function checkParamList(ctx: Ctx, params: unknown, path: string): void {
  if (params === undefined) return;
  if (!Array.isArray(params)) {
    ctx.err(path, "must be an array");
    return;
  }
  params.forEach((p, i) => checkParam(ctx, p, `${path}[${i}]`));
}

/**
 * Check the `resolveFields` wiring of one Action: the hook flag and the params that opt
 * into it (`options.source: "resolveFields"`) must agree. Pure, and tolerant of malformed
 * input (the structural rules are `validateAction`'s job).
 *
 * Errors: (i) a param (any depth) opts in but the action's `resolveFields` is not `true`;
 * (ii) a `refreshOn` entry names no other param in the field's form scope;
 * (iii) a `refreshOn` entry is the field's own key.
 * Warning: (iv) `resolveFields` is `true` but no param opts in.
 *
 * Form scope mirrors `resolveParams` in the runtime: one params array, with `section`
 * children flattened into it recursively and `group` children kept as their own scope.
 */
export function checkFormResolvedFields(
  action: unknown,
  path = "action",
): { errors: ValidationError[]; warnings: ValidationError[] } {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  if (!isObject(action)) return { errors, warnings };
  const hook = action.resolveFields === true;
  let optedIn = false;

  const flatten = (
    params: unknown,
    at: string,
    out: { p: Record<string, unknown>; path: string }[],
  ) => {
    if (!Array.isArray(params)) return out;
    params.forEach((p, i) => {
      if (!isObject(p)) return;
      const here = `${at}[${i}]`;
      if (p.type === "section") flatten(p.children, `${here}.children`, out);
      else out.push({ p, path: here });
    });
    return out;
  };

  const walk = (params: unknown, at: string) => {
    const scope = flatten(params, at, []);
    const keys = new Set(scope.map((e) => e.p.key));
    for (const { p, path: here } of scope) {
      const options = p.options as Parameters<typeof isFormResolvedOptions>[0];
      if (isFormResolvedOptions(options)) {
        optedIn = true;
        if (!hook) {
          errors.push({
            path: `${here}.options.source`,
            message: 'is "resolveFields" but the action does not declare `resolveFields: true`',
          });
        }
      }
      const refreshOn = isObject(options) ? options.refreshOn : undefined;
      if (Array.isArray(refreshOn)) {
        refreshOn.forEach((k, i) => {
          const at2 = `${here}.options.refreshOn[${i}]`;
          if (k === p.key) {
            errors.push({ path: at2, message: "must not name the field itself" });
          } else if (typeof k !== "string" || !keys.has(k)) {
            errors.push({
              path: at2,
              message: `names no other param in the same form scope: ${JSON.stringify(k)}`,
            });
          }
        });
      }
      if (p.type === "group") walk(p.children, `${here}.children`);
    }
  };
  walk(action.params, `${path}.params`);

  if (hook && !optedIn) {
    warnings.push({
      path: `${path}.resolveFields`,
      message: 'is true but no param has options.source "resolveFields"',
    });
  }
  return { errors, warnings };
}

/**
 * Check the `when` overlays of a form (Param RFC, 2026-10-29 amendment). Pure and tolerant of
 * malformed input. Scope mirrors {@link checkFormResolvedFields}: `section` children are flattened
 * into the enclosing form; a `group`'s children are their own scope, with the enclosing scopes
 * visible (group-local keys first, then outward).
 */
export function checkParamWhen(params: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const err = (p: string, message: string) => errors.push({ path: p, message });

  const flatten = (
    list: unknown,
    at: string,
    out: { p: Record<string, unknown>; path: string }[],
  ) => {
    if (!Array.isArray(list)) return out;
    list.forEach((p, i) => {
      if (!isObject(p)) return;
      const here = `${at}[${i}]`;
      if (p.type === "section") flatten(p.children, `${here}.children`, out);
      else out.push({ p, path: here });
    });
    return out;
  };

  const SET_KEYS = ["label", "hint", "required", "ui", "options"];
  const ARMS = ["equals", "in", "notIn", "truthy"];

  const checkWhen = (p: Record<string, unknown>, here: string, visible: Set<unknown>) => {
    const w = `${here}.when`;
    if (p.when === undefined) return;
    if (!Array.isArray(p.when)) return err(w, "must be an array");
    p.when.forEach((e, j) => {
      const ep = `${w}[${j}]`;
      if (!isObject(e)) return err(ep, "must be an object");
      const cond = e.if;
      if (!isObject(cond)) {
        err(`${ep}.if.field`, "must be a non-empty string");
        err(`${ep}.if`, "must be an object");
      } else {
        const f = cond.field;
        if (typeof f !== "string" || f.length === 0) {
          err(`${ep}.if.field`, "must be a non-empty string");
        } else if (f === p.key) {
          err(`${ep}.if.field`, "must not name the field itself");
        } else if (!visible.has(f)) {
          err(`${ep}.if.field`, `names no param in scope: ${JSON.stringify(f)}`);
        }
        if (!ARMS.some((a) => cond[a] !== undefined)) {
          err(`${ep}.if`, "must have one of equals, in, notIn, truthy");
        }
        for (const a of ["in", "notIn"]) {
          if (cond[a] !== undefined && !Array.isArray(cond[a])) {
            err(`${ep}.if.${a}`, "must be an array");
          }
        }
        if (cond.truthy !== undefined && typeof cond.truthy !== "boolean") {
          err(`${ep}.if.truthy`, "must be a boolean");
        }
      }
      const set = e.set;
      if (!isObject(set)) return err(`${ep}.set`, "must be an object");
      for (const k of Object.keys(set)) {
        if (!SET_KEYS.includes(k)) {
          err(`${ep}.set.${k}`, `is not overlayable (allowed: ${SET_KEYS.join(", ")})`);
        } else if (["label", "hint", "ui"].includes(k) && typeof set[k] !== "string") {
          err(`${ep}.set.${k}`, "must be a string");
        } else if (k === "required" && typeof set[k] !== "boolean") {
          err(`${ep}.set.${k}`, "must be a boolean");
        }
      }
    });
  };

  const walk = (list: unknown, at: string, outer: Set<unknown>) => {
    const scope = flatten(list, at, []);
    const visible = new Set<unknown>([...outer, ...scope.map((e) => e.p.key)]);
    for (const { p, path: here } of scope) {
      checkWhen(p, here, visible);
      if (p.type === "group") walk(p.children, `${here}.children`, visible);
    }
  };
  walk(params, path, new Set());
  return errors;
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
  const resolved = checkFormResolvedFields(action, path);
  for (const e of resolved.errors) ctx.err(e.path, e.message);
  ctx.warnings.push(...resolved.warnings);

  checkPorts(ctx, action.ports, `${path}.ports`);

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

  const posture = check.credential ?? (check.kind === "service" ? "none" : "signed");

  const allow = isObject(check.network) ? check.network.allow : undefined;
  if (allow !== undefined) {
    if (!Array.isArray(allow) || allow.some((h) => typeof h !== "string")) {
      ctx.err(`${path}.network.allow`, "must be an array of hostname strings");
    }
    // The security rule from the RFC: widening egress without forcing an
    // unsigned posture would hand a third-party host the user's credential.
    if (posture === "signed") {
      ctx.err(
        `${path}.network.allow`,
        'requires `credential` of "none" or "context" — a signed request must never reach a host outside the app allowlist',
      );
    }
  }

  // A declared feed widens egress to its own host, so it carries the same
  // unsigned-posture rule as `network.allow`, for the same reason: a status
  // host is exactly the kind of host that must never see a credential.
  if (check.feed !== undefined) {
    if (!isObject(check.feed)) {
      ctx.err(`${path}.feed`, "must be an object");
    } else {
      const url = ctx.reqString(check.feed.url, `${path}.feed.url`);
      if (url !== undefined) {
        let parsed: URL | undefined;
        try {
          parsed = new URL(url);
        } catch {
          ctx.err(`${path}.feed.url`, "must be an absolute URL");
        }
        if (parsed && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          ctx.err(`${path}.feed.url`, "must be an http(s) URL");
        }
      }
      if (check.feed.format !== undefined) {
        ctx.enum(check.feed.format, HEALTH_FEED_FORMATS, `${path}.feed.format`);
      }
      if (check.feed.limit !== undefined) {
        const n = check.feed.limit;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
          ctx.err(`${path}.feed.limit`, "must be a positive integer");
        }
      }
    }
    if (posture === "signed") {
      ctx.err(
        `${path}.feed`,
        'requires `credential` of "none" or "context" — a feed is fetched unsigned, and a status host must never see a credential',
      );
    }
    // Nothing parses the feed on the App's behalf if there is no probe to hand
    // it to, and a declared absence has no probe by definition.
    if (declaresUnavailable) {
      ctx.err(
        `${path}.feed`,
        "cannot be combined with `unavailable` — there is no hook to receive it",
      );
    }
  }
}

/**
 * Validate an Auth method's config. The config carries no hook functions, so the
 * `serviceAccount` sign-hook rule reads `opts.hooks` (a described auth's hook list)
 * or `auth.sign` being a function (the AuthDefinition form).
 */
export function validateAuth(
  auth: unknown,
  path = "auth",
  opts: { hooks?: readonly string[] } = {},
): ValidationResult {
  const ctx = new Ctx();
  validateAuthInto(ctx, auth, path, opts);
  return ctx.result();
}

const OAUTH2_SETUP_HINTS = [
  "instructions",
  "clientIdHint",
  "clientSecretHint",
  "redirectUriHint",
  "extraHint",
] as const;

/** `oauth2.setup` is display-only, but a malformed block is still an error. */
function checkOAuth2Setup(ctx: Ctx, setup: unknown, path: string): void {
  if (setup === undefined) return;
  if (!isObject(setup)) {
    ctx.err(path, "must be an object");
    return;
  }
  if (setup.consoleUrl !== undefined) {
    let ok = false;
    if (typeof setup.consoleUrl === "string") {
      try {
        ok = new URL(setup.consoleUrl).protocol === "https:";
      } catch {
        // not an absolute URL
      }
    }
    if (!ok) ctx.err(`${path}.consoleUrl`, "must be an absolute https URL");
  }
  for (const k of OAUTH2_SETUP_HINTS) {
    if (setup[k] !== undefined && typeof setup[k] !== "string") {
      ctx.err(`${path}.${k}`, "must be a string");
    }
  }
  if (setup.extraTemplate !== undefined && !isObject(setup.extraTemplate)) {
    ctx.err(`${path}.extraTemplate`, "must be an object");
  }
}

/** The only keys a `serviceAccount` block may carry. Never a blocklist: imported JSON can never declare a destination. */
const SERVICE_ACCOUNT_KEYS = ["accepts", "scopes", "impersonation", "bindingFields"];

function checkServiceAccount(
  ctx: Ctx,
  auth: Record<string, unknown>,
  path: string,
  opts: { hooks?: readonly string[] },
): void {
  const sa = auth.serviceAccount;
  const p = `${path}.serviceAccount`;
  if (!isObject(sa)) {
    ctx.err(p, "is required for serviceAccount auth");
  } else {
    for (const k of Object.keys(sa)) {
      if (!SERVICE_ACCOUNT_KEYS.includes(k)) {
        ctx.err(`${p}.${k}`, `is not allowed (allowed: ${SERVICE_ACCOUNT_KEYS.join(", ")})`);
      }
    }
    if (!Array.isArray(sa.accepts) || sa.accepts.length === 0) {
      ctx.err(`${p}.accepts`, "must be a non-empty array of credential contract ids");
    } else {
      sa.accepts.forEach((a, i) => {
        if (typeof a !== "string" || !CREDENTIAL_CONTRACT_ID_RE.test(a)) {
          ctx.err(`${p}.accepts[${i}]`, "must be a credential contract id like `name.v1`");
        }
      });
    }
    if (!Array.isArray(sa.scopes) || sa.scopes.length === 0) {
      ctx.err(`${p}.scopes`, "must be a non-empty array of strings");
    } else {
      sa.scopes.forEach((x, i) => {
        if (typeof x !== "string" || x.length === 0) {
          ctx.err(`${p}.scopes[${i}]`, "must be a non-empty string");
        }
      });
    }
    ctx.enum(sa.impersonation, ["none", "optional", "required"], `${p}.impersonation`);
    checkParams(ctx, sa.bindingFields, `${p}.bindingFields`);
    if (Array.isArray(sa.bindingFields)) {
      sa.bindingFields.forEach((f, i) => {
        if (isObject(f) && f.type === "secret") {
          ctx.err(
            `${p}.bindingFields[${i}].type`,
            "must not be `secret` (binding fields are non-secret)",
          );
        }
      });
    }
  }
  if (!opts.hooks?.includes("sign") && typeof auth.sign !== "function") {
    ctx.err(`${path}.sign`, "a sign hook is required for serviceAccount auth");
  }
}

function validateAuthInto(
  ctx: Ctx,
  auth: unknown,
  path: string,
  opts: { hooks?: readonly string[] } = {},
): void {
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
      if (o.tokenAuthMethod !== undefined) {
        ctx.enum(
          o.tokenAuthMethod,
          ["client_secret_post", "client_secret_basic"],
          `${path}.oauth2.tokenAuthMethod`,
        );
      }
      if (o.tokenBodyFormat !== undefined) {
        ctx.enum(o.tokenBodyFormat, ["form", "json"], `${path}.oauth2.tokenBodyFormat`);
      }
      checkOAuth2Setup(ctx, o.setup, `${path}.oauth2.setup`);
    }
  }
  if (auth.type === "serviceAccount") checkServiceAccount(ctx, auth, path, opts);
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
const MODEL_TYPES = [
  "llm",
  "embedding",
  "reranking",
  "image-generation",
  "video-generation",
  "speech-to-text",
  "text-to-speech",
  "audio-generation",
  "moderation",
];
const MODEL_FAMILIES = ["transformer", "diffusion", "flow-matching", "other"];

function checkModelProvider(ctx: Ctx, v: unknown, path: string): void {
  if (!isObject(v)) {
    ctx.err(path, "must be an object");
    return;
  }
  for (const k of Object.keys(v)) {
    if (k !== "modelTypes" && k !== "modelFamilies") ctx.err(`${path}.${k}`, "is not a known key");
  }
  const list = (key: string, allowed: string[], required: boolean) => {
    const val = v[key];
    const p = `${path}.${key}`;
    if (val === undefined) {
      if (required) ctx.err(p, "is required");
      return;
    }
    if (!Array.isArray(val) || val.length < 1) {
      ctx.err(p, "must be a non-empty array");
      return;
    }
    const seen = new Set<unknown>();
    val.forEach((x, i) => {
      ctx.enum(x, allowed, `${p}[${i}]`);
      if (seen.has(x)) ctx.err(`${p}[${i}]`, "must not be a duplicate");
      seen.add(x);
    });
  };
  list("modelTypes", MODEL_TYPES, true);
  list("modelFamilies", MODEL_FAMILIES, false);
}

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

  checkPorts(ctx, manifest.ports, "ports");

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

  if (manifest.modelProvider !== undefined) {
    checkModelProvider(ctx, manifest.modelProvider, "modelProvider");
  }
  if (isObject(manifest.localizations)) {
    for (const [locale, entry] of Object.entries(manifest.localizations)) {
      if (isObject(entry) && "modelProvider" in entry) {
        ctx.err(
          `localizations.${locale}.modelProvider`,
          "is not localizable; declare it at the top level",
        );
      }
    }
  }

  return ctx.result();
}
