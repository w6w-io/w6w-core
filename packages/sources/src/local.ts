/**
 * Local resolver. Zero dependencies: `file:./path` or a bare path → an absolute
 * directory. An optional `#subpath` fragment selects a sub-directory within it
 * (e.g. `file:/abs/pack#./hello`). This is effectively what lib core already
 * consumes.
 */
import { resolve as resolvePath } from "jsr:@std/path@^1.0.0";
import { type Resolver, splitFragment, splitRef } from "./types.ts";
import { applySubpath } from "./subpath.ts";

export const localResolver: Resolver = {
  scheme: "file",

  canResolve(ref: string): boolean {
    const { scheme } = splitRef(splitFragment(ref).base);
    // `file:` explicitly, or a bare path (no scheme).
    return scheme === "file" || scheme === undefined;
  },

  resolve(ref: string): Promise<string> {
    const { base, subpath } = splitFragment(ref);
    const { scheme, rest } = splitRef(base);
    const basePath = resolvePath(scheme === "file" ? rest : base);
    // `applySubpath` stats/validates the target (or `basePath` when no subpath).
    return applySubpath(basePath, subpath);
  },
};
