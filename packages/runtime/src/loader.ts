/**
 * App loader. Takes a local directory (already fetched — cloning from GitHub is
 * a wrapper concern) and produces a `LoadedApp`: the identity manifest (from
 * package.json) plus the behavior (actions + auth) extracted from the app's
 * entry module.
 */
import { isAbsolute, join, resolve } from "jsr:@std/path@^1.0.0";
import type {
  Action,
  AppManifest,
  Auth,
  AuthHookKind,
  Author,
  W6WPackageMetadata,
} from "@w6w/types";
import { LoadError } from "./errors.ts";
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

export interface LoadedApp {
  /** Absolute app root directory. */
  dir: string;
  /** Absolute path to the entry module. Imported in the sandbox to run any hook. */
  entryPath: string;
  manifest: AppManifest;
  actions: Map<string, LoadedAction>;
  auths: LoadedAuth[];
  /** Hostnames hooks may reach, host-enforced: `manifest.network.allow` plus OAuth endpoint hosts. */
  netAllowlist: string[];
}

interface PackageJson {
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
function manifestFromPackageJson(pkg: PackageJson): AppManifest {
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
 * Load an app from a local directory.
 *
 * Identity comes from `package.json` (the `w6w` block plus native fields), or a
 * standalone file via `w6w.manifest`. Behavior comes from the entry module
 * (`w6w.entry`, else package `main`, else `./index.ts`), imported in the sandbox
 * so its config can be extracted without running untrusted code on the host.
 */
export async function loadApp(dir: string): Promise<LoadedApp> {
  const root = resolve(dir);
  const pkg = await readJson<PackageJson>(join(root, "package.json"), "missing_package_json");

  let manifest: AppManifest;
  if (pkg.w6w?.manifest) {
    manifest = await readJson<AppManifest>(resolveRef(root, pkg.w6w.manifest), "missing_manifest");
    if (!manifest.id) throw new LoadError("invalid_manifest", "App manifest is missing `id`.");
  } else {
    manifest = manifestFromPackageJson(pkg);
  }

  const entryPath = resolveRef(root, pkg.w6w?.entry ?? pkg.main ?? "./index.ts");
  const described = await describeApp(entryPath, root);

  const actions = new Map<string, LoadedAction>();
  for (const definition of described.actions) {
    if (!definition?.key) {
      throw new LoadError("invalid_action", `An action in ${entryPath} is missing a \`key\`.`);
    }
    actions.set(definition.key, { definition });
  }

  const auths: LoadedAuth[] = described.auth.map(({ auth, hooks }) => ({
    auth,
    hooks: new Set(hooks),
  }));

  return {
    dir: root,
    entryPath,
    manifest,
    actions,
    auths,
    netAllowlist: computeAllowlist(manifest, auths),
  };
}
