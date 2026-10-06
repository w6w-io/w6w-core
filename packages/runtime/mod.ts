/**
 * @w6w/runtime — lib core for the reference runtime.
 *
 * Loads an app from a local directory, returns its manifest, and invokes its
 * Actions inside a least-privilege Deno Worker sandbox. Wrap this with an HTTP
 * service or a CLI in a separate package; the engine itself is transport-free.
 */
export { loadApp } from "./src/loader.ts";
export type { LoadedAction, LoadedApp } from "./src/loader.ts";

export {
  authFor,
  describe,
  hostAllowed,
  invoke,
  runAuthHook,
  signingFetch,
} from "./src/runtime.ts";
export type {
  AppDescription,
  CredentialHookKind,
  EgressInfo,
  InvokeOptions,
  InvokeResult,
  RunAuthHookOptions,
} from "./src/runtime.ts";
export type { SignableRequest } from "@w6w/types";
export type { WireResponse } from "./src/sandbox/protocol.ts";

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
export { feedListItems, latestPerId, parseChannelMeta, parseFeed } from "./src/feed.ts";
export type { LoadedHealthCheck } from "./src/loader.ts";

export { resolveParams } from "./src/resolve.ts";
export {
  applyOverrides,
  dedupeSignedHeaders,
  deepMerge,
  isPath,
  mergeValue,
  parseOverrideKey,
  parseOverridePath,
  readPath,
  selectsRequest,
  setPath,
  splitBodyOverrides,
} from "./src/overrides.ts";
export type { BodyOverride, OverrideKey, PathSegment } from "./src/overrides.ts";
export { runHook } from "./src/sandbox/run-hook.ts";
export type { RunHookOptions } from "./src/sandbox/run-hook.ts";

export {
  buildOnSocket,
  checkTarget,
  MAX_SOCKET_IO_BYTES,
  openConnectionSocket,
  openSocket,
  runHandshake,
} from "./src/socket.ts";
export type { SocketSession } from "./src/socket.ts";

export { LoadError, W6WError } from "./src/errors.ts";
export type { ErrorPhase } from "./src/errors.ts";
