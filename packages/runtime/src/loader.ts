/**
 * App loader. Takes a local directory (already fetched — cloning from GitHub is
 * a wrapper concern) and produces a `LoadedApp`: the identity manifest (from
 * package.json) plus the behavior (actions + auth) extracted from the app's
 * entry module.
 */
import { isAbsolute, join, resolve } from "jsr:@std/path@^1.0.0";
import type {
  Action,
  AppArtifactManifest,
  AppManifest,
  Auth,
  AuthHookKind,
  Author,
  HealthCheck,
  InterfaceConformance,
  Trigger,
  TriggerHookKind,
  W6WPackageMetadata,
} from "@w6w/types";
import { verifySha256 } from "@w6w/types";
import { LoadError } from "./errors.ts";
import type { DescribedApp } from "./sandbox/protocol.ts";
import { describeApp } from "./sandbox/run-hook.ts";

export interface LoadedAction {
  /** Serializable config extracted from the action module (no `execute`). */
  definition: Action;
}

export interface LoadedAuth {
  /** Serializable config (no hook functions). */
  auth: Auth;
  /** Which lifecycle hooks the auth module actually defines. */
  hooks: Set<AuthHookKind>;
}

export interface LoadedHealthCheck {
  /** Serializable config (no `check` function). */
  check: HealthCheck;
  /** False for an `unavailable` declaration, which has nothing to run. */
  hasHook: boolean;
  /**
   * Hosts this check's worker may reach: the app allowlist plus the check's own
   * `network.allow`. Only ever widened for an UNSIGNED check — see `healthAllowlist`.
   */
  netAllowlist: string[];
}

export interface LoadedTrigger {
  /** Serializable config (no hook functions). */
  trigger: Trigger;
  /** Which lifecycle hooks the trigger module actually defines. */
  hooks: Set<TriggerHookKind>;
}

/** An app whose code lives on disk: hooks import `entryPath`, read-scoped to `dir`. */
export interface DirCode {
  kind: "dir";
  /** Absolute app root directory. */
  dir: string;
  /** Absolute path to the entry module. Imported in the sandbox to run any hook. */
  entryPath: string;
}

/** An app built into one self-contained bundle: hooks import it from a `data:` URL, read-less. */
export interface ExecCode {
  kind: "exec";
  /** sha-256 (lowercase hex) of the UTF-8 bytes of `code`. */
  sha256: string;
  /** The bundled, import-free ES module source. */
  code: string;
}

export type AppCode = DirCode | ExecCode;

export interface LoadedApp {
  /** Where this app's code comes from; every hook spawn routes through `hookSource`. */
  code: AppCode;
  /**
   * @deprecated Read `code` instead. Kept only for consumers that predate `code`
   * (the server's asset inliner reads `loadedApp.dir` at runtime). Present ONLY on
   * dir-kind apps, as own properties equal to `code.dir` / `code.entryPath`; an
   * exec-kind app never carries them — a dir is never faked for an exec.
   */
  readonly dir?: string;
  /** @deprecated See `dir`. */
  readonly entryPath?: string;
  manifest: AppManifest;
  actions: Map<string, LoadedAction>;
  auths: LoadedAuth[];
  triggers: Map<string, LoadedTrigger>;
  /** Declared checks, checks promoted from tagged Actions, and one derived per Auth `test`. */
  healthChecks: Map<string, LoadedHealthCheck>;
  /**
   * This app's Interface conformance assertions. Unlike `healthChecks`, this is
   * a plain array: a conformance carries no hook to resolve, so there is
   * nothing to key by.
   */
  interfaces: InterfaceConformance[];
  /** Hostnames hooks may reach, host-enforced: `manifest.network.allow` plus OAuth endpoint hosts. */
  netAllowlist: string[];
}

