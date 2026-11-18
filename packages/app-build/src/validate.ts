/**
 * `validateApp` — build one app directory into a throwaway out root, read the built
 * `manifest.json` back off disk and run the artifact parser the server publishes with
 * (`parseAppArtifactManifest`, @w6w/types) over it. Nothing is left behind: the out root is
 * always removed, and a refusal is reported — never thrown.
 */
import { parseAppArtifactManifest, type ParseArtifactResult } from "@w6w/types";
import { buildApp, type BuildOptions } from "./build.ts";
import { BuildError } from "./errors.ts";
import { readBackManifest, type ValidateResult } from "./package.ts";

export type { ValidateResult } from "./package.ts";

export interface ValidateOptions extends BuildOptions {
  /**
   * How the built `manifest.json`, read back from disk, is parsed. Defaults to
   * {@link parseAppArtifactManifest} — the parser `AppArtifactPublisher` uses on the server.
   *
   * A test seam: `buildApp` already runs that parser on what it wrote, so a real app cannot
   * produce a manifest the default rejects (`invalid_manifest` is unreachable without it).
   */
  parse?: (value: unknown) => ParseArtifactResult;
}

/**
 * Validate `appDir` without leaving output: build it into a fresh temp out root with the same
 * options {@link buildApp} takes, read `<outDir>/manifest.json` back, parse it, and report
 * `{ok: true, id, version}` or `{ok: false, errors: [{code, message}]}`.
 */
export async function validateApp(
  appDir: string,
  opts: ValidateOptions = {},
): Promise<ValidateResult> {
  const { parse = parseAppArtifactManifest, ...buildOpts } = opts;
  const outRoot = await Deno.makeTempDir({ prefix: "w6w-app-validate-" });
  try {
    let outDir: string;
    try {
      outDir = (await buildApp(appDir, outRoot, buildOpts)).outDir;
    } catch (e) {
      if (!(e instanceof BuildError)) throw e;
      // The build's own refusal class passes straight through.
      return { ok: false, errors: [{ code: e.code, message: e.message }] };
    }
    return await readBackManifest(outDir, parse);
  } finally {
    await Deno.remove(outRoot, { recursive: true }).catch(() => {});
  }
}
