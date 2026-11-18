/**
 * The shared tail of every build: given an app's identity and its `app.js` bytes, describe the
 * bundle, check form-field wiring and output contracts, inline assets, compute the digests, and
 * write `<outRoot>/<id>/<version>/{app.js, manifest.json[, app.js.map]}`.
 *
 * ONE implementation for both producers of `app.js`: the Deno `buildApp` (bundles source with
 * `deno bundle`) and the runtime-neutral `assembleApp` (developer-built JS). Runtime-neutral: it
 * reaches only `node:*` builtins, `@w6w/types`, `@w6w/validator` and `@w6w/runtime/assemble`, so
 * it runs under Node 24 as well as Deno.
 */
import {
  type AppPackageJson,
  describe,
  type DescribedApp,
  loadedAppFromArtifact,
  LoadError,
  manifestFromPackageJson,
} from "@w6w/runtime/assemble";
import { checkFormResolvedFields } from "@w6w/validator";
import {
  type AppArtifactManifest,
  type AppManifest,
  type ArtifactBuildInfo,
  compareOutputShape,
  digestDescriptionVersioned,
  observedShapeOfValue,
  type OutputField,
  parseAppArtifactManifest,
  sha256HexBytes,
} from "@w6w/types";
import { inlineAssets } from "./assets.ts";
import { BuildError } from "./errors.ts";
import { computeSourceDigest } from "./source-digest.ts";
import pkgConfig from "../deno.json" with { type: "json" };
import { fs, path } from "./node.ts";

const { mkdir, readFile, realpath, rm, writeFile } = fs;
const { join, resolve } = path;

/** Per-file cap on an inlined asset, in bytes. */
export const MAX_ASSET_BYTES = 262_144;
/** Per-app cap on the total of all inlined assets, in bytes. */
export const MAX_APP_ASSET_BYTES = 1_048_576;

/** `buildInfo.builder` for every artifact this package writes. */
export const BUILDER = `@w6w/app-build@${pkgConfig.version}`;

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
  /** Non-fatal build findings. The key is absent when there are none. */
  warnings?: string[];
  /**
   * Counts behind the output-contract warnings (absent when all are zero). Not part of
   * `index.json`; the CLI reads it to print one summary line per app.
   */
  outputWarnings?: OutputWarningCounts;
}

export interface OutputWarningCounts {
  actionsWithoutOutput: number;
  triggersWithoutOutput: number;
  /** Entries whose `sample` disagrees with their declared `output`. */
  sampleMismatches: number;
  /** Output fields declaring `items` while not `type: "array"`. */
  itemsOnNonArray: number;
}

/**
 * `ok` names the app the manifest describes; a refusal lists every error found. Codes are the
 * build's own {@link BuildError} codes, plus `invalid_manifest` for a built manifest the
 * artifact parser rejects.
 */
export type ValidateResult =
  | { ok: true; id: string; version: string }
  | { ok: false; errors: { code: string; message: string }[] };

/** `items` on a field that is not an array, at any depth. Returns the offending field keys. */
function itemsOnNonArray(fields: readonly OutputField[], prefix = ""): string[] {
  const bad: string[] = [];
  for (const f of fields) {
    if (f === null || typeof f !== "object") continue;
    const at = `${prefix}${f.key}`;
    if (f.items !== undefined && f.type !== "array") bad.push(at);
    if (Array.isArray(f.items)) bad.push(...itemsOnNonArray(f.items, `${at}[].`));
  }
  return bad;
}

/**
 * Warn (never fail) about one action/trigger's output contract: no `output` key, `items` on a
 * non-array field, `sample` not matching `output`. `output: []` and `{ source }` are deliberate.
 */
