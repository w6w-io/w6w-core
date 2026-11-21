import { assertNoNpmDependencies, describeExec, LoadError, resolveAppEntry } from "@w6w/runtime";
import { BuildError, isInside } from "./errors.ts";
import { assertGraph, resolveTypesRoot, runDeno } from "./graph.ts";
import { BUILDER, type BuildResult, packageBuiltApp, readAppIdentity } from "./package.ts";
import { materialiseRegistryModules, readRegistryMap, type Resolution } from "./registry.ts";
import { resolveSharedRoots } from "./shared.ts";
import { path } from "./node.ts";

const { join, relative, resolve } = path;

export { MAX_APP_ASSET_BYTES, MAX_ASSET_BYTES } from "./package.ts";
export type { BuildResult, OutputWarningCounts } from "./package.ts";

export interface BuildOptions {
  /** Minify `app.js`. Default `true`. */
  minify?: boolean;
  /** Also emit `app.js.map` (sources rewritten app-relative). Default `false`. */
  sourcemap?: boolean;
  /** Per-asset byte cap. Default {@link MAX_ASSET_BYTES}. */
  maxAssetBytes?: number;
  /** Per-app inlined-asset byte cap. Default {@link MAX_APP_ASSET_BYTES}. */
  maxAppAssetBytes?: number;
  /** How `@w6w/*` imports resolve. Default `"sibling"`. */
  resolution?: Resolution;
}

const posix = (p: string) => p.split("\\").join("/");

/** Build `app.js` into `tmp` and return its bytes (and the rewritten map text, if any). */
async function bundle(
  realAppDir: string,
  appDir: string,
  entryRel: string,
  tmp: string,
  minify: boolean,
  sourcemap: boolean,
  configFile: string,
): Promise<{ js: Uint8Array; map?: string }> {
  const out = join(tmp, "app.js");
  const args = ["bundle", "-q", "--no-remote", "--no-npm", "--no-lock", "--config", configFile];
  if (minify) args.push("--minify");
  if (sourcemap) args.push("--sourcemap=external");
  args.push("-o", out, entryRel);
  const r = await runDeno(args, realAppDir);
  if (r.code !== 0) {
    throw new BuildError(
      "bundle_failed",
      `deno bundle failed: ${r.stderr.trim().slice(0, 400)}`,
      appDir,
    );
  }
  const js = await Deno.readFile(out);

  // The bundle must be one module with no imports left.
  const info = await runDeno(["info", "--json", "--no-config", "--no-lock", out], tmp);
  let modules: { dependencies?: unknown[] }[] = [];
  try {
    modules = JSON.parse(info.stdout).modules ?? [];
  } catch { /* handled below */ }
  if (info.code !== 0 || modules.length !== 1 || (modules[0].dependencies ?? []).length > 0) {
    throw new BuildError(
      "bundle_not_self_contained",
      "bundled app.js is not exactly one module without dependencies",
      appDir,
    );
  }

  if (!sourcemap) return { js };
  let map: { sources?: unknown };
  try {
    map = JSON.parse(await Deno.readTextFile(`${out}.map`));
  } catch (e) {
    throw new BuildError(
      "sourcemap_invalid",
      `cannot read source map: ${(e as Error).message}`,
      appDir,
    );
  }
  if (!Array.isArray(map.sources) || !map.sources.every((s) => typeof s === "string")) {
    throw new BuildError("sourcemap_invalid", "source map has no string `sources`", appDir);
  }
  map.sources = (map.sources as string[]).map((s) => posix(relative(realAppDir, resolve(tmp, s))));
  return { js, map: JSON.stringify(map) };
}

