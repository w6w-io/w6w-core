/** Parity comparison of two described apps (source vs. bundle). */
import { canonicalJson } from "@w6w/types";
import type { DescribedApp } from "@w6w/runtime";

const KEYS = ["actions", "auth", "triggers", "healthChecks", "interfaces"] as const;

/**
 * Names of the keys whose values differ between `source` and `bundle`. Canonical deep
 * equality: object key order is ignored, array order is kept.
 */
export function compareDescribed(source: DescribedApp, bundle: DescribedApp): string[] {
  return KEYS.filter((k) => canonicalJson(source[k]) !== canonicalJson(bundle[k]));
}
