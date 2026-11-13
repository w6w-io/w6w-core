/**
 * A local JSR mirror for `@w6w/app-build` tests — no network, no real jsr.io.
 *
 * `startMirror()` stages packages into a temp dir laid out exactly as JSR serves
 * them, then serves that dir on `127.0.0.1:0`:
 *
 * ```text
 * /@w6w/<pkg>/meta.json             { scope, name, latest, versions }
 * /@w6w/<pkg>/<version>_meta.json   { exports, manifest: { path: { size, checksum } } }
 * /@w6w/<pkg>/<version>/<file>      the package's own files
 * ```
 *
 * The staged packages are the lane's own `@w6w/types` and `@w6w/runtime`
 * (only the `./author` entry, reached as `jsr:@w6w/runtime@<v>/author`), with
 * their bare `@w6w/*` imports rewritten to `jsr:` specifiers the way
 * `deno publish` rewrites them, plus a SYNTHETIC `@w6w/app-kit` that carries
 * nothing but the pinned P3 `./poll` and `./webhook` entrypoints (the real kit
 * is another node's deliverable).
 *
 * Run as a main module it stages, prints one line `JSR_URL=<url>` on stdout and
 * serves until killed, so a shell gate can point builds at it:
 *
 * ```sh
 * deno run -A --no-lock packages/app-build/tests/jsr-mirror.ts
 * ```
 *
 * Off `import.meta.main` it has no side effects: tests import `startMirror`
 * and call `close()` when done.
 */

import { join, relative } from "jsr:@std/path@^1.0.0";
import { P3_SPECS } from "../src/registry.ts";

/** Where the lane's packages live (`core/packages`), one level above this package. */
const PACKAGES_DIR = join(import.meta.dirname!, "..", "..");

/** A package staged into the mirror. */
export interface MirrorPackage {
  /** Unscoped name inside `@w6w/`, e.g. `types`. */
  name: string;
  version: string;
  /** Export map as served in `<version>_meta.json`: `"./author" -> "./author.ts"`. */
  exports: Record<string, string>;
  /** Staged files: mirror path with a leading `/` -> bytes. */
  files: Map<string, Uint8Array>;
}

export interface StartMirrorOptions {
  /** Extra packages to stage next to the defaults (test fixtures). */
  packages?: MirrorPackage[];
  /** Root holding the lane's `types`/`runtime` packages; defaults to `core/packages`. */
  packagesDir?: string;
}

/** A running mirror. */
export interface LocalMirror {
  /** Base URL, always ends in one `/`: `http://127.0.0.1:<port>/`. */
  url: string;
  /** Temp dir the mirror serves; removed by `close()`. */
  dir: string;
  /** Packages served, in staging order. */
  packages: { name: string; version: string }[];
  /** Stop serving and remove the staged tree. Idempotent. */
  close(): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const P3_SPEC = /^jsr:@w6w\/(?<pkg>[a-z0-9-]+)@(?<version>\d+\.\d+\.\d+)(?:\/.*)?$/;

/** `"jsr:@w6w/runtime@0.2.0/author"` -> `{ name: "runtime", version: "0.2.0" }`. */
function parseP3(spec: string, forPackage: string): { name: string; version: string } {
  const m = P3_SPEC.exec(spec);
  if (!m?.groups) throw new Error(`jsr-mirror: ${forPackage}: unparseable P3 specifier ${spec}`);
  return { name: m.groups.pkg, version: m.groups.version };
}

/** Collect `dir` recursively into mirror paths (leading `/`, `\` -> `/`). */
async function collect(root: string, dir: string, out = new Map<string, Uint8Array>()) {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      await collect(root, path, out);
    } else if (entry.isFile) {
      out.set("/" + relative(root, path).replaceAll("\\", "/"), await Deno.readFile(path));
    }
  }
  return out;
}

/** Read `{ name, version, exports }` from a package's deno.json. */
async function packageConfig(dir: string): Promise<{
  name: string;
  version: string;
  exports: Record<string, string>;
}> {
  const cfg = JSON.parse(await Deno.readTextFile(join(dir, "deno.json")));
  const exports = typeof cfg.exports === "string" ? { ".": cfg.exports } : Object.fromEntries(
    Object.entries(cfg.exports as Record<string, string>).map((
      [key, value],
    ) => [key === "." ? "." : key.startsWith("./") ? key : `./${key}`, value]),
  );
  return { name: cfg.name as string, version: cfg.version as string, exports };
}

