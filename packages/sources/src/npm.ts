/**
 * `npm:` resolver (skeleton — resolve bodies land in a later slice).
 */
import { type ResolvedSource, type ResolveOptions, type Resolver, SourceError } from "./types.ts";

export const npmResolver: Resolver = {
  scheme: "npm",
  canResolve: (ref: string) => ref.startsWith("npm:"),
  resolve: async (ref: string, opts: ResolveOptions): Promise<string> =>
    (await npmResolver.resolveDetailed!(ref, opts)).dir,
  resolveDetailed: (_ref: string, _opts: ResolveOptions): Promise<ResolvedSource> => {
    return Promise.reject(new SourceError("unimplemented", "npm resolver: not implemented"));
  },
};
