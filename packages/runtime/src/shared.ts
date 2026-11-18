// Node builtins (Deno supports them too): this module also runs under Node in `assembleApp`.
import { LoadError } from "./errors.ts";
import { fs, path } from "./node.ts";

const { lstat, readFile, realpath } = fs;
const { dirname, isAbsolute, relative, resolve } = path;

function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\"));
}

/** Explicit source directories shared by sibling apps; never inferred from a parent. */
export async function resolveSharedRoots(appDir: string): Promise<string[]> {
  appDir = await realpath(appDir);
  const pkg = JSON.parse(await readFile(resolve(appDir, "package.json"), "utf8"));
  const includes: unknown = pkg.w6w?.build?.include;
  if (includes === undefined) return [];
  const fail = (message: string): never => {
    throw new LoadError("shared_path_invalid", message, { appDir });
  };
  if (!Array.isArray(includes) || !includes.every((p) => typeof p === "string")) {
    return fail("w6w.build.include must be an array of relative directory paths");
  }
  const parent = dirname(appDir);
  const roots: string[] = [];
  for (const ref of includes as string[]) {
    if (!ref || isAbsolute(ref) || ref.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref)) {
      fail(`shared directory must be relative: ${ref}`);
    }
    const path = resolve(appDir, ref);
    if (path === parent || !isInside(parent, path) || isInside(appDir, path)) {
      fail(`shared directory must be inside a sibling directory: ${ref}`);
    }
    // Reject symlinks at every component, including a symlinked ancestor.
    let current = parent;
    for (const part of relative(parent, path).split(/[\\/]/)) {
      current = resolve(current, part);
      let st: Awaited<ReturnType<typeof lstat>>;
      try {
        st = await lstat(current);
      } catch {
        return fail(`shared directory does not exist: ${ref}`);
      }
      if (!st.isDirectory() || st.isSymbolicLink()) {
        fail(`shared directory must not be a symlink: ${ref}`);
      }
    }
    if (relative(parent, path).split(/[\\/]/).includes("tests")) {
      fail(`shared directory is test code: ${ref}`);
    }
    if (roots.some((root) => isInside(root, path) || isInside(path, root))) {
      fail(`duplicate or overlapping shared directories: ${ref}`);
    }
    roots.push(path);
  }
  return roots.sort();
}
