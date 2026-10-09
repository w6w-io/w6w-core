/**
 * `computeSourceDigest` — the digest of an app's reviewable source tree, as
 * {@link sourceDigestOf} defines it. Test code, `node_modules/` and `.git/` are
 * excluded; a symlink anywhere in the counted tree is refused.
 */
import { join } from "jsr:@std/path@^1.0.0";
import { sourceDigestOf } from "@w6w/types";
import { BuildError, isTestPath } from "./errors.ts";

const SKIP_DIRS = new Set(["node_modules", ".git", "tests"]);

async function walk(
  dir: string,
  rel: string,
  out: { path: string; bytes: Uint8Array }[],
  appDir: string,
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory && SKIP_DIRS.has(entry.name)) continue;
    if (entry.isSymlink) {
      throw new BuildError("source_symlink", `symlink in app source tree: ${relPath}`, appDir);
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory) {
      await walk(full, relPath, out, appDir);
    } else if (entry.isFile) {
      if (isTestPath(relPath)) continue;
      out.push({ path: relPath, bytes: await Deno.readFile(full) });
    } else {
      throw new BuildError("source_special_file", `not a regular file: ${relPath}`, appDir);
    }
  }
}

/**
 * Digest every regular file under the (realpath'd) app directory, POSIX app-relative paths,
 * excluding `tests/`, `*.test.ts`, `*_test.ts`, `node_modules/` and `.git/`. `deno.lock` and
 * README are included. A symlink anywhere in the counted tree is refused.
 */
export async function computeSourceDigest(appDir: string): Promise<string> {
  let real: string;
  try {
    real = await Deno.realPath(appDir);
  } catch (e) {
    throw new BuildError(
      "app_dir_invalid",
      `cannot resolve app dir: ${(e as Error).message}`,
      appDir,
    );
  }
  const files: { path: string; bytes: Uint8Array }[] = [];
  await walk(real, "", files, appDir);
  return await sourceDigestOf(files);
}
