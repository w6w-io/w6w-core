/**
 * @w6w/app-build — build one app directory into a self-contained artifact:
 * `<outRoot>/<id>/<version>/{manifest.json, app.js[, app.js.map]}`.
 *
 * Library only. A refusal is always a {@link BuildError}; its `code` is one of the
 * classes listed on {@link buildApp}: identity (`invalid_id`, `invalid_version`,
 * `npm_dependencies`, `entry_outside_app`, ...), module graph (`graph_tests`,
 * `graph_npm`, `graph_jsr`, `graph_remote`, `graph_outside_app`, ...), bundle,
 * describe (`worker_options_required` — run with `--unstable-worker-options`),
 * assets (`asset_path`, `asset_symlink`, `asset_too_large`, ...) and source digest.
 */
export { buildApp, MAX_APP_ASSET_BYTES, MAX_ASSET_BYTES } from "./src/build.ts";
export type { BuildOptions, BuildResult } from "./src/build.ts";
export { BuildError } from "./src/errors.ts";
export { computeSourceDigest } from "./src/source-digest.ts";
export { buildApps, buildPack, DEFAULT_PACK_CONCURRENCY } from "./src/pack.ts";
export type {
  PackBuildOptions,
  PackIndex,
  PackIndexApp,
  PackIndexFailure,
  PackReport,
} from "./src/pack.ts";
export { compareDescribed } from "./src/parity.ts";
