/**
 * @w6w/runtime — lib core for the reference runtime.
 *
 * Loads an app from a local directory, returns its manifest, and invokes its
 * Actions inside a least-privilege Deno Worker sandbox. Wrap this with an HTTP
 * service or a CLI in a separate package; the engine itself is transport-free.
 */
export { loadApp } from "./src/loader.ts";
export type { LoadedAction, LoadedApp } from "./src/loader.ts";

export { describe, hostAllowed, invoke } from "./src/runtime.ts";
export type { AppDescription, EgressInfo, InvokeOptions, InvokeResult } from "./src/runtime.ts";

export {
  appScopedChecks,
  checkHealth,
  checksCovering,
  connectionScopedChecks,
  rollUpHealth,
} from "./src/health.ts";
export type { CheckHealthOptions, HealthResult, HealthVerdict } from "./src/health.ts";
export { healthAllowlist } from "./src/loader.ts";
// Feed parsing lives in the runtime so a publisher never reimplements it; a
// feed-backed check receives the parsed entries as `input.feed`.
export { feedListItems, latestPerId, parseFeed } from "./src/feed.ts";
export type { LoadedHealthCheck } from "./src/loader.ts";

export { resolveParams } from "./src/resolve.ts";
export { runHook } from "./src/sandbox/run-hook.ts";
export type { RunHookOptions } from "./src/sandbox/run-hook.ts";

export { LoadError, W6WError } from "./src/errors.ts";
export type { ErrorPhase } from "./src/errors.ts";
