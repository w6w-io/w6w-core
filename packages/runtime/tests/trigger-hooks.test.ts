import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0";
import { describe, loadApp, LoadError } from "../mod.ts";
import { invokeTriggerHook } from "../src/runtime.ts";
import { TRIGGER_HOOK_KINDS } from "@w6w/types";
import type { HandleIngestHook, TriggerCall, TriggerDefinition } from "@w6w/types";

const FIXTURE = fromFileUrl(new URL("../../../fixtures/apps/trigger-hooks", import.meta.url));

function pkgJson(): Record<string, unknown> {
  return {
    name: "@w6w-fixtures/temp",
    version: "1.0.0",
    description: "Temp fixture app for trigger-hooks.test.ts.",
    license: "MIT",
    author: { name: "w6w" },
    categories: ["developer-tools"],
    private: true,
    w6w: {
      id: "io.w6w.temp",
      displayName: "Temp",
      appearance: { icon: { svg: "./assets/icon.svg" } },
      entry: "./index.ts",
    },
  };
}

async function withTempApp(indexBody: string, fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(dir, "package.json"), JSON.stringify(pkgJson(), null, 2));
    await Deno.writeTextFile(join(dir, "index.ts"), indexBody);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const body = (trigger: string) => `export default { triggers: [${trigger}] };\n`;

async function assertInvalidTrigger(indexBody: string): Promise<void> {
  await withTempApp(indexBody, async (dir) => {
    const err = await assertRejects(() => loadApp(dir), LoadError);
    assertEquals((err as LoadError).code, "invalid_trigger");
  });
}

Deno.test("(a) onSubscribe without onUnsubscribe is invalid_trigger", async () => {
  await assertInvalidTrigger(
    body(`{ key: "t", title: "T", onSubscribe() { return {}; } }`),
  );
});

Deno.test("(b) poll together with onSubscribe is invalid_trigger", async () => {
  await assertInvalidTrigger(
    body(
      `{ key: "t", title: "T", poll() { return { events: [] }; }, onSubscribe() { return {}; }, onUnsubscribe() {} }`,
    ),
  );
});

Deno.test("(c) type is derived: wh webhook, pl poll, also through describe()", async () => {
  const app = await loadApp(FIXTURE);
  assertEquals(app.triggers.get("wh")?.trigger.type, "webhook");
  assertEquals(app.triggers.get("pl")?.trigger.type, "poll");
  assertEquals(app.triggers.get("pl")?.trigger.minIntervalMs, 120000);
  const described = describe(app).triggers;
  assertEquals(described.find((t) => t.key === "wh")?.type, "webhook");
  assertEquals(described.find((t) => t.key === "pl")?.type, "poll");
});

Deno.test("(d) an authored type on a hook-less trigger is overwritten with webhook", async () => {
  await withTempApp(body(`{ key: "t", title: "T", type: "poll" }`), async (dir) => {
    const app = await loadApp(dir);
    assertEquals(app.triggers.get("t")?.trigger.type, "webhook");
    assertEquals(app.triggers.get("t")?.hooks.size, 0);
  });
});

Deno.test("(e) invokeTriggerHook runs poll against the fixture", async () => {
  const app = await loadApp(FIXTURE);
  const out = await invokeTriggerHook(app, {
    triggerKey: "pl",
    hook: "poll",
    input: { params: {}, state: { n: 2 }, subscriptionId: "s" },
  });
  assertEquals(out, { events: [{ n: 3 }], nextState: { n: 3 } });
});

Deno.test("(f) invokeTriggerHook runs parseOutput on wh", async () => {
  const app = await loadApp(FIXTURE);
  const out = await invokeTriggerHook(app, {
    triggerKey: "wh",
    hook: "parseOutput",
    input: { call: { method: "PUT" }, normalized: { x: 1 }, subscriptionId: "s" },
  });
  assertEquals(out, { parsed: true, method: "PUT", value: { x: 1 } });
});

Deno.test("(g) handleIngest on wh: array body fans out, query.fail rejects", async () => {
  const app = await loadApp(FIXTURE);
  const call = (over: Partial<TriggerCall>): TriggerCall => ({
    method: "POST",
    path: "/triggers/webhooks/s",
    query: {},
    headers: {},
    body: null,
    ...over,
  });
  const run = (raw: TriggerCall) =>
    invokeTriggerHook(app, {
      triggerKey: "wh",
      hook: "handleIngest",
      input: { raw, params: {}, state: null, subscriptionId: "s" },
    });
  assertEquals(((await run(call({ body: [1, 2] }))) as unknown[]).length, 2);
  await assertRejects(() => run(call({ query: { fail: "1" } })));
  // sawAuth is true only for an unmasked authorization header, and never echoes it.
  const seen = await run(call({ headers: { authorization: "Bearer s3cret" } })) as Array<
    { sawAuth: boolean }
  >;
  assertEquals(seen[0].sawAuth, true);
  assert(!JSON.stringify(seen).includes("s3cret"));
  const masked = await run(call({ headers: { authorization: "[redacted]" } })) as Array<
    { sawAuth: boolean }
  >;
  assertEquals(masked[0].sawAuth, false);
});

Deno.test("(h) types: handleIngest raw is a TriggerCall; poll needs no handleIngest", () => {
  const ingest: HandleIngestHook = ({ raw }) => [raw.method];
  const def: TriggerDefinition = {
    key: "p",
    title: "P",
    poll: () => ({ events: [] }),
  };
  assert(typeof ingest === "function");
  assertEquals(def.handleIngest, undefined);
  assertEquals([...TRIGGER_HOOK_KINDS], [
    "onSubscribe",
    "onUnsubscribe",
    "handleIngest",
    "poll",
    "parseOutput",
  ]);
});

Deno.test("a trigger declaring no hooks loads as a webhook", async () => {
  await withTempApp(body(`{ key: "t", title: "T" }`), async (dir) => {
    const app = await loadApp(dir);
    assertEquals(app.triggers.get("t")?.trigger.type, "webhook");
  });
});