export interface AppPackageJson {
  name?: string;
  version?: string;
  description?: string;
  keywords?: string[];
  categories?: string[];
  homepage?: string;
  license?: string;
  main?: string;
  bugs?: string | { url?: string };
  repository?: string | { url?: string };
  author?: string | Author;
  w6w?: W6WPackageMetadata;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/**
 * The one place a hook spawn learns where the app's code is. A dir app yields the
 * path + read scope; an exec app yields its code, which `run-hook.ts` turns into a
 * `data:` URL and a read-less Worker. Spread into every `runHook` call.
 */
export function hookSource(
  app: { code: AppCode },
): { entryPath: string; readScope: string } | { code: ExecCode } {
  const c = app.code;
  return c.kind === "dir" ? { entryPath: c.entryPath, readScope: c.dir } : { code: c };
}

/** Strip an npm scope: `@acme/slack` -> `slack`. */
function unscopedName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/** npm `author` may be a string `"Name <email> (url)"` or an object. */
function normalizeAuthor(author: string | Author | undefined): Author | undefined {
  if (!author) return undefined;
  if (typeof author !== "string") return author;
  const m = author.match(/^([^<(]+?)\s*(?:<([^>]+)>)?\s*(?:\(([^)]+)\))?$/);
  if (!m) return { name: author };
  return { name: m[1], ...(m[2] && { email: m[2] }), ...(m[3] && { url: m[3] }) };
}

/** npm `repository`/`bugs` may be a string or `{ url }`. */
function firstUrl(field: string | { url?: string } | undefined): string | undefined {
  if (!field) return undefined;
  return typeof field === "string" ? field : field.url;
}

/** Build an AppManifest from package.json, reusing native fields and the `w6w` block. */
export function manifestFromPackageJson(pkg: AppPackageJson): AppManifest {
  const w = pkg.w6w ?? ({} as W6WPackageMetadata);

  const require = <T>(value: T | undefined, field: string): T => {
    if (value === undefined || value === null) {
      throw new LoadError("invalid_manifest", `App is missing required field \`${field}\`.`);
    }
    return value;
  };

  return {
    manifestVersion: w.manifestVersion ?? "1",
    id: require(w.id, "w6w.id"),
    name: w.name ?? require(unscopedName(pkg.name), "name"),
    displayName: require(w.displayName, "w6w.displayName"),
    version: w.version ?? require(pkg.version, "version"),
    description: w.description ?? pkg.description ?? "",
    categories: require(w.categories ?? pkg.categories, "categories"),
    appearance: require(w.appearance, "w6w.appearance"),
    author: require(w.author ?? normalizeAuthor(pkg.author), "author"),
    license: w.license ?? require(pkg.license, "license"),
    keywords: w.keywords ?? pkg.keywords,
    homepage: w.homepage ?? pkg.homepage,
    repository: w.repository ?? firstUrl(pkg.repository),
    bugs: w.bugs ?? firstUrl(pkg.bugs),
    classification: w.classification,
    longDescription: w.longDescription,
    screenshots: w.screenshots,
    publisher: w.publisher,
    documentation: w.documentation,
    support: w.support,
    privacyPolicy: w.privacyPolicy,
    termsOfService: w.termsOfService,
    defaultLocale: w.defaultLocale,
    localizations: w.localizations,
    engines: w.engines,
    network: w.network,
    // Declarative-only (DC-5): publish-time review visibility, never read by
    // `runtime.ts` to gate anything — the real check is per-Connection, not
    // per-App. Surfaced the same way `network` is, straight off the raw
    // `w6w` block, with no derived/computed counterpart the way
    // `network.allow` gets `netAllowlist` below.
    capabilities: w.capabilities,
  };
}

async function readJson<T>(path: string, code: string): Promise<T> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    throw new LoadError(code, `Cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new LoadError("invalid_json", `Invalid JSON in ${path}: ${(e as Error).message}`);
  }
}

/** Resolve a manifest-relative path against its base directory. */
function resolveRef(baseDir: string, ref: string): string {
  return isAbsolute(ref) ? ref : resolve(baseDir, ref);
}

/** True if a `package.json` dependency field is present with at least one entry. */
function hasDeclaredDeps(deps: Record<string, string> | undefined): boolean {
  return deps !== undefined && Object.keys(deps).length > 0;
}

/**
 * Refuse an app that ships a vendored `node_modules/` tree or declares npm
 * dependencies. Both are code that never appears in the app's reviewable
 * source: `node_modules/` resolution is arbitrated by `read`, which is
 * necessarily scoped to the app's own directory, so a vendored tree gets a
 * runtime-computed `npm:` specifier to resolve even with `import:false` and
 * `net:false` both in effect. Refusing unconditionally (no allow-list, no
 * opt-in) is a deliberate decision — see HITL-1.
 */
/**
 * `node_modules/` is searched at most this many levels below the app root.
 * 12 is well past any real app's directory depth (`hello`/`sendgrid` are 2-3
 * levels deep) — it exists only so a pathological tree can't blow the stack
 * or run unbounded; hitting it without finding `node_modules` is not itself
 * a refusal.
 */
const NODE_MODULES_SEARCH_MAX_DEPTH = 12;

/**
 * True if a directory literally named `node_modules` exists anywhere under
 * `dir`, at most `NODE_MODULES_SEARCH_MAX_DEPTH` levels deep. This has to
 * search the whole app tree, not just the root: `read` is scoped to the
 * app's whole directory (`read: [opts.readScope]`, `sandbox/run-hook.ts:44`),
 * so a vendored tree anywhere under the app root sits in the same trust
 * boundary as one at the root itself — a publisher gains nothing by nesting
 * it one level down.
 *
 * A symlinked directory is never followed (a symlink loop must not hang or
 * crash the walk — it is treated as a dead end for recursion), but an entry
 * literally *named* `node_modules` still trips the refusal regardless of its
 * type, so a symlink can't be used to rename around the check.
 */
async function hasVendoredNodeModules(dir: string, depth: number): Promise<boolean> {
  if (depth > NODE_MODULES_SEARCH_MAX_DEPTH) return false;
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === "node_modules") return true;
      if (entry.isDirectory && !entry.isSymlink) {
        if (await hasVendoredNodeModules(join(dir, entry.name), depth + 1)) return true;
      }
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return false;
}

export async function assertNoNpmDependencies(root: string, pkg: AppPackageJson): Promise<void> {
  if (await hasVendoredNodeModules(root, 0)) {
    throw new LoadError(
      "npm_dependencies_forbidden",
      `App at ${root} ships a vendored \`node_modules/\` directory. A vendored dependency ` +
        "tree is code that does not appear in the app's reviewable source — remove it.",
      { dir: root, reason: "node_modules" },
    );
  }

  const offendingField = (["dependencies", "devDependencies", "optionalDependencies"] as const)
    .find((field) => hasDeclaredDeps(pkg[field]));
  if (offendingField) {
    throw new LoadError(
      "npm_dependencies_forbidden",
      `App at ${root} declares \`${offendingField}\` in package.json. npm dependencies are ` +
        "code that does not appear in the app's reviewable source — remove them.",
      { dir: root, reason: offendingField },
    );
  }
}

