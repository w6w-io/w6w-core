/**
 * Pack mode: build every app of a pack (or a list of app dirs) and write `<outRoot>/index.json`.
 * One failing app never stops the rest; every failure is reported.
 */
import { dirname, resolve } from "jsr:@std/path@^1.0.0";
import { type PackManifest } from "@w6w/types";
import { buildApp, type BuildOptions, type BuildResult } from "./build.ts";
import { BuildError } from "./errors.ts";

/** Default number of apps built at once (mirrors the registry's pack loader). */
export const DEFAULT_PACK_CONCURRENCY = 8;

export interface PackIndexApp {
  id: string;
  version: string;
  execSha256: string;
  digest: string;
  digestVersion: 1 | 2;
  sourceDigest: string;
}

export interface PackIndexFailure {
  /** The pack entry's `path` (or the CLI's app-dir argument). */
  path: string;
  /** `BuildError.code`, else `"unexpected"`. */
  code: string;
  message: string;
}

/** The shape of `<outRoot>/index.json`. No absolute paths: byte-identical across out dirs. */
export interface PackIndex {
  apps: PackIndexApp[];
  failures: PackIndexFailure[];
}

export interface PackReport {
  index: PackIndex;
  /** Successful builds in input order, with the source dir each came from. */
  built: { path: string; appDir: string; result: BuildResult }[];
  /** Number of apps the pack (or app list) asked for. */
  total: number;
}

export type PackBuildOptions = BuildOptions & { concurrency?: number };

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Build `targets` (labelled by `path`, built from `appDir`) and write `index.json`. */
export async function buildApps(
  targets: { path: string; appDir: string }[],
  outRoot: string,
  opts: PackBuildOptions = {},
): Promise<PackReport> {
  const { concurrency, ...buildOpts } = opts;
  const results: ({ ok: true; result: BuildResult } | { ok: false; failure: PackIndexFailure })[] =
    new Array(targets.length);
  let nextIndex = 0;
  const workerCount = Math.max(
    1,
    Math.min(concurrency ?? DEFAULT_PACK_CONCURRENCY, targets.length),
  );
  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= targets.length) return;
      const t = targets[i];
      try {
        results[i] = { ok: true, result: await buildApp(t.appDir, outRoot, buildOpts) };
      } catch (e) {
        results[i] = {
          ok: false,
          failure: {
            path: t.path,
            code: e instanceof BuildError ? e.code : "unexpected",
            message: e instanceof BuildError ? e.message : String((e as Error)?.message ?? e),
          },
        };
      }
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));

  const built: PackReport["built"] = [];
  const apps: PackIndexApp[] = [];
  const failures: PackIndexFailure[] = [];
  results.forEach((r, i) => {
    if (r.ok) {
      built.push({ path: targets[i].path, appDir: targets[i].appDir, result: r.result });
      const { id, version, execSha256, digest, digestVersion, sourceDigest } = r.result;
      apps.push({ id, version, execSha256, digest, digestVersion, sourceDigest });
    } else failures.push(r.failure);
  });
  apps.sort((a, b) => cmp(a.id, b.id) || cmp(a.version, b.version));
  failures.sort((a, b) => cmp(a.path, b.path));
  const index: PackIndex = { apps, failures };
  await Deno.mkdir(outRoot, { recursive: true });
  await Deno.writeTextFile(resolve(outRoot, "index.json"), JSON.stringify(index, null, 2) + "\n");
  return { index, built, total: targets.length };
}

/** Read a pack manifest and build every app it lists. */
export async function buildPack(
  packPath: string,
  outRoot: string,
  opts: PackBuildOptions = {},
): Promise<PackReport> {
  const pack = JSON.parse(await Deno.readTextFile(packPath)) as PackManifest;
  if (pack === null || typeof pack !== "object" || !Array.isArray(pack.apps)) {
    throw new Error(`${packPath}: not a pack manifest (no "apps" array)`);
  }
  const base = dirname(resolve(packPath));
  return buildApps(
    pack.apps.map((e) => ({ path: e.path, appDir: resolve(base, e.path) })),
    outRoot,
    opts,
  );
}
