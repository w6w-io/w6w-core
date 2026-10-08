/**
 * T1.2.2 — `LoadedApp.dir`/`entryPath` survive as optional, deprecated aliases that exist
 * ONLY on dir-kind apps (the server's asset inliner still reads `loadedApp.dir`).
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0";
import type { AppArtifactManifest } from "@w6w/types";
import { sha256Hex } from "@w6w/types";
import { describeExec, loadApp, loadedAppFromArtifact, manifestFromPackageJson } from "../mod.ts";

const FIXTURES = new URL("../../../fixtures/apps/", import.meta.url);

Deno.test("dir-kind app carries dir/entryPath as own properties equal to code", async () => {
  const app = await loadApp(fromFileUrl(new URL("hello", FIXTURES)));
  assertEquals(app.code.kind, "dir");
  if (app.code.kind !== "dir") throw new Error("unreachable");
  assertEquals(app.dir, app.code.dir);
  assertEquals(app.entryPath, app.code.entryPath);
  assertEquals(typeof app.dir, "string");
  assertEquals(typeof app.entryPath, "string");
  assert(Object.hasOwn(app, "dir") && Object.hasOwn(app, "entryPath"));
  // T-c (type level): the member is optional, not `string`.
  const d: string | undefined = app.dir;
  assert(d !== undefined);
});

Deno.test("exec-kind app has neither dir nor entryPath as an own property", async () => {
  const fix = fromFileUrl(new URL("exec-hooks", FIXTURES));
  const code = await Deno.readTextFile(join(fix, "app.js"));
  const pkg = JSON.parse(await Deno.readTextFile(join(fix, "package.json")));
  const art: AppArtifactManifest = {
    artifactVersion: 1,
    id: pkg.w6w.id,
    version: pkg.version,
    manifest: manifestFromPackageJson(pkg),
    ...(await describeExec(code)),
    exec: {
      sha256: await sha256Hex(code),
      bytes: new TextEncoder().encode(code).length,
      format: "esm",
    },
    sourceDigest: "0".repeat(64),
    buildInfo: { builder: "test", denoVersion: Deno.version.deno, minify: false, sourcemap: false },
  };
  const app = await loadedAppFromArtifact(art, code);
  assertEquals(app.code.kind, "exec");
  assertEquals(Object.hasOwn(app, "dir"), false);
  assertEquals(Object.hasOwn(app, "entryPath"), false);
  const d: string | undefined = app.dir;
  assertEquals(d, undefined);
});
