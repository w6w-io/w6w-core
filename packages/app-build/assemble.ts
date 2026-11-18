/**
 * @w6w/app-build/assemble — package an app whose JavaScript the DEVELOPER already built.
 *
 * A third-party developer bundles their TypeScript to one self-contained ESM file with whatever
 * tool they like (esbuild, tsup, rollup, …). `assembleApp` compiles nothing: it reads the
 * identity from `package.json`, loads the built JS to describe the app, checks form-field wiring
 * and output contracts, inlines assets, computes the digests and writes the same artifact the
 * Deno `buildApp` writes — `<outRoot>/<id>/<version>/{app.js, manifest.json[, app.js.map]}`.
 *
 * Runs under plain Node 24 (no Deno, no esbuild, no network) as well as Deno: this entry's whole
 * import graph is `node:*` builtins, `@w6w/types`, `@w6w/validator` and `@w6w/runtime/assemble`
 * — no `jsr:`/`npm:`/`https:` specifier, no `Deno.*`, nothing resolved relative to
 * `import.meta.url` — so `@w6w/cli` can bundle it into one Node ESM file and call it in-process.
 *
 * The entry is `w6w.entry`, else `main`, and must be a `.js`/`.mjs` file inside the app.
 * Source maps: see {@link assembleApp}.
 */
import { describeExecNode, resolveAppEntry } from "@w6w/runtime/assemble";
import { type ArtifactBuildInfo, parseAppArtifactManifest } from "@w6w/types";
import { BuildError, isInside } from "./src/errors.ts";
import {
  BUILDER,
  type BuildResult,
  packageBuiltApp,
  readAppIdentity,
  readBackManifest,
  type ValidateResult,
} from "./src/package.ts";
import { moduleImports } from "./src/self-contained.ts";
import { resolveSharedRoots } from "./src/shared.ts";
import { fs, os, path } from "./src/node.ts";

const { mkdtemp, readFile, realpath, rm } = fs;
const { tmpdir } = os;
const { dirname, isAbsolute, join, relative, resolve } = path;

export { BuildError } from "./src/errors.ts";
export { MAX_APP_ASSET_BYTES, MAX_ASSET_BYTES } from "./src/package.ts";
export type { BuildResult, OutputWarningCounts, ValidateResult } from "./src/package.ts";

export interface AssembleOptions {
  /** Per-asset byte cap. Default `MAX_ASSET_BYTES` (256 KiB). */
  maxAssetBytes?: number;
  /** Per-app inlined-asset byte cap. Default `MAX_APP_ASSET_BYTES` (1 MiB). */
  maxAppAssetBytes?: number;
}

/** How long describing the developer's bundle may take. */
const DESCRIBE_TIMEOUT_MS = 30_000;
/** V8 old-generation cap for the describe Worker, MiB. */
const DESCRIBE_MEMORY_MB = 1024;

/** A trailing `//# sourceMappingURL=…` (or legacy `//@`) comment, and only trailing whitespace. */
const SOURCE_MAPPING_URL = /(?:^|\r?\n)[ \t]*\/\/[#@][ \t]*sourceMappingURL=([^\s'"]+)[ \t]*\s*$/;

const posix = (p: string) => p.split("\\").join("/");

/** The version of whichever runtime is executing: `{nodeVersion}` under Node, else `{denoVersion}`. */
function runtimeVersion(): { denoVersion: string } | { nodeVersion: string } {
  const g = globalThis as {
    Deno?: { version?: { deno?: string } };
    process?: { versions?: { node?: string } };
  };
  const deno = g.Deno?.version?.deno;
  if (deno) return { denoVersion: deno };
  return { nodeVersion: g.process?.versions?.node ?? "unknown" };
}

/**
 * Read, validate and rewrite a developer source map. Same checks as the Deno builder (JSON, a
 * string `sources` array); `sources` are rewritten app-relative (POSIX), exactly like the Deno
 * builder's maps, so the artifact never carries a machine-specific path. URL-shaped sources
 * (`webpack://…`) are kept as they are.
 */
async function readSourceMap(
  mapPath: string,
  realAppDir: string,
  appDir: string,
): Promise<string> {
  let map: { sources?: unknown; sourceRoot?: unknown };
  try {
    map = JSON.parse(await readFile(mapPath, "utf8"));
  } catch (e) {
    throw new BuildError(
      "sourcemap_invalid",
      `cannot read source map ${posix(relative(realAppDir, mapPath))}: ${(e as Error).message}`,
      appDir,
    );
  }
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    throw new BuildError("sourcemap_invalid", "source map is not a JSON object", appDir);
  }
  if (!Array.isArray(map.sources) || !map.sources.every((s) => typeof s === "string")) {
    throw new BuildError("sourcemap_invalid", "source map has no string `sources`", appDir);
  }
  const root = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(root)) {
    return JSON.stringify(map); // a URL root: sources are URLs, nothing to make app-relative
  }
  const base = resolve(dirname(mapPath), root);
  map.sources = (map.sources as string[]).map((s) =>
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && !/^[A-Za-z]:[\\/]/.test(s)
      ? s
      : posix(relative(realAppDir, isAbsolute(s) ? s : resolve(base, s)))
  );
  delete map.sourceRoot;
  return JSON.stringify(map);
}

