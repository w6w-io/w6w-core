/**
 * T1.2.1 — `kind: "exec"` apps: hooks run from a `data:` URL in a Worker with NO read
 * permission. One import-free fixture (`fixtures/apps/exec-hooks`) is loaded both as a
 * dir (`loadApp`) and as exec code (`loadedAppFromArtifact`), so every site is proven
 * through its PUBLIC entry point and the dir/exec descriptions can be compared.
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1.0.0";
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0";
import type { AppArtifactManifest, Connection, ConnectionTarget, Invocation } from "@w6w/types";
import { sha256Hex } from "@w6w/types";
import {
  checkHealth,
  describe,
  describeApp,
  describeExec,
  hookSource,
  invoke,
  invokeTriggerHook,
  loadApp,
  loadedAppFromArtifact,
  LoadError,
  manifestFromPackageJson,
  runAuthHook,
  runHandshake,
  runHook,
  signingFetch,
} from "../mod.ts";
import type { LoadedApp } from "../mod.ts";
import { runWorker } from "../src/sandbox/run-hook.ts";

const FIX = fromFileUrl(new URL("../../../fixtures/apps/exec-hooks", import.meta.url));
const THIS_FILE = fromFileUrl(import.meta.url);
const WORKER_TS = fromFileUrl(new URL("../src/sandbox/worker.ts", import.meta.url));
const FIX_PKG = join(FIX, "package.json");
const ID = "io.w6w.exec-hooks";

const CODE = await Deno.readTextFile(join(FIX, "app.js"));

async function artifact(code = CODE): Promise<AppArtifactManifest> {
  const pkg = JSON.parse(await Deno.readTextFile(FIX_PKG));
  const described = await describeExec(code);
  const bytes = new TextEncoder().encode(code);
  return {
    artifactVersion: 1,
    id: ID,
    version: pkg.version,
    manifest: manifestFromPackageJson(pkg),
    ...described,
    exec: { sha256: await sha256Hex(code), bytes: bytes.length, format: "esm" },
    sourceDigest: "0".repeat(64),
    buildInfo: { builder: "test", denoVersion: Deno.version.deno, minify: false, sourcemap: false },
  };
}

async function execApp(): Promise<LoadedApp> {
  return await loadedAppFromArtifact(await artifact(), CODE);
}

const CONN: Connection = {
  manifestVersion: "1",
  id: "conn_exec",
  app: ID,
  auth: "api-key",
  owner: "user_1",
  state: "connected",
  credential: { apiKey: "k1" },
  createdAt: "2026-05-24T00:00:00Z",
};

function inv(action: string, params?: Record<string, unknown>): Invocation {
  return { manifestVersion: "1", app: ID, action, connection: CONN.id, params };
}

/** A one-shot local endpoint that echoes the Authorization header it receives. */
function echoServer() {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) =>
      new Response(JSON.stringify({ authorization: req.headers.get("authorization") }), {
        headers: { "content-type": "application/json" },
      }),
  );
  return { server, url: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}/` };
}

// --- acceptance 2: every spawn site, through its public entry point ---------------------

Deno.test("exec: invoke (execute) runs the action from the data: URL", async () => {
  const app = await execApp();
  assertEquals(app.code.kind, "exec");
  const r = await invoke(app, inv("echo", { text: "hi" }), { connection: CONN });
  assertEquals((r.value as { text: string }).text, "hi");
});

Deno.test("exec: signingFetch runs the auth `sign` hook", async () => {
  const app = await execApp();
  const { server, url } = echoServer();
  try {
    const f = signingFetch(app, app.auths[0], { apiKey: "k-sign" }, {});
    const res = await f({ url, method: "GET", headers: {} });
    assertEquals(JSON.parse(new TextDecoder().decode(res.body)).authorization, "Bearer k-sign");
  } finally {
    await server.shutdown();
  }
});

Deno.test("exec: needs_refresh runs the `refresh` hook, then signs with the new credential", async () => {
  const app = await execApp();
  const { server, url } = echoServer();
  try {
    const r = await invoke(app, inv("fetch-it", { url }), {
      connection: { ...CONN, state: "needs_refresh" },
    });
    assertEquals(
      (r.value as { body: { authorization: string } }).body.authorization,
      "Bearer k1-refreshed",
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("exec: runAuthHook runs a credential hook", async () => {
  const app = await execApp();
  const r = await runAuthHook<{ ok: boolean; label: string }>(app, app.auths[0], "test", {
    apiKey: "k2",
  });
  assertEquals(r, { ok: true, label: "key k2 café ✓" });
});

Deno.test("exec: invokeTriggerHook runs a trigger hook", async () => {
  const app = await execApp();
  const r = await invokeTriggerHook(app, {
    triggerKey: "wh",
    hook: "handleIngest",
    input: { raw: { method: "POST" } },
  });
  assertEquals(r, [{ method: "POST", via: "exec" }]);
});

Deno.test("exec: checkHealth runs a declared check hook", async () => {
  const app = await execApp();
  const r = await checkHealth(app, "ping");
  assertEquals(r.report.state, "ok");
  assertEquals(r.report.message, "pong café ✓");
});

Deno.test("exec: runHandshake drives the `handshake` hook against an in-memory Deno.Conn", async () => {
  const app = await execApp();
  const written: number[][] = [];
  const reply = new Uint8Array([9, 8]);
  let served = false;
  const conn = {
    write: (b: Uint8Array) => {
      written.push([...b]);
      return Promise.resolve(b.length);
    },
    read: (buf: Uint8Array) => {
      if (served) return Promise.resolve(null);
      served = true;
      buf.set(reply);
      return Promise.resolve(reply.length);
    },
    close: () => {},
  } as unknown as Deno.Conn;
  const target: ConnectionTarget = { host: "h", port: 1, tlsMode: "disable" };
  const leftover = await runHandshake(app, app.auths[0], target, { apiKey: "k" }, conn);
  assertEquals(written, [[1, 2, 3]]);
  assertEquals([...(leftover ?? [])], [9, 8]);
});

Deno.test("exec: ctx.file (host-mediated) still works under read:false", async () => {
  const app = await execApp();
  const r = await invoke(app, inv("make-file"), {
    connection: CONN,
    onFileRead: () => Promise.reject(new Error("unused")),
    onFileCreate: (i: { contentType: string; filename: string }) =>
      Promise.resolve({ id: "f1", contentType: i.contentType, filename: i.filename, size: 3 }),
  } as never);
  assertEquals((r.value as { ref: { id: string } }).ref.id, "f1");
});

// --- acceptance 3: read denied ---------------------------------------------------------

Deno.test("exec: the Worker cannot read the test file, the fixture's package.json, or worker.ts", async () => {
  const app = await execApp();
  const paths = [THIS_FILE, FIX_PKG, WORKER_TS];
  const r = await invoke(app, inv("read-probe", { paths }), { connection: CONN });
  assertEquals((r.value as { results: string[] }).results, [
    "NotCapable",
    "NotCapable",
    "NotCapable",
  ]);
});

Deno.test("dir: the same probe CAN read the fixture's package.json (the probe can read at all)", async () => {
  const app = await loadApp(FIX);
  const r = await invoke(app, inv("read-probe", { paths: [FIX_PKG] }), { connection: CONN });
  assertEquals((r.value as { results: string[] }).results, ["ok"]);
});

Deno.test("describeExec: a top-level read in exec code rejects", async () => {
  const code = `Deno.readTextFileSync(${
    JSON.stringify(THIS_FILE)
  });\nexport default { actions: [] };`;
  await assertRejects(() => describeExec(code));
});

function dataUrl(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:text/javascript;base64,${btoa(bin)}`;
}

