/**
 * App loader. Takes a local directory (already fetched — cloning from GitHub is
 * a wrapper concern) and produces a `LoadedApp`: the parsed manifest plus the
 * Actions and Auth methods it references, with hook paths resolved to absolute.
 */
import { dirname, isAbsolute, join, resolve } from "jsr:@std/path@^1.0.0";
import type { Action, AppManifest, Auth } from "@w6w/types";
import { LoadError } from "./errors.ts";

export interface LoadedAction {
  action: Action;
  /** Absolute path to the `execute` hook module. */
  executePath: string;
  /** Absolute directory of the action manifest (root for its relative hook paths). */
  baseDir: string;
}

export interface LoadedAuth {
  auth: Auth;
  /** The manifest-relative path listed in `app.auth`; matches `Connection.auth`. */
  ref: string;
  /** Absolute directory of the auth manifest (root for its relative hook paths). */
  baseDir: string;
  /** Lifecycle hook module paths, resolved to absolute. */
  hooks: {
    preflight?: string;
    exchange?: string;
    test?: string;
    afterConnect?: string;
    sign?: string;
    refresh?: string;
    revoke?: string;
  };
}

export interface LoadedApp {
  /** Absolute app root directory. */
  dir: string;
  manifest: AppManifest;
  actions: Map<string, LoadedAction>;
  auths: LoadedAuth[];
  /** Hostnames hooks may reach, host-enforced: `manifest.network.allow` plus OAuth endpoint hosts. */
  netAllowlist: string[];
}

interface PackageJson {
  name?: string;
  version?: string;
  w6w?: { manifest?: string };
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

function resolveAuthHooks(baseDir: string, auth: Auth): LoadedAuth["hooks"] {
  const h = auth.hooks ?? ({} as NonNullable<Auth["hooks"]>);
  const resolved: LoadedAuth["hooks"] = {};
  for (const kind of ["preflight", "exchange", "test", "afterConnect", "sign", "refresh", "revoke"] as const) {
    const ref = h[kind];
    if (ref) resolved[kind] = resolveRef(baseDir, ref);
  }
  return resolved;
}

/**
 * Load an app from a local directory.
 *
 * The manifest entry point is `package.json`'s `w6w.manifest` field, defaulting
 * to `app.json`. The manifest's `actions`/`auth` path lists are resolved
 * relative to the manifest file; each Action's `execute` is resolved relative
 * to that Action's manifest file.
 */
export async function loadApp(dir: string): Promise<LoadedApp> {
  const root = resolve(dir);

  let manifestRel = "app.json";
  try {
    const pkg = await readJson<PackageJson>(join(root, "package.json"), "missing_package_json");
    if (pkg.w6w?.manifest) manifestRel = pkg.w6w.manifest;
  } catch (e) {
    // package.json is the documented entry point, but fall back to a bare
    // app.json so a manifest-only fixture still loads.
    if ((e as LoadError).code !== "missing_package_json") throw e;
  }

  const manifestPath = resolveRef(root, manifestRel);
  const manifestDir = dirname(manifestPath);
  const manifest = await readJson<AppManifest>(manifestPath, "missing_manifest");

  if (!manifest.id) throw new LoadError("invalid_manifest", "App manifest is missing `id`.");

  const auths: LoadedAuth[] = [];
  for (const ref of manifest.auth ?? []) {
    const authPath = resolveRef(manifestDir, ref);
    const auth = await readJson<Auth>(authPath, "missing_auth");
    const baseDir = dirname(authPath);
    auths.push({ auth, ref, baseDir, hooks: resolveAuthHooks(baseDir, auth) });
  }

  const actions = new Map<string, LoadedAction>();
  for (const ref of manifest.actions ?? []) {
    const actionPath = resolveRef(manifestDir, ref);
    const action = await readJson<Action>(actionPath, "missing_action");
    if (!action.key) throw new LoadError("invalid_action", `Action at ${ref} is missing \`key\`.`);
    if (!action.execute) {
      throw new LoadError("invalid_action", `Action "${action.key}" is missing \`execute\`.`);
    }
    const baseDir = dirname(actionPath);
    actions.set(action.key, {
      action,
      executePath: resolveRef(baseDir, action.execute),
      baseDir,
    });
  }

  return { dir: root, manifest, actions, auths, netAllowlist: computeAllowlist(manifest, auths) };
}
