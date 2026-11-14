/**
 * Pins the `ctx.host` boundary (N2 requirement 3). `ctx.host` (`HookContext.host`,
 * types/src/hooks.ts:42) is declared but is NOT populated anywhere in this repo: the sandbox
 * builds the hook context in `sandbox/worker.ts` (`const ctx = { fetch, socket, log, connection,
 * invocation, file }`) with no `host` key, and no `RunHookOptions` field can inject one. So an
 * app — third-party or not — never sees `ctx.host` from the reference runtime or the server
 * (server/packages/api has no `host:` context producer). A host that wants a first-party-only
 * extension must add it deliberately; this test fails the moment a key appears for any app.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { runHook } from "../mod.ts";

Deno.test("sandbox hook context carries no `host` key for an app (first-party or not)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ctx-host-pin-" });
  try {
    const entryPath = `${dir}/index.js`;
    await Deno.writeTextFile(
      entryPath,
      `export default { actions: [{ key: "probe", execute: (_i, ctx) => ({
        hasHost: "host" in ctx, host: ctx.host === undefined ? null : "present",
        keys: Object.keys(ctx).sort() }) }] };`,
    );
    const r = await runHook<{ hasHost: boolean; host: string | null; keys: string[] }>({
      entryPath,
      selector: { kind: "action", key: "probe" },
      input: {},
      readScope: dir,
    });
    assertEquals(r.hasHost, false);
    assertEquals(r.host, null);
    assert(r.keys.includes("fetch") && r.keys.includes("log"), `ctx keys: ${r.keys}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