/** Stage `@w6w/types`: `mod.ts` and everything under `src/`. */
async function stageTypes(packagesDir: string): Promise<MirrorPackage> {
  const dir = join(packagesDir, "types");
  const cfg = await packageConfig(dir);
  const expected = parseP3(P3_SPECS["@w6w/types"], "@w6w/types");
  if (cfg.version !== expected.version) {
    throw new Error(
      `jsr-mirror: ${dir}/deno.json is ${cfg.version} but P3 pins @w6w/types@${expected.version}`,
    );
  }
  const files = await collect(dir, dir);
  for (const path of [...files.keys()]) {
    if (!(path === "/mod.ts" || path.startsWith("/src/"))) files.delete(path);
  }
  return { name: "types", version: cfg.version, exports: cfg.exports, files };
}

/** Stage `@w6w/runtime`: the `./author` entry only (P3 allows nothing else). */
async function stageRuntime(packagesDir: string): Promise<MirrorPackage> {
  const dir = join(packagesDir, "runtime");
  const cfg = await packageConfig(dir);
  const expected = parseP3(P3_SPECS["@w6w/runtime/author"], "@w6w/runtime/author");
  if (cfg.version !== expected.version) {
    throw new Error(
      `jsr-mirror: ${dir}/deno.json is ${cfg.version} but P3 pins @w6w/runtime@${expected.version}`,
    );
  }
  const entry = cfg.exports["./author"];
  if (!entry) throw new Error(`jsr-mirror: ${dir}/deno.json has no "./author" export`);
  return {
    name: "runtime",
    version: cfg.version,
    exports: { "./author": entry },
    files: new Map([[entry.replace(/^\.\//, "/"), await Deno.readFile(join(dir, entry))]]),
  };
}

/** Stage the synthetic `@w6w/app-kit`: the pinned P3 interface only, a few lines each. */
function stageAppKit(): MirrorPackage {
  const version = parseP3(P3_SPECS["@w6w/app-kit/poll"], "@w6w/app-kit/poll").version;
  const poll = `/**
 * Synthetic \`@w6w/app-kit/poll\` — the pinned P3 entrypoint only. The real kit is
 * built over \`apps/_shared\` elsewhere; tests here only need the specifier to
 * resolve to a real module.
 */
export interface PollTriggerOptions {
  /** Trigger name shown to the author. */
  readonly name: string;
  /** Seconds between poll runs. */
  readonly everySeconds: number;
}

export function pollTrigger(options: PollTriggerOptions): PollTriggerOptions {
  return options;
}
`;
  const webhook = `/**
 * Synthetic \`@w6w/app-kit/webhook\` — the pinned P3 entrypoint only.
 */
export interface WebhookTriggerOptions {
  /** Trigger name shown to the author. */
  readonly name: string;
  /** Path the host posts to, relative to the app's webhook root. */
  readonly path: string;
}

export function webhookTrigger(options: WebhookTriggerOptions): WebhookTriggerOptions {
  return options;
}
`;
  return {
    name: "app-kit",
    version,
    exports: { "./poll": "./poll.ts", "./webhook": "./webhook.ts" },
    files: new Map([
      ["/poll.ts", encoder.encode(poll)],
      ["/webhook.ts", encoder.encode(webhook)],
    ]),
  };
}

/**
 * Rewrite bare `@w6w/*` specifiers to their `jsr:` specifier, as `deno publish`
 * does. Anything `@w6w/*` that is not one of the P3 specifiers is a staging bug
 * (the mirror must never serve a specifier the app-build allowlist would refuse).
 */
function rewriteSpecifiers(pkg: string, path: string, source: string): string {
  return source.replace(
    /(?<quote>["'])(?<spec>@w6w\/[^"'\n]*)\k<quote>/g,
    (match, _quote: string, spec: string) => {
      const mapped = P3_SPECS[spec];
      if (!mapped) {
        throw new Error(
          `jsr-mirror: @w6w/${pkg}${path} imports ${spec}, which is not a P3 registry specifier`,
        );
      }
      return JSON.stringify(mapped);
    },
  );
}

/**
 * The bytes JSR would serve: specifiers rewritten first, so the file manifest's
 * checksums describe exactly the text a client downloads.
 */
function published(pkg: MirrorPackage): MirrorPackage {
  const files = new Map<string, Uint8Array>();
  for (const [path, bytes] of pkg.files) {
    files.set(
      path,
      path.endsWith(".ts")
        ? encoder.encode(rewriteSpecifiers(pkg.name, path, decoder.decode(bytes)))
        : bytes,
    );
  }
  return { ...pkg, files };
}

/** JSR's file checksum: `sha256-` plus lowercase hex of the SHA-256 digest. */
async function checksum(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
  );
  return `sha256-${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The `<version>_meta.json` document: `{ exports, manifest }`.
 *
 * Deno's `moduleGraph1`/`moduleGraph2` are deliberately left out. They are an
 * optimisation of jsr.io's own metadata, and getting them wrong is worse than
 * omitting them: an empty `moduleGraph2: { "/mod.ts": {} }` makes Deno trust an
 * empty dependency graph, and `export * from "./src/app.ts"` then resolves to a
 * module with no members. Without the graphs Deno parses the files it fetches.
 */
async function versionMeta(pkg: MirrorPackage): Promise<string> {
  const manifest: Record<string, { size: number; checksum: string }> = {};
  for (const path of [...pkg.files.keys()].sort()) {
    const bytes = pkg.files.get(path)!;
    manifest[path] = { size: bytes.byteLength, checksum: await checksum(bytes) };
  }
  return JSON.stringify({ exports: pkg.exports, manifest });
}

/** `<scope>/<name>` -> content type for the served file. */
function contentType(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".ts")) return "application/typescript";
  return "application/octet-stream";
}

/** Write one package's files plus its two metadata documents under `root`. */
async function stage(root: string, pkg: MirrorPackage): Promise<void> {
  const base = join(root, "@w6w", pkg.name);
  const versionDir = join(base, pkg.version);
  for (const [path, bytes] of pkg.files) {
    const dest = join(versionDir, path);
    await Deno.mkdir(join(dest, ".."), { recursive: true });
    await Deno.writeFile(dest, bytes);
  }
  await Deno.writeTextFile(
    join(base, "meta.json"),
    JSON.stringify({
      scope: "w6w",
      name: pkg.name,
      latest: pkg.version,
      versions: { [pkg.version]: {} },
    }),
  );
  await Deno.writeTextFile(join(base, `${pkg.version}_meta.json`), await versionMeta(pkg));
}

/**
 * Stage the mirror and start serving it on `127.0.0.1:0`.
 *
 * The returned `url` goes into `JSR_URL` for any deno command that must resolve
 * the staged packages; `close()` stops the server and deletes the temp dir.
 */
export async function startMirror(opts: StartMirrorOptions = {}): Promise<LocalMirror> {
  const packagesDir = opts.packagesDir ?? PACKAGES_DIR;
  const packages = [
    await stageTypes(packagesDir),
    await stageRuntime(packagesDir),
    stageAppKit(),
    ...(opts.packages ?? []),
  ].map(published);

  const dir = await Deno.makeTempDir({ prefix: "w6w-jsr-mirror-" });
  for (const pkg of packages) await stage(dir, pkg);

  const server = Deno.serve(
    // `onListen` is silenced: a main run must emit exactly one stdout line.
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (req: Request): Promise<Response> => {
      const { pathname } = new URL(req.url);
      const path = decodeURIComponent(pathname).replace(/^\/+/, "");
      if (!path || path.includes("..")) {
        return new Response(`not found: ${pathname}\n`, { status: 404 });
      }
      try {
        const bytes = await Deno.readFile(join(dir, path));
        return new Response(bytes, { headers: { "content-type": contentType(path) } });
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          return new Response(`not found: ${pathname}\n`, { status: 404 });
        }
        throw error;
      }
    },
  );

  let closed: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/`,
    dir,
    packages: packages.map((pkg) => ({ name: pkg.name, version: pkg.version })),
    close(): Promise<void> {
      closed ??= (async () => {
        await server.shutdown();
        await Deno.remove(dir, { recursive: true }).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
      })();
      return closed;
    },
  };
}

if (import.meta.main) {
  const mirror = await startMirror();
  console.log(`JSR_URL=${mirror.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    try {
      Deno.addSignalListener(signal, () => {
        mirror.close().finally(() => Deno.exit(0));
      });
    } catch { /* not every platform can listen for both */ }
  }
  // Serve until killed; `Deno.serve` keeps the process alive.
  await new Promise<never>(() => {});
}