function outputWarnings(
  kind: "actions" | "triggers",
  entry: { key?: unknown; output?: unknown; sample?: unknown },
  warnings: string[],
  counts: OutputWarningCounts,
): void {
  const at = `${kind}[${entry.key}]`;
  if (!Object.hasOwn(entry, "output") || entry.output === undefined) {
    warnings.push(`${at}: declares no output`);
    if (kind === "actions") counts.actionsWithoutOutput++;
    else counts.triggersWithoutOutput++;
    return;
  }
  if (!Array.isArray(entry.output)) return;
  const fields = entry.output as OutputField[];
  for (const k of itemsOnNonArray(fields)) {
    warnings.push(`${at}: output field "${k}" declares items but its type is not "array"`);
    counts.itemsOnNonArray++;
  }
  if (entry.sample === undefined) return;
  const diff = compareOutputShape(fields, observedShapeOfValue(entry.sample));
  // An implied ancestor (`venue` for `venue.name`) is noise next to a listed descendant.
  const missing = diff.missing.filter((m) => !diff.missing.some((o) => o.startsWith(`${m}.`)));
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(", ")}`);
  if (diff.typeMismatch.length > 0) {
    parts.push(
      "type mismatch " +
        diff.typeMismatch.map((t) => `${t.key} (declared ${t.declared}, sample ${t.observed})`)
          .join(", "),
    );
  }
  if (parts.length > 0) {
    warnings.push(`${at}: sample does not match output: ${parts.join("; ")}`);
    counts.sampleMismatches++;
  }
}

const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;

/** An app directory's identity, read from its `package.json` alone (no code is run). */
export interface AppIdentity {
  /** The app dir, realpath'd. */
  realAppDir: string;
  pkg: AppPackageJson;
  /** The identity manifest (`manifestFromPackageJson`), assets not yet inlined. */
  manifest: AppManifest;
  id: string;
  version: string;
}

/**
 * Resolve `appDir` and read its identity: `app_dir_invalid`, `invalid_package`,
 * `manifest_file_forbidden`, `invalid_manifest`, `invalid_id`, `invalid_version`.
 */
export async function readAppIdentity(appDir: string): Promise<AppIdentity> {
  const fail = (code: string, msg: string): never => {
    throw new BuildError(code, msg, appDir);
  };
  let realAppDir: string;
  try {
    realAppDir = await realpath(appDir);
  } catch (e) {
    return fail("app_dir_invalid", `cannot resolve app dir: ${(e as Error).message}`);
  }
  let pkg: AppPackageJson;
  try {
    pkg = JSON.parse(await readFile(join(realAppDir, "package.json"), "utf8"));
  } catch (e) {
    return fail("invalid_package", `cannot read package.json: ${(e as Error).message}`);
  }
  if (pkg === null || typeof pkg !== "object") {
    fail("invalid_package", "package.json is not an object");
  }
  if (pkg.w6w?.manifest !== undefined) {
    fail("manifest_file_forbidden", "`w6w.manifest` (a standalone manifest file) is not buildable");
  }
  let manifest: AppManifest;
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
  return { realAppDir, pkg, manifest, id, version };
}

export interface PackageInput {
  /** The app dir as the caller gave it (refusals name it). */
  appDir: string;
  identity: AppIdentity;
  /** The app's declared shared directories (`resolveSharedRoots`), realpath'd. */
  sharedRoots: string[];
  /** The final `app.js` bytes: one self-contained ESM module. Must be valid UTF-8. */
  js: Uint8Array;
  /** The final `app.js.map` text, if the artifact carries one. */
  map?: string;
  /** How the artifact was produced; `sourcemap` must be `map !== undefined`. */
  buildInfo: ArtifactBuildInfo;
  /** Describe the bundle (Deno sandbox in `buildApp`, a Node Worker in `assembleApp`). */
  describeCode: (code: string) => Promise<DescribedApp>;
  outRoot: string;
  maxAssetBytes?: number;
  maxAppAssetBytes?: number;
  /** Warnings the caller already has (they lead the result's `warnings`). */
  warnings?: string[];
}

/**
 * describe → wiring/output checks → assets → digests → manifest → write. Nothing is written
 * under `outRoot` unless every check passed. Refusals (all {@link BuildError}):
 * `worker_options_required`, `describe_failed`, `fields_hook_invalid`, `asset_*`, `source_*`,
 * `load_failed`, `artifact_invalid`, `write_failed`.
 */
export async function packageBuiltApp(input: PackageInput): Promise<BuildResult> {
  const { appDir, identity, js, map, buildInfo } = input;
  const { realAppDir, manifest, id, version } = identity;
  const fail = (code: string, msg: string): never => {
    throw new BuildError(code, msg, appDir);
  };
  const code = new TextDecoder("utf-8", { fatal: true }).decode(js);

  // ---- describe ----
  let described: DescribedApp;
  try {
    described = await input.describeCode(code);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (/unstable-worker-options|worker.*permission/i.test(msg)) {
      return fail("worker_options_required", `run with --unstable-worker-options: ${msg}`);
    }
    return fail("describe_failed", `describing the bundle failed: ${msg}`);
  }

  // ---- form-resolved fields: the wiring rule only, not full validateAction ----
  const warnings: string[] = [...(input.warnings ?? [])];
  const counts: OutputWarningCounts = {
    actionsWithoutOutput: 0,
    triggersWithoutOutput: 0,
    sampleMismatches: 0,
    itemsOnNonArray: 0,
  };
  const wiringErrors: string[] = [];
  for (const a of described.actions) {
    const at = `actions[${(a as { key?: unknown }).key}]`;
    const found = checkFormResolvedFields(a, at);
    for (const e of found.errors) wiringErrors.push(`${e.path}: ${e.message}`);
    for (const w of found.warnings) warnings.push(`${w.path}: ${w.message}`);
    outputWarnings("actions", a as { key?: unknown }, warnings, counts);
  }
  for (const t of described.triggers) {
    outputWarnings("triggers", t.trigger as { key?: unknown }, warnings, counts);
  }
  if (wiringErrors.length > 0) {
    return fail("fields_hook_invalid", wiringErrors.join("; "));
  }

  // ---- assets ----
  const inlined = await inlineAssets(manifest, realAppDir, appDir, {
    maxAssetBytes: input.maxAssetBytes ?? MAX_ASSET_BYTES,
    maxAppAssetBytes: input.maxAppAssetBytes ?? MAX_APP_ASSET_BYTES,
  }, input.sharedRoots);

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
    buildInfo,
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
  const outDir = join(resolve(input.outRoot), id, version);
  try {
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "app.js"), js);
    if (mapBytes) await writeFile(join(outDir, "app.js.map"), mapBytes);
    await writeFile(join(outDir, "manifest.json"), manifestText);
  } catch (e) {
    return fail("write_failed", `cannot write ${outDir}: ${(e as Error).message}`);
  }
  const result: BuildResult = {
    id,
    version,
    execSha256,
    digest,
    digestVersion,
    sourceDigest,
    outDir,
  };
  if (warnings.length > 0) result.warnings = warnings;
  if (Object.values(counts).some((n) => n > 0)) result.outputWarnings = counts;
  return result;
}

/** Read `<outDir>/manifest.json` back off disk and parse it; the shared half of every validate. */
export async function readBackManifest(
  outDir: string,
  parse: (value: unknown) => ReturnType<typeof parseAppArtifactManifest>,
): Promise<ValidateResult> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
  } catch (e) {
    return {
      ok: false,
      errors: [
        {
          code: "invalid_manifest",
          message: `cannot read back the built manifest: ${(e as Error).message}`,
        },
      ],
    };
  }
  // The parse is over the file read from disk — never over the build's in-memory manifest.
  const parsed = parse(manifest);
  if (!parsed.ok) {
    return { ok: false, errors: [{ code: "invalid_manifest", message: parsed.errors.join("; ") }] };
  }
  return { ok: true, id: parsed.value.id, version: parsed.value.version };
}

/** `realpath` that reports "missing" as `null` instead of throwing. */
export async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}
