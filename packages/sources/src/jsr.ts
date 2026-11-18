/**
 * `jsr:` resolver (skeleton — resolve bodies land in a later slice).
 */
import { type ResolvedSource, type ResolveOptions, type Resolver, SourceError } from "./types.ts";

export const jsrResolver: Resolver = {
  scheme: "jsr",
  canResolve: (ref: string) => ref.startsWith("jsr:"),
  resolve: async (ref: string, opts: ResolveOptions): Promise<string> =>
    (await jsrResolver.resolveDetailed!(ref, opts)).dir,
  resolveDetailed: (_ref: string, _opts: ResolveOptions): Promise<ResolvedSource> => {
    return Promise.reject(new SourceError("unimplemented", "jsr resolver: not implemented"));
  },
};
