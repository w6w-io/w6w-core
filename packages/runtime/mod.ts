/**
 * @w6w/runtime — lib core for the reference runtime.
 *
 * Loads an app from a local directory, returns its manifest, and invokes its
 * Actions inside a least-privilege Deno Worker sandbox. Wrap this with an HTTP
 * service or a CLI in a separate package; the engine itself is transport-free.
 */
export { loadApp } from "./src/loader.ts";
export type { LoadedAction, LoadedApp } from "./src/loader.ts";

export { describe, invoke } from "./src/runtime.ts";
export type { AppDescription, InvokeOptions, InvokeResult } from "./src/runtime.ts";

export { resolveParams } from "./src/resolve.ts";
export { runHook } from "./src/sandbox/run-hook.ts";
export type { RunHookOptions } from "./src/sandbox/run-hook.ts";

export { LoadError, W6WError } from "./src/errors.ts";
export type { ErrorPhase } from "./src/errors.ts";
