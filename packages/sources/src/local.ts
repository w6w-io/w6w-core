/**
 * Local resolver. Zero dependencies: `file:./path` or a bare path → an absolute
 * directory. This is effectively what lib core already consumes.
 */
import { resolve as resolvePath } from "jsr:@std/path@^1.0.0";
import { type Resolver, SourceError, splitRef } from "./types.ts";

export const localResolver: Resolver = {
  scheme: "file",

  canResolve(ref: string): boolean {
    const { scheme } = splitRef(ref);
    // `file:` explicitly, or a bare path (no scheme).
    return scheme === "file" || scheme === undefined;
  },

  resolve(ref: string): Promise<string> {
    const { scheme, rest } = splitRef(ref);
    const path = resolvePath(scheme === "file" ? rest : ref);
    return Deno.stat(path).then((info) => {
      if (!info.isDirectory) {
        throw new SourceError("not_a_directory", `Source path is not a directory: ${path}`);
      }
      return path;
    }).catch((e) => {
      if (e instanceof SourceError) throw e;
      throw new SourceError("not_found", `Source path not found: ${path}`);
    });
  },
};
