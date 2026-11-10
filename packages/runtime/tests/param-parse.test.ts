/**
 * `ParamDefinition.parse`: the sandbox applies an app's own param parsers to an
 * Action's `execute` input and to a trigger hook's `params`, and `describe()`
 * never lets the function reach the manifest.
 */
import { assertEquals, assertFalse, assertRejects } from "jsr:@std/assert@^1.0.0";
import { join } from "jsr:@std/path@^1.0.0";
import { describe, invoke, loadApp, W6WError } from "../mod.ts";
import { invokeTriggerHook } from "../src/runtime.ts";

const INDEX = `
const toId = (v) => {
  const m = /\\/d\\/([A-Za-z0-9_-]+)/.exec(String(v));
  return m ? m[1] : v;
};
const reject = (v) => { if (v === "bad") throw new Error("bad value"); return v; };
const params = [
  { key: "id", label: "ID", type: "string", required: true, parse: toId },
  { key: "strict", label: "Strict", type: "string", parse: reject },
  {
    key: "rows", label: "Rows", type: "group", repeat: true,
    children: [{ key: "ref", label: "Ref", type: "string", parse: toId }],
  },
];
export default {
  actions: [{
    key: "echo", type: "read", title: "Echo", params,
    execute(input) { return input; },
  }],
  triggers: [{
    key: "pl", title: "PL", params,
    poll({ params }) { return { events: [params] }; },
  }],
};
`;

async function withApp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "@w6w-fixtures/param-parse",
        version: "1.0.0",
        description: "Temp fixture app for param-parse.test.ts.",
        license: "MIT",
        author: { name: "w6w" },
        categories: ["developer-tools"],
        private: true,
        w6w: {
          id: "io.w6w.param-parse",
          displayName: "Param Parse",
          appearance: { icon: { svg: "./assets/icon.svg" } },
          entry: "./index.ts",
        },
      }),
    );
    await Deno.writeTextFile(join(dir, "index.ts"), INDEX);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const URL_ID =
  "https://docs.google.com/spreadsheets/d/1OQ_egJWTCDY0J7NI3v6GJ9L7K1oHJGCF6Wg/edit#gid=0";

Deno.test("execute sees parsed params, top level and inside a repeat group", async () => {
  await withApp(async (dir) => {
    const app = await loadApp(dir);
    const result = await invoke(app, {
      manifestVersion: "1",
      app: "io.w6w.param-parse",
      action: "echo",
      params: { id: URL_ID, rows: [{ ref: URL_ID }, { ref: "plain" }] },
    });
    assertEquals(result.value, {
      id: "1OQ_egJWTCDY0J7NI3v6GJ9L7K1oHJGCF6Wg",
      rows: [{ ref: "1OQ_egJWTCDY0J7NI3v6GJ9L7K1oHJGCF6Wg" }, { ref: "plain" }],
    });
  });
});

Deno.test("a parser that throws fails the call as hook_failed", async () => {
  await withApp(async (dir) => {
    const app = await loadApp(dir);
    const err = await assertRejects(
      () =>
        invoke(app, {
          manifestVersion: "1",
          app: "io.w6w.param-parse",
          action: "echo",
          params: { id: "x", strict: "bad" },
        }),
      W6WError,
    );
    assertEquals(err.code, "hook_failed");
  });
});

Deno.test("a trigger hook sees parsed params", async () => {
  await withApp(async (dir) => {
    const app = await loadApp(dir);
    const out = await invokeTriggerHook(app, {
      triggerKey: "pl",
      hook: "poll",
      input: { params: { id: URL_ID }, state: null, subscriptionId: "s" },
    });
    assertEquals(out, { events: [{ id: "1OQ_egJWTCDY0J7NI3v6GJ9L7K1oHJGCF6Wg" }] });
  });
});

Deno.test("describe() drops parse from every param", async () => {
  await withApp(async (dir) => {
    const app = await loadApp(dir);
    const json = JSON.stringify(describe(app));
    assertFalse(json.includes('"parse"'));
  });
});