Deno.test("runWorker: an entryUrl start ignores a supplied readScope (read stays false)", async () => {
  const r = await runWorker<{ results: string[] }>({
    type: "start",
    op: "call",
    entryUrl: dataUrl(CODE),
    selector: { kind: "action", key: "read-probe" },
    input: { paths: [FIX_PKG] },
    enableFetch: false,
    enableSocket: false,
    enableFile: false,
  }, { readScope: FIX });
  assertEquals((r as unknown as { results: string[] }).results, ["NotCapable"]);
});

Deno.test("runWorker: a non-data: entryUrl throws before spawning", () => {
  for (const entryUrl of [`file://${WORKER_TS}`, "data:text/plain;base64,AAAA", "https://x/y.js"]) {
    assertThrows(
      () => runWorker({ type: "start", op: "describe-app", entryUrl }, { readScope: FIX }),
      Error,
      "entryUrl must begin",
    );
  }
});

Deno.test("runWorker: an entryPath start without a readScope throws before spawning", () => {
  assertThrows(
    () => runWorker({ type: "start", op: "describe-app", entryPath: join(FIX, "app.js") }, {}),
    Error,
    "readScope",
  );
});

Deno.test("hookSource: dir yields path + scope, exec yields the code object", async () => {
  const dir = await loadApp(FIX);
  const src = hookSource(dir) as { entryPath: string; readScope: string };
  assertEquals(src, { entryPath: join(FIX, "app.js"), readScope: FIX });
  const exec = await execApp();
  assertEquals("code" in hookSource(exec), true);
  // runHook is reachable directly with the same spread.
  const r = await runHook({
    ...hookSource(exec),
    selector: { kind: "action", key: "echo" },
    input: { text: "x" },
  });
  assertEquals(r, { text: "x" });
});

