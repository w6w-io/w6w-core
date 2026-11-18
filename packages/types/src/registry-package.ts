/**
 * Built-package index (`index.json` written by `@w6w/app-build` pack mode) and the
 * parser a host uses before trusting a registry package. Shape-only skeleton: the
 * parser body is filled by a later slice.
 */

export interface PackIndexApp {
  id: string;
  version: string;
  execSha256: string;
  digest: string;
  digestVersion: 1 | 2;
  sourceDigest: string;
}

export interface PackIndexFailure {
  /** The pack entry's `path` (or the CLI's app-dir argument). */
  path: string;
  /** `BuildError.code`, else `"unexpected"`. */
  code: string;
  message: string;
}

/** The shape of `<outRoot>/index.json`. No absolute paths: byte-identical across out dirs. */
export interface PackIndex {
  apps: PackIndexApp[];
  failures: PackIndexFailure[];
}

/** Thrown by {@link parseRegistryPackageIndex} / {@link assertSafeEntryPath}. */
export class RegistryPackageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RegistryPackageError";
  }
}

/** Refuse an id/version/entry path with `/`, `\`, `..`, empty or absolute segments. */
export function assertSafeEntryPath(_p: string): string {
  throw new RegistryPackageError("unimplemented", "assertSafeEntryPath: not implemented");
}

/** Parse + validate a built-package `index.json` (already JSON-decoded). */
export function parseRegistryPackageIndex(_raw: unknown): PackIndex {
  throw new RegistryPackageError("unimplemented", "parseRegistryPackageIndex: not implemented");
}