/**
 * Build ONE app into `<outRoot>/<id>/<version>/{manifest.json, app.js[, app.js.map]}`.
 *
 * Nothing is written under `outRoot` unless every check passed. Every refusal is a
 * {@link BuildError}; its `code` is one of:
 *
 * - identity: `app_dir_invalid`, `invalid_package`, `manifest_file_forbidden`,
 *   `invalid_manifest`, `invalid_id`, `invalid_version`, `npm_dependencies`,
 *   `entry_outside_app`, `entry_missing`, `config_missing`, `config_invalid`,
 *   `types_root_invalid`, `shared_path_invalid`, `registry_spec_invalid` (registry mode only)
 * - graph: `graph_failed`, `graph_npm`, `graph_jsr`, `graph_remote`, `graph_non_file`,
 *   `graph_module_error`, `graph_outside_app`, `graph_tests`
 * - bundle: `bundle_failed`, `bundle_not_self_contained`, `sourcemap_invalid`
 * - describe: `worker_options_required` (run with `--unstable-worker-options`), `describe_failed`,
 *   `load_failed`, `artifact_invalid`
 * - form fields: `fields_hook_invalid` (an action's or trigger's `resolveFields` wiring is inconsistent)
 * - assets: `asset_path`, `asset_extension`, `asset_missing`, `asset_symlink`, `asset_not_file`,
 *   `asset_too_large`, `asset_total_too_large`
 * - source digest: `source_symlink`, `source_special_file`
 * - output: `write_failed`
 */
export async function buildApp(
  appDir: string,
  outRoot: string,
  opts: BuildOptions = {},
): Promise<BuildResult> {
  const minify = opts.minify ?? true;
  const sourcemap = opts.sourcemap ?? false;
  const fail = (code: string, msg: string): never => {
    throw new BuildError(code, msg, appDir);
  };

  // ---- identity (before any subprocess) ----
  const identity = await readAppIdentity(appDir);
  const { realAppDir, pkg } = identity;
  try {
    await assertNoNpmDependencies(realAppDir, pkg);
  } catch (e) {
    if (e instanceof LoadError) return fail("npm_dependencies", e.message);
    throw e;
  }
  const entryAbs = resolveAppEntry(realAppDir, pkg);
  if (!isInside(realAppDir, entryAbs)) {
    fail("entry_outside_app", `entry escapes the app: ${entryAbs}`);
  }
  let entryReal: string;
  try {
    entryReal = await Deno.realPath(entryAbs);
  } catch {
    return fail("entry_missing", `entry module not found: ${entryAbs}`);
  }
  if (!isInside(realAppDir, entryReal)) fail("entry_outside_app", `entry resolves outside the app`);
  const entryRel = "./" + posix(relative(realAppDir, entryReal));
  try {
    await Deno.stat(join(realAppDir, "deno.json"));
  } catch {
    fail("config_missing", "the app has no deno.json (its import map is required)");
  }
  const resolution = opts.resolution ?? "sibling";
  // Registry mode: enforce the P3 allowlist BEFORE any subprocess resolves an import.
  const registry = resolution === "registry" ? await readRegistryMap(realAppDir, appDir) : null;
  const typesRoot = await resolveTypesRoot(realAppDir, appDir, resolution);
  const sharedRoots = await resolveSharedRoots(realAppDir);

  // ---- graph: the real refusal ----
  const modules = await assertGraph(realAppDir, appDir, entryRel, typesRoot, sharedRoots, registry);

  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "w6w-app-build-" }));
  try {
    // ---- registry mode: the same `sideEffects` treatment sibling mode gets for free ----
    const vendored = registry === null ? null : await materialiseRegistryModules(modules, {
      tmp,
      realAppDir,
      appDir,
      registry,
    });

    // ---- bundle ----
    const { js, map } = await bundle(
      realAppDir,
      appDir,
      entryRel,
      tmp,
      minify,
      sourcemap,
      vendored?.configPath ?? join(realAppDir, "deno.json"),
    );

    // ---- describe → checks → assets → digests → manifest → write (shared with assembleApp) ----
    return await packageBuiltApp({
      appDir,
      identity,
      sharedRoots,
      js,
      map,
      buildInfo: { builder: BUILDER, denoVersion: Deno.version.deno, minify, sourcemap },
      describeCode: (code) => describeExec(code),
      outRoot,
      maxAssetBytes: opts.maxAssetBytes,
      maxAppAssetBytes: opts.maxAppAssetBytes,
    });
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}