function computeAllowlist(manifest: AppManifest, auths: LoadedAuth[]): string[] {
  const hosts = new Set<string>(manifest.network?.allow ?? []);
  for (const { auth } of auths) {
    const urls = [
      auth.oauth2?.authorizationUrl,
      auth.oauth2?.tokenUrl,
      auth.oauth2?.refreshUrl,
      auth.oauth2?.revokeUrl,
    ];
    for (const u of urls) {
      if (!u) continue;
      try {
        hosts.add(new URL(u).hostname);
      } catch {
        // ignore malformed URLs here; validation is a separate concern
      }
    }
  }
  return [...hosts];
}

/**
 * A check derived from an Auth method's `test` hook, so every App has a
 * credential check without its publisher writing one. Reserved `auth:` key
 * prefix; validators reject a publisher using it.
 */
function derivedAuthChecks(auths: LoadedAuth[]): HealthCheck[] {
  return auths
    .filter((a) => a.hooks.has("test"))
    .map(({ auth }) => ({
      key: `auth:${auth.key}`,
      title: `${auth.displayName} credential`,
      description: `Derived from the \`${auth.key}\` auth method's \`test\` hook.`,
      kind: "credential" as const,
      scope: "connection" as const,
      credential: "signed" as const,
      covers: [`auth:${auth.key}`],
      severity: "fatal" as const,
    }));
}

