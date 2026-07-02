/**
 * Pack — a bundle of Apps distributed together.
 *
 * A Pack is a repo (or directory) whose root holds a `w6w-pack.json` file
 * listing paths to individual App directories inside it. The registry can
 * install every entry in one call, so a publisher can ship many small Apps
 * from a single source ref (`file:./apps`, `github:owner/repo@ref`, …).
 *
 * Pack manifests are intentionally minimal — everything App-specific lives on
 * the App's own manifest. The Pack layer only decides *which* Apps are in the
 * bundle and any per-entry install pins.
 *
 * See core/rfcs/pack.md (draft).
 */

export interface PackManifest {
  /** Schema version. Currently `"1"`. */
  manifestVersion: "1";
  /** Discriminant. Fixed to `"pack"` — distinguishes from an App manifest. */
  kind: "pack";
  /** Machine-friendly identifier. Reverse-DNS or slug. */
  name: string;
  /** Human-friendly label shown in a UI. */
  displayName?: string;
  /** Free-form description. */
  description?: string;
  /** SemVer of the pack itself. Independent of the versions of each App. */
  version?: string;
  /** The bundled Apps. Order is preserved by installers. */
  apps: PackAppEntry[];
}

/**
 * One entry in a Pack. The App at `path` is resolved relative to the pack
 * manifest's directory and registered like any other single-App source.
 */
export interface PackAppEntry {
  /**
   * Relative directory path to the App (from the pack manifest file).
   * The App at that path must have its own `package.json` with a `w6w` field.
   */
  path: string;
  /**
   * Optional SemVer pin. If present, the installer asserts the App's manifest
   * version matches — a mismatch is a hard error. Handy for a Pack that wants
   * to reproducibly install known-good versions.
   */
  version?: string;
  /**
   * Optional id override. If present, the installer asserts the App's manifest
   * `id` matches this value — catches path drift when the pack is renamed.
   */
  id?: string;
  /**
   * When true, a failure to load/register this entry is reported but does not
   * fail the whole pack install. Default `false`.
   */
  optional?: boolean;
}

/**
 * Filename convention. Consumers look for exactly this file at the root of a
 * resolved source ref before treating it as a Pack.
 */
export const PACK_MANIFEST_FILENAME = "w6w-pack.json";
