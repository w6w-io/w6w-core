/**
 * `#subpath` fragment support. A source ref may pin a sub-directory *within* the
 * resolved source — e.g. `github:owner/repo@ref#./apps/sendgrid` selects the
 * `apps/sendgrid` dir inside the extracted repo, and `file:/abs/pack#./hello`
 * selects `hello` inside a local pack. `applySubpath` joins the (already parsed)
 * fragment onto the resolved base dir, guards against `..` escapes, and verifies
 * the result is an existing directory.
 *
 * Runs host-side (full Deno perms) — a wrapper concern, never sandboxed.
 */
import { join } from "jsr:@std/path@^1.0.0";
import { SourceError } from "./types.ts";

/**
 * Resolve `subpath` (a source-relative path like `./apps/sendgrid`) against an
 * already-resolved `baseDir`. With no subpath — or a no-op `.`/`./` — returns
 * `baseDir` itself. Rejects anything that escapes `baseDir` (e.g. `../..`) and
 * requires the target to be an existing directory.
 */
export async function applySubpath(baseDir: string, subpath?: string): Promise<string> {
  let target = baseDir;
  if (subpath !== undefined && subpath !== "") {
    // `join` collapses `.`/`..` segments; trim any trailing separator it leaves
    // (e.g. a `./` fragment) so the no-op case equals `baseDir` exactly.
    target = join(baseDir, subpath).replace(/\/+$/, "") || "/";
    // Guard against a fragment that climbs out of the resolved source dir.
    if (target !== baseDir && !target.startsWith(baseDir + "/")) {
      throw new SourceError("unsafe_subpath", `Subpath escapes the source dir: ${subpath}`);
    }
  }
  const info = await Deno.stat(target).catch(() => {
    throw new SourceError("not_found", `Source path not found: ${target}`);
  });
  if (!info.isDirectory) {
    throw new SourceError("not_a_directory", `Source path is not a directory: ${target}`);
  }
  return target;
}