/**
 * Compose the allowlist a health check's worker runs under.
 *
 * A check may name extra hosts — vendor status pages live somewhere the app's
 * own code has no business calling. Widening egress without constraining
 * signing would be a credential-exfiltration path, so the extra hosts are
 * honoured only for an unsigned posture; a `signed` check is pinned to the
 * app's own allowlist regardless of what it declared. The validator rejects
 * that combination at author time, and this is the belt to its braces.
 *
 * A declared `feed`'s host is allowed implicitly, on the same footing as the
 * extra hosts and for the same reason — it is a status host, reached unsigned.
 * Implicit rather than restated in `network.allow` because the URL already says
 * where it is, exactly as OAuth endpoint hosts are allowed without a publisher
 * naming them twice.
 */
export function healthAllowlist(appAllowlist: string[], check: HealthCheck): string[] {
  const posture = check.credential ?? (check.kind === "service" ? "none" : "signed");
  if (posture === "signed") return appAllowlist;
  const extra = [...(check.network?.allow ?? [])];
  if (check.feed?.url) {
    try {
      extra.push(new URL(check.feed.url).hostname);
    } catch {
      // A malformed feed URL is the validator's to report; widen nothing.
    }
  }
  return [...new Set([...appAllowlist, ...extra])];
}

/** The entry module of an app directory: `w6w.entry`, else package `main`, else `./index.ts`. */
export function resolveAppEntry(root: string, pkg: AppPackageJson): string {
  return resolveRef(root, pkg.w6w?.entry ?? pkg.main ?? "./index.ts");
}

/**
 * Turn a described app + identity manifest + code source into a `LoadedApp`. Shared by
 * `loadApp` (label = entry path) and `loadedAppFromArtifact` (label = `sha256:<hex>`).
 * Never mutates `described` objects it did not create: triggers are cloned before the
 * host overwrites `type`.
 */