// --- acceptance 4: non-ASCII -----------------------------------------------------------

Deno.test("exec: non-ASCII text round-trips exactly (UTF-8 base64, not btoa(code))", async () => {
  const app = await execApp();
  const r = await invoke(app, inv("echo", { text: "café ✓" }), { connection: CONN });
  assertEquals((r.value as { text: string }).text, "café ✓");
  // The fixture's own source is non-ASCII, so a Latin-1 encoder could not have loaded it.
  assert([...CODE].some((c) => c.charCodeAt(0) > 0xff));
});

// --- acceptance 5: parity and assembler ------------------------------------------------

Deno.test("describeExec(code) deep-equals describeApp(path, dir)", async () => {
  assertEquals(await describeExec(CODE), await describeApp(join(FIX, "app.js"), FIX));
});

Deno.test("loadedAppFromArtifact deep-equals loadApp through describe()", async () => {
  const fromDir = describe(await loadApp(FIX));
  const fromArtifact = describe(await loadedAppFromArtifact(await artifact(), CODE));
  assertEquals(fromArtifact, fromDir);
});

Deno.test("loadedAppFromArtifact: definitions come from the STORED manifest", async () => {
  const m = await artifact();
  m.actions = [...m.actions, { ...m.actions[0], key: "ghost" }];
  const app = await loadedAppFromArtifact(m, CODE);
  assert(app.actions.has("ghost"));
  assert(describe(app).actions.some((a) => a.key === "ghost"));
});

Deno.test("loadedAppFromArtifact: a wrong sha is exec_sha_mismatch", async () => {
  const m = await artifact();
  const err = await assertRejects(() => loadedAppFromArtifact(m, CODE + " "), LoadError);
  assertEquals(err.code, "exec_sha_mismatch");
});

Deno.test("loadedAppFromArtifact: host overwrites trigger.type from the hooks", async () => {
  const m = await artifact();
  m.triggers = [{ trigger: { ...m.triggers[0].trigger, type: "webhook" }, hooks: ["poll"] }];
  const app = await loadedAppFromArtifact(m, CODE);
  assertEquals(app.triggers.get("wh")?.trigger.type, "poll");
});

Deno.test("loadedAppFromArtifact: onSubscribe without onUnsubscribe is invalid_trigger", async () => {
  const m = await artifact();
  m.triggers = [{ trigger: m.triggers[0].trigger, hooks: ["onSubscribe"] }];
  const err = await assertRejects(() => loadedAppFromArtifact(m, CODE), LoadError);
  assertEquals(err.code, "invalid_trigger");
});

Deno.test("loadedAppFromArtifact: the input manifest is not mutated", async () => {
  const m = await artifact();
  m.triggers = [{ trigger: { ...m.triggers[0].trigger, type: "webhook" }, hooks: ["poll"] }];
  const before = structuredClone(m);
  await loadedAppFromArtifact(m, CODE);
  assertEquals(m, before);
  assertNotEquals(m.triggers[0].trigger.type, "poll");
});
