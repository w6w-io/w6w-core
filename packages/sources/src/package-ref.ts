/**
 * Shared grammar + policy for `npm:` / `jsr:` package refs (P1). Skeleton: signatures only;
 * bodies are filled by later slices.
 */
import { SourceError } from "./types.ts";

export type PackageRegistry = "npm" | "jsr";

export interface PackageRef {
  registry: PackageRegistry;
  /** Full package name, e.g. `@scope/name` or `name`. */
  name: string;
  /** Requested range / tag / exact version; `undefined` = default selection. */
  range?: string;
  /** `#app-id` fragment, returned to the caller; never applied as a subpath. */
  appId?: string;
}

const unimplemented = (what: string): never => {
  throw new SourceError("unimplemented", `${what}: not implemented`);
};

/** Parse `npm:name[@range][#app-id]` / `jsr:@scope/name[@range][#app-id]`. */
export function parsePackageRef(_ref: string): PackageRef {
  return unimplemented("parsePackageRef");
}

/** Stable identity key `<registry>:<name>` (no range, no fragment). */
export function packageKey(_ref: PackageRef): string {
  return unimplemented("packageKey");
}

/** Validate a package name for the registry BEFORE any fetch. */
export function validatePackageName(_registry: PackageRegistry, _name: string): void {
  unimplemented("validatePackageName");
}

/** Pick the exact version from `versions` for `range` (and optional dist-`tags`). */
export function selectVersion(
  _registry: PackageRegistry,
  _versions: Record<string, { yanked?: boolean; deprecated?: string }> | string[],
  _range?: string,
  _tags?: Record<string, string>,
): string {
  return unimplemented("selectVersion");
}

/** P2 dependency policy: refuse any of the six dependency fields (even `{}`). */
export function assertNoDependencies(_rootPkgJson: Record<string, unknown>): void {
  unimplemented("assertNoDependencies");
}

/** Refuse unsafe archive / manifest entry paths (`unsafe_entry`). */
export function assertSafeEntryPath(_p: string): string {
  return unimplemented("assertSafeEntryPath");
}