export function assembleLoadedApp(
  described: DescribedApp,
  manifest: AppManifest,
  code: AppCode,
  label: string,
): LoadedApp {
  const actions = new Map<string, LoadedAction>();
  for (const definition of described.actions) {
    if (!definition?.key) {
      throw new LoadError("invalid_action", `An action in ${label} is missing a \`key\`.`);
    }
    actions.set(definition.key, { definition });
  }

  const auths: LoadedAuth[] = described.auth.map(({ auth, hooks }) => ({
    auth,
    hooks: new Set(hooks),
  }));

  const triggers = new Map<string, LoadedTrigger>();
  for (const { trigger: given, hooks } of described.triggers) {
    if (!given?.key) {
      throw new LoadError("invalid_trigger", `A trigger in ${label} is missing a \`key\`.`);
    }
    const trigger = { ...given };
    const declared = new Set(hooks);
    if (declared.has("onSubscribe") && !declared.has("onUnsubscribe")) {
      throw new LoadError(
        "invalid_trigger",
        `Trigger "${trigger.key}" in ${label} declares \`onSubscribe\` without \`onUnsubscribe\`: whatever is registered must be destroyable.`,
      );
    }
    if (declared.has("poll") && declared.has("onSubscribe")) {
      throw new LoadError(
        "invalid_trigger",
        `Trigger "${trigger.key}" in ${label} declares both \`poll\` and \`onSubscribe\`: a trigger is a webhook or a poll, not both.`,
      );
    }
    // Host-derived: overwrite whatever the author wrote.
    trigger.type = declared.has("poll") ? "poll" : "webhook";
    triggers.set(trigger.key, { trigger, hooks: declared });
  }

  const netAllowlist = computeAllowlist(manifest, auths);

  // One health surface regardless of authoring route: checks the entry module
  // declared (including those the worker projected from tagged Actions), plus
  // one derived per Auth `test` hook so every app has a credential check.
  const healthChecks = new Map<string, LoadedHealthCheck>();
  for (const { check, hasHook } of described.healthChecks) {
    if (!check?.key) {
      throw new LoadError(
        "invalid_health_check",
        `A health check in ${label} is missing a \`key\`.`,
      );
    }
    if (healthChecks.has(check.key)) {
      throw new LoadError(
        "invalid_health_check",
        `Duplicate health check key "${check.key}" in ${label}.`,
      );
    }
    healthChecks.set(check.key, {
      check,
      hasHook,
      netAllowlist: healthAllowlist(netAllowlist, check),
    });
  }
  for (const check of derivedAuthChecks(auths)) {
    // A publisher cannot occupy the reserved prefix (the validator rejects it),
    // so a collision here would be a loader bug rather than an authoring one.
    if (!healthChecks.has(check.key)) {
      healthChecks.set(check.key, { check, hasHook: true, netAllowlist });
    }
  }

  return {
    code,
    ...(code.kind === "dir" ? { dir: code.dir, entryPath: code.entryPath } : {}),
    manifest,
    actions,
    auths,
    triggers,
    healthChecks,
    interfaces: described.interfaces,
    netAllowlist,
  };
}

/**
 * Load an app from a local directory.
 *
 * Identity comes from `package.json` (the `w6w` block plus native fields), or a
 * standalone file via `w6w.manifest`. Behavior comes from the entry module
 * (`w6w.entry`, else package `main`, else `./index.ts`), imported in the sandbox
 * so its config can be extracted without running untrusted code on the host.
 */
export async function loadApp(dir: string): Promise<LoadedApp> {
  const root = resolve(dir);
  const pkg = await readJson<AppPackageJson>(join(root, "package.json"), "missing_package_json");
  await assertNoNpmDependencies(root, pkg);

  let manifest: AppManifest;
  if (pkg.w6w?.manifest) {
    manifest = await readJson<AppManifest>(resolveRef(root, pkg.w6w.manifest), "missing_manifest");
    if (!manifest.id) throw new LoadError("invalid_manifest", "App manifest is missing `id`.");
  } else {
    manifest = manifestFromPackageJson(pkg);
  }

  const entryPath = resolveAppEntry(root, pkg);
  const described = await describeApp(entryPath, root);
  return assembleLoadedApp(described, manifest, { kind: "dir", dir: root, entryPath }, entryPath);
}

/**
 * Build a `LoadedApp` from a stored artifact manifest + its exec bundle, with no Worker:
 * definitions come from the STORED manifest, and the code is only verified (sha-256 of its
 * UTF-8 bytes) so a `LoadedApp` can never carry an identity its code does not have.
 * The input manifest is not mutated.
 */
export async function loadedAppFromArtifact(
  manifest: AppArtifactManifest,
  code: string,
): Promise<LoadedApp> {
  const sha256 = manifest.exec.sha256;
  if (!(await verifySha256(new TextEncoder().encode(code), sha256))) {
    throw new LoadError(
      "exec_sha_mismatch",
      `Exec code does not match the manifest's sha256 (${sha256}).`,
      { sha256 },
    );
  }
  const clone = structuredClone(manifest);
  const described: DescribedApp = {
    actions: clone.actions,
    auth: clone.auth,
    triggers: clone.triggers,
    healthChecks: clone.healthChecks,
    interfaces: clone.interfaces,
  };
  return assembleLoadedApp(
    described,
    clone.manifest,
    { kind: "exec", sha256, code },
    `sha256:${sha256}`,
  );
}
