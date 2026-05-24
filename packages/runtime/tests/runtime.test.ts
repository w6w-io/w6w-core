import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { describe, invoke, loadApp, W6WError } from "../mod.ts";
import type { Invocation } from "@w6w/types";

const HELLO_DIR = fromFileUrl(new URL("../../../fixtures/apps/hello", import.meta.url));

function inv(action: string, params?: Record<string, unknown>): Invocation {
  return { manifestVersion: "1", app: "com.w6w.hello", action, params };
}

Deno.test("loadApp + describe returns the manifest and actions", async () => {
  const app = await loadApp(HELLO_DIR);
  const desc = describe(app);

  assertEquals(desc.app.id, "com.w6w.hello");
  assertEquals(desc.app.displayName, "Hello");
  const keys = desc.actions.map((a) => a.key).sort();
  assertEquals(keys, ["escape-attempt", "get-greeting"]);
});

Deno.test("manifest is sourced from package.json (no app.json)", async () => {
  const app = await loadApp(HELLO_DIR);
  const { app: m } = describe(app);

  // From the `w6w` block:
  assertEquals(m.id, "com.w6w.hello");
  assertEquals(m.displayName, "Hello");
  assertEquals(m.categories, ["developer-tools"]);
  // Reused from native package.json fields:
  assertEquals(m.name, "hello"); // npm scope stripped from @w6w-fixtures/hello
  assertEquals(m.version, "1.0.0");
  assertEquals(m.license, "MIT");
  assertEquals(m.author.name, "w6w");
});

Deno.test("invoke runs an action in the sandbox", async () => {
  const app = await loadApp(HELLO_DIR);
  const result = await invoke(app, inv("get-greeting", { name: "Ada" }));
  assertEquals(result.value, { greeting: "Hello, Ada." });
});

Deno.test("invoke applies param defaults", async () => {
  const app = await loadApp(HELLO_DIR);
  const result = await invoke(app, inv("get-greeting", { name: "Ada", excited: true }));
  assertEquals(result.value, { greeting: "Hello, Ada!" });
});

Deno.test("invoke rejects a missing required param before reaching the sandbox", async () => {
  const app = await loadApp(HELLO_DIR);
  const err = await assertRejects(
    () => invoke(app, inv("get-greeting", {})),
    W6WError,
  );
  assertEquals(err.code, "param_invalid");
  assertEquals(err.phase, "resolution");
});

Deno.test("invoke rejects declarative validation failure", async () => {
  const app = await loadApp(HELLO_DIR);
  const tooLong = "x".repeat(51);
  const err = await assertRejects(
    () => invoke(app, inv("get-greeting", { name: tooLong })),
    W6WError,
  );
  assertEquals(err.code, "param_invalid");
});

Deno.test("invoke rejects an unknown action", async () => {
  const app = await loadApp(HELLO_DIR);
  const err = await assertRejects(
    () => invoke(app, inv("does-not-exist")),
    W6WError,
  );
  assertEquals(err.code, "unknown_action");
});

Deno.test("sandbox denies filesystem escape", async () => {
  const app = await loadApp(HELLO_DIR);
  const err = await assertRejects(
    () => invoke(app, inv("escape-attempt")),
    W6WError,
  );
  assertEquals(err.code, "hook_failed");
  assertEquals(err.phase, "execute");
});
