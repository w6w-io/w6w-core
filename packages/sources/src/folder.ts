/**
 * Granted-folder resolution: a tenant/account is granted a folder INSIDE an
 * operator-owned root and addresses it by a relative path. This is the
 * containment check for that path — realpath containment plus a walk that
 * refuses any symlink leaving the root. Operator `file:` sources are a
 * different, unconfined seam (`local.ts`) and are not touched.
 *
 * No error message contains the root, its realpath, the target, or a link's
 * destination: a refusal must not leak host layout to the caller.
 */
import { isAbsolute, join, relative } from "jsr:@std/path@^1.0.0";
import { SourceError } from "./types.ts";

const ESCAPE = "Folder is outside the granted root";

function escape(): SourceError {
  return new SourceError("folder_escape", ESCAPE);
}

/** `""`, `"./"`, or `"./seg(/seg)*"`; a segment is never empty, `.`, `..`, nor holds `\`, NUL, `#` or `~`. */
function parseRel(relPath: string): string[] {
  if (relPath === "" || relPath === "./") return [];
  if (!relPath.startsWith("./")) throw escape();
  const segs = relPath.slice(2).split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === ".." || /[\\\0#~]/.test(s)) throw escape();
  }
  return segs;
}

function isInside(realRoot: string, real: string): boolean {
  const rel = relative(realRoot, real);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/**
 * Resolve `relPath` under `root` to a real directory path, or throw a coded
 * `SourceError`. Allows a target equal to the root. Every symlink anywhere in
 * the target's tree (symlinked directories are descended into) must resolve
 * inside the real root; a dangling link is refused.
 */
export async function resolveGrantedFolder(root: string, relPath: string): Promise<string> {
  const segs = parseRel(relPath);
  try {
    let realRoot: string;
    try {
      realRoot = await Deno.realPath(root);
    } catch {
      throw new SourceError("folder_missing", "Granted root not found");
    }
    let target: string;
    try {
      target = await Deno.realPath(join(realRoot, ...segs));
    } catch {
      throw new SourceError("folder_missing", "Granted folder not found");
    }
    if (!isInside(realRoot, target)) throw escape();
    if (!(await Deno.stat(target)).isDirectory) {
      throw new SourceError("folder_not_directory", "Granted folder is not a directory");
    }
    await walk(realRoot, target, new Set());
    return target;
  } catch (e) {
    if (e instanceof SourceError) throw e;
    throw new SourceError("folder_unreadable", "Granted folder could not be read");
  }
}

async function walk(realRoot: string, dir: string, visited: Set<string>): Promise<void> {
  if (visited.has(dir)) return;
  visited.add(dir);
  for await (const entry of Deno.readDir(dir)) {
    const p = join(dir, entry.name);
    if (entry.isSymlink) {
      let real: string;
      try {
        real = await Deno.realPath(p); // dangling or looping link throws
      } catch {
        throw escape();
      }
      if (!isInside(realRoot, real)) throw escape();
      if ((await Deno.stat(real)).isDirectory) await walk(realRoot, real, visited);
    } else if (entry.isDirectory) {
      await walk(realRoot, p, visited);
    }
  }
}
