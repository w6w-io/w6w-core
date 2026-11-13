import { join } from "jsr:@std/path@^1.0.0";
import { BuildError } from "./errors.ts";

/** How `@w6w/*` imports resolve: workspace siblings, or approved JSR specifiers. */
export type Resolution = "sibling" | "registry";

/** The approved registry specifiers (P3): import key -> value. Exact versions only. */
export const P3_SPECS: Readonly<Record<string, string>> = {
  "@w6w/types": "jsr:@w6w/types@0.2.0",
  "@w6w/runtime/author": "jsr:@w6w/runtime@0.2.0/author",
  "@w6w/app-kit/poll": "jsr:@w6w/app-kit@0.1.0/poll",
  "@w6w/app-kit/webhook": "jsr:@w6w/app-kit@0.1.0/webhook",
};

const SEMVER = "(\\d+\\.\\d+\\.\\d+)";
const PATTERNS: Record<string, { pkg: string; re: RegExp }> = {
  "@w6w/types": { pkg: "types", re: new RegExp(`^jsr:@w6w/types@${SEMVER}$`) },
  "@w6w/runtime/author": {
    pkg: "runtime",
    re: new RegExp(`^jsr:@w6w/runtime@${SEMVER}/author$`),
  },
  "@w6w/app-kit/poll": { pkg: "app-kit", re: new RegExp(`^jsr:@w6w/app-kit@${SEMVER}/poll$`) },
  "@w6w/app-kit/webhook": {
    pkg: "app-kit",
    re: new RegExp(`^jsr:@w6w/app-kit@${SEMVER}/webhook$`),
  },
};

/** JSR host: `JSR_URL` env, else `https://jsr.io/`; always ends in one `/`. */
export function jsrHost(): string {
  let url = "https://jsr.io/";
  try {
    url = Deno.env.get("JSR_URL") || url;
  } catch { /* no env permission */ }
  return url.endsWith("/") ? url : url + "/";
}

export interface RegistryMap {
  /** `"<pkg>@<version>"` pairs the app mapped. */
  pairs: Set<string>;
}

/** Read the app's deno.json imports and enforce the P3 allowlist. */
export async function readRegistryMap(realAppDir: string, appDir: string): Promise<RegistryMap> {
  const pairs = new Set<string>();
  let imports: Record<string, unknown> = {};
  try {
    const cfg = JSON.parse(await Deno.readTextFile(join(realAppDir, "deno.json")));
    if (cfg && typeof cfg.imports === "object" && cfg.imports) imports = cfg.imports;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      throw new BuildError("registry_spec_invalid", `unreadable deno.json: ${e}`, appDir);
    }
  }
  for (const [key, value] of Object.entries(imports)) {
    if (!key.startsWith("@w6w/")) continue;
    const p = Object.hasOwn(PATTERNS, key) ? PATTERNS[key] : undefined;
    if (!p) {
      throw new BuildError(
        "registry_spec_invalid",
        `import key ${JSON.stringify(key)} is not an approved registry specifier`,
        appDir,
      );
    }
    const m = typeof value === "string" ? p.re.exec(value) : null;
    if (!m) {
      throw new BuildError(
        "registry_spec_invalid",
        `${key} must be exactly ${JSON.stringify(P3_SPECS[key])} (exact version), got ${
          JSON.stringify(value)
        }`,
        appDir,
      );
    }
    pairs.add(`${p.pkg}@${m[1]}`);
  }
  return { pairs };
}

/** True iff `url` lies under `<host>@w6w/<pkg>/<X.Y.Z>/` for a mapped pair. */
export function moduleAllowed(url: string, pairs: Set<string>, host: string = jsrHost()): boolean {
  if (!url.startsWith(host + "@w6w/")) return false;
  const m = /^([a-z0-9-]+)\/(\d+\.\d+\.\d+)\//.exec(url.slice(host.length + "@w6w/".length));
  return !!m && pairs.has(`${m[1]}@${m[2]}`);
}
