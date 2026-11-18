/**
 * Loading an app from a source DIRECTORY: reading its `package.json`, refusing npm dependencies,
 * and describing its entry module in the Deno sandbox. Deno-only (it spawns the sandbox Worker);
 * the runtime-neutral half of loading — identity, entry resolution, `loadedAppFromArtifact` —
 * lives in `loader.ts`, which `@w6w/runtime/assemble` reaches without pulling this in.
 */
import type { AppManifest } from "@w6w/types";
import { LoadError } from "./errors.ts";
import {
  type AppPackageJson,
  assembleLoadedApp,
  type LoadedApp,
  manifestFromPackageJson,
  resolveAppEntry,
  resolveRef,
} from "./loader.ts";
import { resolveSharedRoots } from "./shared.ts";
import { describeApp } from "./sandbox/run-hook.ts";
import { path } from "./node.ts";

const { join, resolve } = path;

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
  const sharedDirs = await resolveSharedRoots(root);
  const described = await describeApp(entryPath, [root, ...sharedDirs]);
  return assembleLoadedApp(described, manifest, {
    kind: "dir",
    dir: root,
    entryPath,
    ...(sharedDirs.length ? { sharedDirs } : {}),
  }, entryPath);
}
