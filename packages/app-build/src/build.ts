import { join, relative, resolve } from "jsr:@std/path@^1.0.0";
import {
  type AppPackageJson,
  assertNoNpmDependencies,
  describe,
  describeExec,
  loadedAppFromArtifact,
  LoadError,
  manifestFromPackageJson,
  resolveAppEntry,
} from "@w6w/runtime";
import {
  type AppArtifactManifest,
  digestDescriptionVersioned,
  parseAppArtifactManifest,
  sha256HexBytes,
} from "@w6w/types";
import { inlineAssets } from "./assets.ts";
import { BuildError, isInside } from "./errors.ts";
import { assertGraph, resolveTypesRoot, runDeno } from "./graph.ts";
import { computeSourceDigest } from "./source-digest.ts";
import pkgConfig from "../deno.json" with { type: "json" };

/** Per-file cap on an inlined asset, in bytes. */
export const MAX_ASSET_BYTES = 262_144;
/** Per-app cap on the total of all inlined assets, in bytes. */
export const MAX_APP_ASSET_BYTES = 1_048_576;

export interface BuildOptions {
  /** Minify `app.js`. Default `true`. */
  minify?: boolean;
  /** Also emit `app.js.map` (sources rewritten app-relative). Default `false`. */
  sourcemap?: boolean;
  /** Per-asset byte cap. Default {@link MAX_ASSET_BYTES}. */
  maxAssetBytes?: number;
  /** Per-app inlined-asset byte cap. Default {@link MAX_APP_ASSET_BYTES}. */
  maxAppAssetBytes?: number;
}

export interface BuildResult {
  id: string;
  version: string;
  /** sha-256 (hex) of `app.js`. */
  execSha256: string;
  /** The registry content digest this artifact would register under. */
  digest: string;
  digestVersion: 1 | 2;
  sourceDigest: string;
  /** `<outRoot>/<id>/<version>`, absolute. */
  outDir: string;
}

const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

const posix = (p: string) => p.split("\\").join("/");

