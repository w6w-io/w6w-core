import { dirname, join, relative, resolve, toFileUrl } from "jsr:@std/path@^1.0.0";
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

/** One module of the app's graph, as `deno info --json` reports it. */
export interface GraphModule {
  /** Resolved specifier: a `file:` URL, or the registry URL of a `@w6w/*` module. */
  specifier: string;
  /** Local path of a cached remote module. */
  local?: string;
  dependencies?: GraphDependency[];
}

/** One edge of the graph: the specifier as written, and what it resolved to. */
export interface GraphDependency {
  /** The specifier as written in the importing module. */
  specifier?: string;
  code?: { specifier?: string };
  type?: { specifier?: string };
}

/** What {@link materialiseRegistryModules} produced. */
export interface RegistryModules {
  /** Absolute path of the temp `deno.json` that maps every approved module to its local copy. */
  configPath: string;
  /** The vendored package-versions (`@w6w/types/0.2.0`), sorted. */
  packages: string[];
}

const REMOTE_REF = /^(jsr:|https?:|npm:)/;
const JSR_ALIAS = /^(@[a-z0-9-]+\/[a-z0-9-]+)@(\d+\.\d+\.\d+)(\/.*)?$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The registry equivalent of sibling resolution's `sideEffects`, applied by the builder instead
 * of by `@w6w/types`: copy the approved module set the graph resolved (already fetched into the
 * module cache by `deno info`) into a temp tree that mirrors the registry layout, give each
 * package-version a `package.json` with `"sideEffects": false`, and map every `@w6w/*` specifier
 * to that copy in a temp config. Bundling then sees `file:` modules with the same declarations
 * sibling mode sees, so it tree-shakes them identically — `deno bundle` has no plugin API and
 * ignores `sideEffects` for `jsr:` modules, so a temp tree is the one mechanism it supports.
 *
 * Returns `null` when the graph holds no registry modules (nothing to map). Every `@w6w/*`
 * module is re-checked against the allowlist here, so the copy can never carry a module the
 * graph assertion refused.
 */
export async function materialiseRegistryModules(
  modules: readonly GraphModule[],
  opts: { tmp: string; realAppDir: string; appDir: string; registry: RegistryMap },
): Promise<RegistryModules | null> {
  const remote = modules.filter((m) => !m.specifier.startsWith("file:"));
  if (remote.length === 0) return null;
  const fail: (code: string, msg: string) => never = (code, msg) => {
    throw new BuildError(code, msg, opts.appDir);
  };
  const host = remote[0].specifier.slice(0, remote[0].specifier.indexOf("@w6w/"));
  if (!remote[0].specifier.startsWith(host + "@w6w/")) {
    fail("graph_non_file", `module outside the file system is not allowed: ${remote[0].specifier}`);
  }

  // ---- 1. copy the approved module set, keeping `<scope>/<pkg>/<version>/<path>` ----
  const vendorRoot = join(opts.tmp, "vendor");
  const vendored = new Map<string, string>(); // resolved specifier -> local path
  const packages = new Set<string>();
  for (const m of remote) {
    if (!m.specifier.startsWith(host + "@w6w/")) {
      fail("graph_non_file", `module outside the file system is not allowed: ${m.specifier}`);
    }
    if (!moduleAllowed(m.specifier, opts.registry.pairs, host)) {
      fail("graph_jsr", `module outside the approved registry set: ${m.specifier}`);
    }
    if (m.local === undefined) fail("graph_module_error", `${m.specifier}: no local copy`);
    const segments = m.specifier.slice(host.length).split("/");
    if (segments.length < 4) fail("graph_module_error", `${m.specifier}: not a package path`);
    const target = join(vendorRoot, ...segments);
    await Deno.mkdir(dirname(target), { recursive: true });
    await Deno.copyFile(m.local, target);
    vendored.set(m.specifier, target);
    packages.add(segments.slice(0, 3).join("/"));
  }
  for (const pkg of packages) {
    await Deno.writeTextFile(
      join(vendorRoot, ...pkg.split("/"), "package.json"),
      JSON.stringify({ sideEffects: false }) + "\n",
    );
  }

  // ---- 2. map every specifier the graph actually wrote to its vendored copy ----
  const imports: Record<string, string> = {};
  const scopes = new Map<string, Record<string, string>>();
  for (const m of modules) {
    const own = vendored.get(m.specifier);
    // A module inside the copied tree gets a scope, so its own `jsr:` imports stay in-package.
    const scopeUrl = own === undefined ? null : toFileUrl(
      join(vendorRoot, ...relative(vendorRoot, own).split("/").slice(0, 3)) + "/",
    ).href;
    for (const d of m.dependencies ?? []) {
      const key = d.specifier;
      if (key === undefined) continue;
      for (const side of [d.code, d.type]) {
        const resolvedSide = side?.specifier;
        if (resolvedSide === undefined) continue;
        const target = vendoredFor(resolvedSide, host, vendored);
        if (target === undefined) {
          // A *code* import of something outside the copy cannot be served offline: refuse it
          // rather than let `deno bundle --no-remote` fail on a specifier nobody can explain.
          if (side === d.code && REMOTE_REF.test(resolvedSide)) {
            fail(
              "registry_spec_invalid",
              `${m.specifier} imports ${resolvedSide}, which is not in the approved registry set`,
            );
          }
          continue;
        }
        const value = toFileUrl(target).href;
        if (scopeUrl === null) imports[key] = value;
        else {
          const scope = scopes.get(scopeUrl) ?? {};
          scope[key] = value;
          scopes.set(scopeUrl, scope);
        }
      }
    }
  }

  // ---- 3. the temp config: the app's own map, plus the vendored one on top ----
  let appConfig: { imports?: unknown; scopes?: unknown };
  try {
    appConfig = JSON.parse(await Deno.readTextFile(join(opts.realAppDir, "deno.json")));
  } catch (e) {
    return fail("config_invalid", `cannot read deno.json: ${(e as Error).message}`);
  }
  const config: Record<string, unknown> = {
    ...appConfig,
    imports: { ...localiseImportMap(appConfig.imports, opts.realAppDir), ...imports },
  };
  const appScopes = localiseImportMap(appConfig.scopes, opts.realAppDir);
  const mergedScopes: Record<string, unknown> = { ...appScopes };
  for (const [scope, map] of scopes) {
    mergedScopes[scope] = { ...(appScopes[scope] as Record<string, string> | undefined), ...map };
  }
  if (Object.keys(mergedScopes).length > 0) config.scopes = mergedScopes;

  const configPath = join(opts.tmp, "deno.json");
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2) + "\n");
  return { configPath, packages: [...packages].sort() };
}

