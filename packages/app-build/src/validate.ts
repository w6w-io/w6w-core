/**
 * `validateApp` — build one app directory into a throwaway out root, read the built
 * `manifest.json` back off disk and run the artifact parser the server publishes with
 * (`parseAppArtifactManifest`, @w6w/types) over it. Nothing is left behind: the out root is
 * always removed, and a refusal is reported — never thrown.
 */
import { join } from "jsr:@std/path@^1.0.0";
import { parseAppArtifactManifest, type ParseArtifactResult } from "@w6w/types";
import { buildApp, type BuildOptions } from "./build.ts";
import { BuildError } from "./errors.ts";

/**
 * `ok` names the app the manifest describes; a refusal lists every error found. Codes are the
 * build's own {@link BuildError} codes, plus `invalid_manifest` for a built manifest the
 * artifact parser rejects.
 */
export type ValidateResult =
  | { ok: true; id: string; version: string }
  | { ok: false; errors: { code: string; message: string }[] };

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
    let manifest: unknown;
    try {
      manifest = JSON.parse(await Deno.readTextFile(join(outDir, "manifest.json")));
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
      return {
        ok: false,
        errors: [{ code: "invalid_manifest", message: parsed.errors.join("; ") }],
      };
    }
    return { ok: true, id: parsed.value.id, version: parsed.value.version };
  } finally {
    await Deno.remove(outRoot, { recursive: true }).catch(() => {});
  }
}