/** Build `app.js` into `tmp` and return its bytes (and the rewritten map text, if any). */
async function bundle(
  realAppDir: string,
  appDir: string,
  entryRel: string,
  tmp: string,
  minify: boolean,
  sourcemap: boolean,
): Promise<{ js: Uint8Array; map?: string }> {
  const out = join(tmp, "app.js");
  const args = ["bundle", "-q", "--no-remote", "--no-npm", "--no-lock", "--config", "deno.json"];
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
 *   `types_root_invalid`
 * - graph: `graph_failed`, `graph_npm`, `graph_jsr`, `graph_remote`, `graph_non_file`,
 *   `graph_module_error`, `graph_outside_app`, `graph_tests`
 * - bundle: `bundle_failed`, `bundle_not_self_contained`, `sourcemap_invalid`
 * - describe: `worker_options_required` (run with `--unstable-worker-options`), `describe_failed`,
 *   `load_failed`, `artifact_invalid`
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
  let realAppDir: string;
  try {
    realAppDir = await Deno.realPath(appDir);
  } catch (e) {
    return fail("app_dir_invalid", `cannot resolve app dir: ${(e as Error).message}`);
  }
  let pkg: AppPackageJson;
  try {
    pkg = JSON.parse(await Deno.readTextFile(join(realAppDir, "package.json")));
  } catch (e) {
    return fail("invalid_package", `cannot read package.json: ${(e as Error).message}`);
  }
  if (pkg === null || typeof pkg !== "object") {
    fail("invalid_package", "package.json is not an object");
  }
  if (pkg.w6w?.manifest !== undefined) {
    fail("manifest_file_forbidden", "`w6w.manifest` (a standalone manifest file) is not buildable");
  }
  let manifest;
  try {
    manifest = manifestFromPackageJson(pkg);
  } catch (e) {
    if (e instanceof LoadError) return fail("invalid_manifest", e.message);
    throw e;
  }
  const { id, version } = manifest;
  if (typeof id !== "string" || !ID_RE.test(id)) fail("invalid_id", `invalid app id: ${id}`);
  if (typeof version !== "string" || !VERSION_RE.test(version) || version.includes("..")) {
    fail("invalid_version", `invalid app version: ${version}`);
  }
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
  const typesRoot = await resolveTypesRoot(realAppDir, appDir);

  // ---- graph: the real refusal ----
  await assertGraph(realAppDir, appDir, entryRel, typesRoot);

  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "w6w-app-build-" }));
  try {
    // ---- bundle ----
    const { js, map } = await bundle(realAppDir, appDir, entryRel, tmp, minify, sourcemap);
    const code = new TextDecoder("utf-8", { fatal: true }).decode(js);

    // ---- describe ----
    let described;
    try {
      described = await describeExec(code);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (/unstable-worker-options|worker.*permission/i.test(msg)) {
        return fail("worker_options_required", `run with --unstable-worker-options: ${msg}`);
      }
      return fail("describe_failed", `describing the bundle failed: ${msg}`);
    }

    // ---- assets ----
    const inlined = await inlineAssets(manifest, realAppDir, appDir, {
      maxAssetBytes: opts.maxAssetBytes ?? MAX_ASSET_BYTES,
      maxAppAssetBytes: opts.maxAppAssetBytes ?? MAX_APP_ASSET_BYTES,
    });

    const sourceDigest = await computeSourceDigest(realAppDir);
    const execSha256 = await sha256HexBytes(js);
    const artifact: AppArtifactManifest = {
      artifactVersion: 1,
      id,
      version,
      manifest: inlined,
      actions: described.actions,
      auth: described.auth,
      healthChecks: described.healthChecks,
      triggers: described.triggers,
      interfaces: described.interfaces,
      exec: { sha256: execSha256, bytes: js.length, format: "esm" },
      sourceDigest,
      buildInfo: {
        builder: `@w6w/app-build@${pkgConfig.version}`,
        denoVersion: Deno.version.deno,
        minify,
        sourcemap,
      },
    };
    let mapBytes: Uint8Array | undefined;
    if (map !== undefined) {
      mapBytes = new TextEncoder().encode(map);
      artifact.map = { sha256: await sha256HexBytes(mapBytes), bytes: mapBytes.length };
    }

    // ---- digest: exactly what the registry would compute for this artifact ----
    let loaded;
    try {
      loaded = await loadedAppFromArtifact(artifact, code);
    } catch (e) {
      if (e instanceof LoadError) return fail("load_failed", e.message);
      throw e;
    }
    const d = describe(loaded);
    const { digest, digestVersion } = await digestDescriptionVersioned({
      manifest: d.app,
      actions: d.actions,
      auth: d.auth,
      triggers: d.triggers,
      health: d.health.filter((h) => !h.key.startsWith("auth:")),
      interfaces: d.interfaces,
      exec: execSha256,
    });

    const manifestText = JSON.stringify(artifact, null, 2) + "\n";
    const parsed = parseAppArtifactManifest(JSON.parse(manifestText));
    if (!parsed.ok) {
      fail("artifact_invalid", `manifest.json does not parse: ${parsed.errors.join("; ")}`);
    }

    // ---- write last ----
    const outDir = join(resolve(outRoot), id, version);
    try {
      await Deno.remove(outDir, { recursive: true }).catch((e) => {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      });
      await Deno.mkdir(outDir, { recursive: true });
      await Deno.writeFile(join(outDir, "app.js"), js);
      if (mapBytes) await Deno.writeFile(join(outDir, "app.js.map"), mapBytes);
      await Deno.writeTextFile(join(outDir, "manifest.json"), manifestText);
    } catch (e) {
      return fail("write_failed", `cannot write ${outDir}: ${(e as Error).message}`);
    }
    return { id, version, execSha256, digest, digestVersion, sourceDigest, outDir };
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}