/**
 * The vendored path a resolved specifier points at: the registry URL itself, or the `jsr:` alias
 * the graph kept for an import-map entry (`jsr:@w6w/app-kit@0.1.0/poll` -> `.../poll/mod.ts`).
 */
function vendoredFor(
  spec: string,
  host: string,
  vendored: Map<string, string>,
): string | undefined {
  const exact = vendored.get(spec);
  if (exact !== undefined) return exact;
  if (!spec.startsWith("jsr:")) return undefined;
  const m = JSR_ALIAS.exec(spec.slice("jsr:".length));
  if (!m) return undefined;
  const base = `${host}${m[1]}/${m[2]}${m[3] ?? ""}`;
  const candidates = [...vendored.keys()].filter((url) => url.startsWith(`${base}/`));
  const entry = candidates.find((url) => url === `${base}/mod.ts`);
  if (entry !== undefined) return vendored.get(entry);
  return candidates.length === 1 ? vendored.get(candidates[0]) : undefined;
}

/**
 * Rewrite an import map's values — and any relative scope key — to URLs, because the temp config
 * lives outside the app dir: a relative `../_shared/poll/mod.ts` in the app's own map would
 * otherwise be resolved against the temp dir.
 */
function localiseImportMap(value: unknown, realAppDir: string): Record<string, unknown> {
  if (value === null || typeof value !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, target] of Object.entries(value as Record<string, unknown>)) {
    const localisedKey = key.endsWith("/") ? localise(key.slice(0, -1), realAppDir) + "/" : key;
    out[localisedKey] = typeof target === "string" ? localise(target, realAppDir) : target;
  }
  return out;
}

/** One import-map value: a scheme stays, anything else becomes a `file:` URL from the app dir. */
function localise(value: string, realAppDir: string): string {
  const trailing = value.endsWith("/") ? "/" : "";
  const bare = trailing === "" ? value : value.slice(0, -1);
  if (SCHEME.test(bare)) return bare + trailing;
  return toFileUrl(resolve(realAppDir, bare)).href + trailing;
}