/** A file path that exists, is a regular file and resolves inside `root`; else `null`. */
async function localFile(root: string, path: string): Promise<string | null> {
  if (!isInside(root, path)) return null;
  try {
    const real = await realpath(path);
    return isInside(root, real) ? real : null;
  } catch {
    return null;
  }
}

/**
 * Package ONE developer-built app into `<outRoot>/<id>/<version>/{manifest.json, app.js[,
 * app.js.map]}`. Nothing is written under `outRoot` unless every check passed. Every refusal is a
 * {@link BuildError}; its `code` is one of:
 *
 * - identity: `app_dir_invalid`, `invalid_package`, `manifest_file_forbidden`, `invalid_manifest`,
 *   `invalid_id`, `invalid_version`, `shared_path_invalid`
 * - entry: `entry_not_js` (the entry is not a `.js`/`.mjs` file — point `w6w.entry` at the BUILT
 *   file), `entry_outside_app`, `entry_missing`, `entry_not_utf8`
 * - bundle: `bundle_not_self_contained` (the JS imports another module), `sourcemap_invalid`
 * - describe / checks / assets / digest / output: as {@link packageBuiltApp} (`describe_failed`,
 *   `fields_hook_invalid`, `asset_*`, `source_*`, `load_failed`, `artifact_invalid`,
 *   `write_failed`)
 *
 * npm dependencies are NOT refused (a developer's `package.json` legitimately lists their
 * bundler); what matters is that the built JS is self-contained. `node_modules/` is excluded from
 * the source digest.
 *
 * Source maps: if the JS ends in `//# sourceMappingURL=<relative file>` naming a file inside the
 * app, that file is the map — a map file the JS does not name is ignored (it may be stale). The map is
 * validated, its `sources` made app-relative, and written as `app.js.map` (`artifact.map`,
 * `buildInfo.sourcemap: true`). The trailing comment is removed from `app.js` whenever it names
 * an external map — the Deno builder's `app.js` carries none either, and the host loads `app.js`
 * from a `data:` URL where a relative reference resolves to nothing. An inline
 * `data:` map stays inside the JS untouched (`sourcemap: false`). A comment naming a map that does
 * not exist is removed with a warning.
 *
 * `buildInfo` is `{builder, nodeVersion | denoVersion, minify: false, sourcemap}` — `minify` is
 * always `false` because the builder never transforms the developer's code.
 */
