/**
 * The module-graph assertion — the builder's real refusal, run BEFORE bundling.
 * `deno bundle` happily bundles `tests/`, `jsr:` and `https:` imports, so the
 * allow-list is enforced here from `deno info --json`, comparing realpaths.
 */
import { fromFileUrl, relative, resolve } from "jsr:@std/path@^1.0.0";
import { BuildError, isInside, isTestPath } from "./errors.ts";

export interface DenoRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the current Deno binary with `cwd`, capturing output. */
export async function runDeno(args: string[], cwd: string): Promise<DenoRun> {
  const out = await new Deno.Command(Deno.execPath(), {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code: out.code, stdout: dec.decode(out.stdout), stderr: dec.decode(out.stderr) };
}

/**
 * The directory the app's own `deno.json` maps `@w6w/types` to, realpath'd, which must hold
 * a `deno.json` named `@w6w/types`. `null` when the app maps no `@w6w/types`.
 * Never derived from the builder's own import map: the app resolves its own sibling core.
 */
export async function resolveTypesRoot(
  realAppDir: string,
  appDir: string,
): Promise<string | null> {
  let cfg: { imports?: Record<string, unknown> };
  try {
    cfg = JSON.parse(await Deno.readTextFile(resolve(realAppDir, "deno.json")));
  } catch (e) {
    throw new BuildError(
      "config_invalid",
      `cannot read deno.json: ${(e as Error).message}`,
      appDir,
    );
  }
  const target = cfg.imports?.["@w6w/types"];
  if (target === undefined) return null;
  if (typeof target !== "string" || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) {
    throw new BuildError(
      "types_root_invalid",
      `deno.json maps @w6w/types to a non-local target: ${JSON.stringify(target)}`,
      appDir,
    );
  }
  let root: string;
  try {
    root = await Deno.realPath(resolve(realAppDir, target, ".."));
    const pkg = JSON.parse(await Deno.readTextFile(resolve(root, "deno.json")));
    if (pkg?.name !== "@w6w/types") {
      throw new Error(`deno.json is named ${JSON.stringify(pkg?.name)}`);
    }
  } catch (e) {
    throw new BuildError(
      "types_root_invalid",
      `@w6w/types target is not the @w6w/types package: ${(e as Error).message}`,
      appDir,
    );
  }
  return root;
}

function schemeCode(spec: string): string | null {
  if (/^npm:/i.test(spec)) return "graph_npm";
  if (/^jsr:/i.test(spec)) return "graph_jsr";
  if (/^https?:/i.test(spec)) return "graph_remote";
  return null;
}

interface InfoDep {
  specifier?: string;
  code?: { specifier?: string; error?: string };
  type?: { specifier?: string; error?: string };
}
interface InfoModule {
  specifier: string;
  error?: string;
  dependencies?: InfoDep[];
}

/**
 * Assert every module reachable from `entryRel` (app-relative) is a `file:` module that is
 * either inside the app (and not test code) or inside the app's own `@w6w/types` package.
 */
export async function assertGraph(
  realAppDir: string,
  appDir: string,
  entryRel: string,
  typesRoot: string | null,
): Promise<void> {
  const fail = (code: string, msg: string): never => {
    throw new BuildError(code, msg, appDir);
  };
  const r = await runDeno(
    ["info", "--json", "--no-remote", "--no-npm", "--no-lock", "--config", "deno.json", entryRel],
    realAppDir,
  );
  if (r.code !== 0) fail("graph_failed", `deno info failed: ${r.stderr.trim().slice(0, 400)}`);
  let info: { modules?: InfoModule[] };
  try {
    info = JSON.parse(r.stdout);
  } catch {
    return fail("graph_failed", "deno info produced unparseable output");
  }
  const modules = info.modules ?? [];
  if (modules.length === 0) fail("graph_failed", "deno info listed no modules");
  for (const m of modules) {
    for (const d of m.dependencies ?? []) {
      for (const side of [d.code, d.type]) {
        if (side?.error) {
          fail(
            schemeCode(d.specifier ?? "") ?? "graph_module_error",
            `${m.specifier}: import "${d.specifier}" does not resolve: ${
              side.error.split("\n")[0]
            }`,
          );
        }
      }
    }
    if (!m.specifier.startsWith("file:")) {
      fail(
        schemeCode(m.specifier) ?? "graph_non_file",
        `module outside the file system is not allowed: ${m.specifier}`,
      );
    }
    if (m.error) fail("graph_module_error", `${m.specifier}: ${m.error.split("\n")[0]}`);
    let real: string;
    try {
      real = await Deno.realPath(fromFileUrl(m.specifier));
    } catch (e) {
      fail("graph_module_error", `${m.specifier}: ${(e as Error).message}`);
      return;
    }
    if (isInside(realAppDir, real)) {
      const rel = relative(realAppDir, real).split("\\").join("/");
      if (isTestPath(rel)) fail("graph_tests", `app code imports test code: ${rel}`);
    } else if (!(typesRoot && isInside(typesRoot, real))) {
      fail("graph_outside_app", `module outside the app: ${m.specifier}`);
    }
  }
}
