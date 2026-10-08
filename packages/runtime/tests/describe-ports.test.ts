/** describe(): field-wise folding of App ports into each served action. */
import { assert, assertEquals, assertFalse, assertNotStrictEquals } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import type { Ports } from "@w6w/types";
import { describe, loadApp } from "../mod.ts";
import type { LoadedApp } from "../mod.ts";

const DIR = fromFileUrl(new URL("../../../fixtures/apps/sendgrid", import.meta.url));

/** Load, then set ports on the manifest and (optionally) on the first action. */
async function withPorts(appPorts?: Ports, actionPorts?: Ports): Promise<LoadedApp> {
  const app = await loadApp(DIR);
  const manifest = { ...app.manifest };
  delete (manifest as { ports?: Ports }).ports;
  if (appPorts) manifest.ports = appPorts;
  const actions = new Map(app.actions);
  const [key, a] = [...actions.entries()][0];
  const definition = { ...a.definition };
  delete (definition as { ports?: Ports }).ports;
  if (actionPorts) definition.ports = actionPorts;
  actions.set(key, { ...a, definition });
  return { ...app, manifest, actions };
}

const first = (app: LoadedApp) => describe(app).actions[0];

Deno.test("fold: app {out:1} + action {in:3} => {in:3,out:1}", async () => {
  const app = await withPorts({ out: 1 }, { in: 3 });
  assertEquals(first(app).ports, { in: 3, out: 1 });
});

Deno.test("fold: action out overrides app out", async () => {
  const app = await withPorts({ out: 1 }, { out: "many" });
  assertEquals(first(app).ports, { out: "many" });
});

Deno.test("fold: app ports alone are served", async () => {
  const app = await withPorts({ in: 2 });
  assertEquals(first(app).ports, { in: 2 });
});

Deno.test("fold: neither declared => no ports key, same as definition", async () => {
  const app = await withPorts();
  const served = first(app);
  assertFalse("ports" in served);
  assertEquals(served, [...app.actions.values()][0].definition);
});

Deno.test("fold: loaded definition is not mutated", async () => {
  const app = await withPorts({ out: 1 }, { in: 3 });
  const def = [...app.actions.values()][0].definition;
  const before = structuredClone(def);
  const served = first(app);
  assertNotStrictEquals(served, def);
  assertEquals(def, before);
  assertEquals(def.ports, { in: 3 });
  const app2 = await withPorts({ out: 1 });
  first(app2);
  assert(!("ports" in [...app2.actions.values()][0].definition));
});