export async function assembleApp(
  appDir: string,
  outRoot: string,
  opts: AssembleOptions = {},
): Promise<BuildResult> {
  const fail = (code: string, msg: string): never => {
    throw new BuildError(code, msg, appDir);
  };

  // ---- identity ----
  const identity = await readAppIdentity(appDir);
  const { realAppDir, pkg } = identity;
  // The runtime's own rule (`resolveAppEntry`): `w6w.entry`, else `main`, else `./index.ts`.
  const declared = pkg.w6w?.entry ?? pkg.main ?? "./index.ts";
  const entryAbs = resolveAppEntry(realAppDir, pkg);
  if (!/\.m?js$/i.test(entryAbs)) {
    fail(
      "entry_not_js",
      `entry ${declared} is not JavaScript: build your app first (TypeScript → one ESM .js file) ` +
        "and point `w6w.entry` at the built file, e.g. `dist/app.js`",
    );
  }
  if (!isInside(realAppDir, entryAbs)) {
    fail("entry_outside_app", `entry escapes the app: ${entryAbs}`);
  }
  let entryReal: string;
  try {
    entryReal = await realpath(entryAbs);
  } catch {
    return fail("entry_missing", `entry module not found: ${declared} (did you build the app?)`);
  }
  if (!isInside(realAppDir, entryReal)) fail("entry_outside_app", `entry resolves outside the app`);
  const sharedRoots = await resolveSharedRoots(realAppDir);

  // ---- the developer's JS ----
  let code: string;
  try {
    code = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(entryReal));
  } catch (e) {
    return fail("entry_not_utf8", `cannot read ${declared} as UTF-8: ${(e as Error).message}`);
  }
  const imports = moduleImports(code);
  if (imports.length > 0) {
    fail(
      "bundle_not_self_contained",
      `${declared} is not one self-contained module (found: ${imports.join(", ")}); ` +
        "bundle every dependency into it",
    );
  }

  // ---- source map ----
  const warnings: string[] = [];
  let mapPath: string | null = null;
  const comment = SOURCE_MAPPING_URL.exec(code);
  if (comment !== null && !comment[1].startsWith("data:")) {
    const ref = comment[1];
    // Drop the comment line, keep the line break that ended the code before it (`deno bundle
    // --sourcemap=external` writes no comment at all, so the bytes match the Deno builder's).
    code = code.slice(0, comment.index) + (/^\r?\n/.exec(comment[0])?.[0] ?? "");
    if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref) && !isAbsolute(ref)) {
      let decoded = ref;
      try {
        decoded = decodeURIComponent(ref);
      } catch { /* keep it as written */ }
      mapPath = await localFile(realAppDir, resolve(dirname(entryReal), decoded));
    }
    if (mapPath === null) {
      warnings.push(`${declared}: sourceMappingURL ${ref} names no source map in the app; removed`);
    }
  }
  // No `<entry>.map` fallback without the comment: a bundler run with maps turned off leaves the
  // previous build's map behind, and that map no longer describes this `app.js`.
  const map = mapPath === null ? undefined : await readSourceMap(mapPath, realAppDir, appDir);

  const buildInfo = {
    builder: BUILDER,
    ...runtimeVersion(),
    minify: false,
    sourcemap: map !== undefined,
  } as ArtifactBuildInfo;

  return await packageBuiltApp({
    appDir,
    identity,
    sharedRoots,
    js: new TextEncoder().encode(code),
    map,
    buildInfo,
    describeCode: (c) => describeExecNode(dataUrl(c), DESCRIBE_TIMEOUT_MS, DESCRIBE_MEMORY_MB),
    outRoot,
    maxAssetBytes: opts.maxAssetBytes,
    maxAppAssetBytes: opts.maxAppAssetBytes,
    warnings,
  });
}

/** `data:` URL for module source: base64 of its UTF-8 bytes. */
function dataUrl(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:text/javascript;base64,${btoa(bin)}`;
}

/**
 * Validate a developer-built app without leaving output: {@link assembleApp} into a fresh temp
 * out root, read `manifest.json` back, run the server's artifact parser over it. Reports
 * `{ok: true, id, version}` or `{ok: false, errors: [{code, message}]}` — never throws a
 * {@link BuildError}. The same result shape as `validateApp` / `cli.ts --validate`.
 */
export async function validateAssembled(
  appDir: string,
  opts: AssembleOptions = {},
): Promise<ValidateResult> {
  const outRoot = await mkdtemp(join(tmpdir(), "w6w-app-validate-"));
  try {
    let outDir: string;
    try {
      outDir = (await assembleApp(appDir, outRoot, opts)).outDir;
    } catch (e) {
      if (!(e instanceof BuildError)) throw e;
      return { ok: false, errors: [{ code: e.code, message: e.message }] };
    }
    return await readBackManifest(outDir, parseAppArtifactManifest);
  } finally {
    await rm(outRoot, { recursive: true, force: true }).catch(() => {});
  }
}
