/**
 * The Node builtins this package uses, loaded through NON-literal specifiers.
 *
 * Core's root `package.json` puts Deno in manual `node_modules` mode. In that mode a literal
 * `node:` specifier anywhere in a test's module graph makes `deno test` look for `@types/node`
 * in a `node_modules/` that does not exist, and `// @ts-types` does not stop it. Switching the
 * mode off (`"nodeModulesDir": "none"`) is worse: a sandboxed Worker can then fetch `npm:`
 * packages, which the runtime's npm-denial test catches. A computed specifier is not in the type
 * graph, so the types come from the local slices in `./node/`.
 *
 * Runtime-neutral: Deno and Node both resolve `node:*` builtins, and a bundler (esbuild for
 * `@w6w/cli`) leaves a computed import as a runtime import of the builtin.
 */
import type * as FsPromises from "./node/fs-promises.d.ts";
import type * as Path from "./node/path.d.ts";
import type * as Os from "./node/os.d.ts";

const FS: string = "node:fs/promises";
const PATH: string = "node:path";
const OS: string = "node:os";

/** `node:fs/promises`. */
export const fs = (await import(FS)) as typeof FsPromises;
/** `node:path`. */
export const path = (await import(PATH)) as typeof Path;
/** `node:os`. */
export const os = (await import(OS)) as typeof Os;
