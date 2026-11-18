/**
 * @w6w/runtime/assemble — the runtime-neutral subset of `@w6w/runtime` that packaging an
 * already-built app needs, and nothing that touches the Deno sandbox.
 *
 * Every module this entry reaches runs under Node 24 as well as Deno: its imports are `@w6w/types`,
 * relative modules and `node:*` builtins only — no `jsr:`/`npm:`/`https:` specifier, no `Deno.*`
 * at module top level, no module resolved relative to `import.meta.url`. That is what lets
 * `@w6w/app-build`'s `assembleApp` be bundled into one Node ESM file (`@w6w/cli`).
 *
 * The same functions are exported from `@w6w/runtime` (mod.ts); this entry exists only so a
 * bundler following it never pulls in `run-hook.ts` (the Deno Worker sandbox).
 */
export { LoadError } from "./src/errors.ts";
export { loadedAppFromArtifact, manifestFromPackageJson, resolveAppEntry } from "./src/loader.ts";
export type { AppPackageJson, LoadedApp } from "./src/loader.ts";
export { resolveSharedRoots } from "./src/shared.ts";
export { describe } from "./src/description.ts";
export type { AppDescription } from "./src/description.ts";
export { describeExecNode } from "./src/sandbox/node-describe.ts";
export type { DescribedApp } from "./src/sandbox/protocol.ts";
