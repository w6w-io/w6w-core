#!/usr/bin/env node
/**
 * Node smoke for `assemble.ts` — proves `assembleApp` / `validateAssembled` run under plain Node 24
 * with no Deno, no network and no esbuild at RUN time.
 *
 *   node packages/app-build/scripts/node-smoke.mjs [--keep]
 *
 * 1. Bundles `assemble.ts` into ONE Node ESM file with esbuild (dev-time only, fetched through
 *    `npx --yes esbuild@0.28.2`), resolving `@w6w/*` through core's import maps (the same
 *    `deno.json` `imports` every package uses), `platform: "node"`, `format: "esm"`, externals
 *    `node:*` only. Any other bare, `jsr:`, `npm:` or `https:` specifier fails the bundle.
 * 2. Writes a fixture app (hand-written self-contained `dist/app.js` + `dist/app.js.map`, an icon
 *    asset, a `node_modules/.bin` symlink and devDependencies — what a developer's tree looks like).
 * 3. Runs the bundle under `node` with `PATH` holding only node's own directory (so no `deno` can
 *    be reached), calling `assembleApp` and `validateAssembled`, and prints the results as JSON.
 *
 * Exit 0 iff the build succeeded, validate said ok, and the artifact carries the source map.
 */
// Builtins via `process.getBuiltinModule` rather than `import … from "node:…"`: core's
// `deno check packages/` reads this file too, and a static `node:` import there makes Deno look
// for `@types/node` (core runs in manual node_modules mode; see src/node/path.d.ts).
const { execFileSync, spawnSync } = process.getBuiltinModule("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = process
  .getBuiltinModule("node:fs");
const { tmpdir } = process.getBuiltinModule("node:os");
const { dirname, join, resolve } = process.getBuiltinModule("node:path");
const { fileURLToPath, pathToFileURL } = process.getBuiltinModule("node:url");

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_BUILD = resolve(HERE, "..");
const PACKAGES = resolve(APP_BUILD, "..");
const keep = process.argv.includes("--keep");
const work = mkdtempSync(join(tmpdir(), "w6w-node-smoke-"));

/** `@w6w/*` exactly as core's import maps resolve it (exact keys only, like Deno). */
function importMapFor(importer) {
  let dir = dirname(importer);
  while (dir.startsWith(PACKAGES) && dir !== PACKAGES) {
    try {
      const cfg = JSON.parse(readFileSync(join(dir, "deno.json"), "utf8"));
      return { dir, imports: cfg.imports ?? {} };
    } catch { /* keep walking up */ }
    dir = dirname(dir);
  }
  return { dir, imports: {} };
}

// ---- 1. bundle ----
const bundleScript = join(work, "bundle.mjs");
const outFile = join(work, "assemble.bundle.mjs");
writeFileSync(
  bundleScript,
  `
const esbuild = await import(process.env.ESBUILD_MAIN);
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
const PACKAGES = ${JSON.stringify(PACKAGES)};
${importMapFor.toString()}
const coreImportMaps = {
  name: "core-import-maps",
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      const p = args.path;
      if (p.startsWith("node:")) return { path: p, external: true };
      if (p.startsWith(".") || p.startsWith("/")) return undefined;
      if (/^(jsr|npm|https?):/.test(p)) {
        return { errors: [{ text: "forbidden specifier " + p + " (imported by " + args.importer + ")" }] };
      }
      const { dir, imports } = importMapFor(args.importer);
      if (imports[p] !== undefined) return { path: resolve(dir, imports[p]) };
      return { errors: [{ text: "unmapped bare specifier " + p + " (imported by " + args.importer + ")" }] };
    });
  },
};
const r = await esbuild.build({
  entryPoints: [${JSON.stringify(join(APP_BUILD, "assemble.ts"))}],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: ${JSON.stringify(outFile)},
  plugins: [coreImportMaps],
  logLevel: "warning",
  metafile: true,
});
console.log(JSON.stringify({ inputs: Object.keys(r.metafile.inputs).length,
  external: [...new Set(Object.values(r.metafile.outputs).flatMap((o) => o.imports.filter((i) => i.external).map((i) => i.path)))] }));
`,
);
// esbuild comes from npx's cache (dev-time only); the bundle script imports it by absolute path.
const esbuildBin = execFileSync(
  "npx",
  ["--yes", "-p", "esbuild@0.28.2", "-c", "command -v esbuild"],
  { encoding: "utf8", cwd: work },
).trim();
const esbuildMain = pathToFileURL(
  join(dirname(dirname(esbuildBin)), "esbuild", "lib", "main.js"),
).href;
const bundled = execFileSync(process.execPath, [bundleScript], {
  encoding: "utf8",
  env: { ...process.env, ESBUILD_MAIN: esbuildMain },
});
console.log(`bundle: ${outFile} (${readFileSync(outFile).length} bytes) ${bundled.trim()}`);

// ---- 2. fixture app ----
const app = join(work, "my-app");
const files = {
  "package.json": JSON.stringify(
    {
      name: "my-w6w-app",
      version: "1.2.3",
      description: "A developer-built app",
      license: "MIT",
      author: { name: "dev" },
      categories: ["developer-tools"],
      devDependencies: { esbuild: "0.28.2", typescript: "5.9.3", "@types/node": "24.0.0" },
      scripts: { build: "esbuild src/index.ts --bundle --format=esm --outfile=dist/app.js" },
      w6w: {
        id: "io.example.smoke",
        displayName: "Smoke",
        appearance: { icon: { svg: "./assets/icon.svg" } },
        entry: "./dist/app.js",
      },
    },
    null,
    2,
  ),
  "src/index.ts": "// the developer's TypeScript source (not read by assembleApp)\n",
  "assets/icon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>`,
  "dist/app.js": [
    "var ping = {",
    '  key: "ping", title: "Ping", description: "Ping the service.",',
    "  params: [],",
    '  output: [{ key: "ok", type: "boolean" }],',
    "  sample: { ok: true },",
    "  async execute() { return { ok: true }; }",
    "};",
    "var app = { actions: [ping], auth: [], triggers: [], healthChecks: [] };",
    "export { app as default };",
    "//# sourceMappingURL=app.js.map",
    "",
  ].join("\n"),
  "dist/app.js.map": JSON.stringify({
    version: 3,
    sources: ["../src/index.ts"],
    names: [],
    mappings: "AAAA",
  }),
  "node_modules/esbuild/package.json": "{}",
};
for (const [rel, content] of Object.entries(files)) {
  mkdirSync(dirname(join(app, rel)), { recursive: true });
  writeFileSync(join(app, rel), content);
}
mkdirSync(join(app, "node_modules/.bin"), { recursive: true });
symlinkSync("../esbuild/package.json", join(app, "node_modules/.bin/esbuild"));

// ---- 3. run under node only ----
const runner = join(work, "run.mjs");
writeFileSync(
  runner,
  `
import { assembleApp, validateAssembled } from ${JSON.stringify(outFile)};
import { readFileSync } from "node:fs";
import { join } from "node:path";
const r = await assembleApp(${JSON.stringify(app)}, ${JSON.stringify(join(work, "out"))});
const manifest = JSON.parse(readFileSync(join(r.outDir, "manifest.json"), "utf8"));
const v = await validateAssembled(${JSON.stringify(app)});
const bad = await validateAssembled(${JSON.stringify(join(work, "missing"))});
console.log(JSON.stringify({
  deno: typeof globalThis.Deno,
  node: process.versions.node,
  result: r,
  buildInfo: manifest.buildInfo,
  map: manifest.map,
  actions: manifest.actions.map((a) => a.key),
  icon: manifest.manifest.appearance.icon.svg.slice(0, 26) + "…",
  appJsTail: readFileSync(join(r.outDir, "app.js"), "utf8").trimEnd().split("\\n").pop(),
  mapSources: JSON.parse(readFileSync(join(r.outDir, "app.js.map"), "utf8")).sources,
  validate: v,
  validateMissing: bad,
}, null, 2));
`,
);
const run = spawnSync(process.execPath, [runner], {
  encoding: "utf8",
  env: { PATH: dirname(process.execPath), HOME: work },
});
process.stdout.write(run.stdout);
process.stderr.write(run.stderr);
let ok = run.status === 0;
if (ok) {
  const out = JSON.parse(run.stdout);
  ok = out.deno === "undefined" && out.validate.ok === true && out.buildInfo.sourcemap === true &&
    typeof out.buildInfo.nodeVersion === "string" && out.validateMissing.ok === false;
}
console.log(`node-smoke: ${ok ? "ok" : "FAILED"}`);
if (!keep) rmSync(work, { recursive: true, force: true });
else console.log(`kept ${work}`);
process.exit(ok ? 0 : 1);
