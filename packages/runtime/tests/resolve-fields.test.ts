import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import {
  describe,
  invokeResolveFields,
  loadApp,
  RESOLVE_FIELDS_MAX_OPTIONS,
  RESOLVE_FIELDS_TIMEOUT_MS,
  sanitizeResolveFieldsOutput,
  W6WError,
} from "../mod.ts";
import type { Connection, ResolveFieldsInput } from "@w6w/types";

const FIXTURE = fromFileUrl(new URL("../../../fixtures/apps/resolve-fields", import.meta.url));
const SENDGRID = fromFileUrl(new URL("../../../fixtures/apps/sendgrid", import.meta.url));

const CONNECTION: Connection = {
  manifestVersion: "1",
  id: "conn_rf",
  app: "io.w6w.resolve-fields",
  auth: "api-key",
  owner: "user_1",
  state: "connected",
  credential: { apiKey: "rf-key-456" },
  createdAt: "2026-05-24T00:00:00Z",
};

function input(form: Record<string, unknown>, fields = ["channel"]): ResolveFieldsInput {
  return { reason: "init", form, fields, unresolved: [] };
}

function captureServer() {
  let authorization: string | null | undefined;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      authorization = req.headers.get("authorization");
      return new Response("{}", { status: 200 });
    },
  );
  return { server, port: (server.addr as Deno.NetAddr).port, get: () => authorization };
}

/** Run `fn` and return the W6WError it rejects with (fails the test otherwise). */
async function rejection(fn: () => Promise<unknown>): Promise<W6WError> {
  try {
    await fn();
  } catch (e) {
    assert(e instanceof W6WError, `expected W6WError, got ${e}`);
    return e;
  }
  throw new Error("expected rejection");
}

Deno.test("the worker locates resolveFields, not execute", async () => {
  const app = await loadApp(FIXTURE);
  const out = await invokeResolveFields(app, "form", input({}), { connection: CONNECTION });
  // execute() returns { ranExecute: true }; only the hook yields this shape.
  assertEquals(out, { fields: { channel: { options: [{ value: "general", label: "General" }] } } });
});

Deno.test("describe flags an action iff its resolveFields is a function", async () => {
  const app = await loadApp(FIXTURE);
  const byKey = new Map(describe(app).actions.map((a) => [a.key, a]));
  assertEquals(byKey.get("form")?.resolveFields, true);
  // Absent, not false — digests of hook-less actions must not move.
  assertFalse(Object.hasOwn(byKey.get("plain")!, "resolveFields"));
  // A hand-written `resolveFields: true` with no function is stripped.
  assertFalse(Object.hasOwn(byKey.get("fake")!, "resolveFields"));
  assertEquals(byKey.get("fake")?.resolveFields, undefined);
  // The function itself never reaches the description.
  assertFalse(JSON.stringify(describe(app)).includes('resolveFields":{'));
});

Deno.test("describe(sendgrid) leaves every action without a resolveFields key", async () => {
  const app = await loadApp(SENDGRID);
  const actions = describe(app).actions;
  assert(actions.length > 0);
  for (const a of actions) assertFalse(Object.hasOwn(a, "resolveFields"), a.key);
});

Deno.test("posture: unknown action, undeclared hook, missing connection", async () => {
  const app = await loadApp(FIXTURE);
  const unknown = await rejection(() => invokeResolveFields(app, "nope", input({})));
  assertEquals([unknown.code, unknown.phase], ["unknown_action", "resolution"]);

  const undeclared = await rejection(() =>
    invokeResolveFields(app, "plain", input({}), { connection: CONNECTION })
  );
  assertEquals([undeclared.code, undeclared.phase], ["hook_not_declared", "resolution"]);

  // The hand-written `true` is not a hook either.
  const fake = await rejection(() =>
    invokeResolveFields(app, "fake", input({}), { connection: CONNECTION })
  );
  assertEquals(fake.code, "hook_not_declared");

  const noConn = await rejection(() => invokeResolveFields(app, "form", input({})));
  assertEquals([noConn.code, noConn.phase], ["connection_required", "auth"]);
});

Deno.test("sign injects the credential at the wire; the hook sees a redacted connection", async () => {
  const app = await loadApp(FIXTURE);
  const { server, port, get } = captureServer();
  try {
    const out = await invokeResolveFields(
      app,
      "form",
      input({ mode: "isolation", base: `http://127.0.0.1:${port}` }),
      { connection: CONNECTION },
    );
    assertEquals(get(), "Bearer rf-key-456");
    const label = out.fields.channel.options![0].label;
    const [status, keys] = label.split("|");
    assertEquals(status, "status:200");
    assert(keys.startsWith("keys:"));
    const keyList = keys.slice("keys:".length).split(",");
    assertFalse(keyList.includes("credential"));
    assert(keyList.includes("id"));
    assertFalse(JSON.stringify(out).includes("rf-key-456"));
  } finally {
    await server.shutdown();
  }
});

Deno.test("egress off network.allow is denied in phase resolution", async () => {
  const app = await loadApp(FIXTURE);
  const err = await rejection(() =>
    invokeResolveFields(app, "form", input({ mode: "egress", url: "https://evil.example/x" }), {
      connection: CONNECTION,
    })
  );
  assertEquals([err.code, err.phase], ["egress_denied", "resolution"]);
});

Deno.test("a throwing hook rejects hook_failed in phase resolution with its message", async () => {
  const app = await loadApp(FIXTURE);
  const err = await rejection(() =>
    invokeResolveFields(app, "form", input({ mode: "throw", message: "boom-from-hook" }), {
      connection: CONNECTION,
    })
  );
  assertEquals([err.code, err.phase], ["hook_failed", "resolution"]);
  assert(err.message.includes("boom-from-hook"), err.message);
});

Deno.test("a caller can lower the timeout: timeoutMs 300 -> hook_timeout", async () => {
  const app = await loadApp(FIXTURE);
  const t0 = performance.now();
  const err = await rejection(() =>
    invokeResolveFields(app, "form", input({ mode: "hang", ms: 5000 }), {
      connection: CONNECTION,
      timeoutMs: 300,
    })
  );
  assertEquals([err.code, err.phase], ["hook_timeout", "resolution"]);
  assert(performance.now() - t0 < 4000, "the lowered cap must fire well before the hook ends");
});

Deno.test("a caller cannot raise the timeout past 10 s", async () => {
  assertEquals(RESOLVE_FIELDS_TIMEOUT_MS, 10_000);
  const app = await loadApp(FIXTURE);
  const t0 = performance.now();
  const err = await rejection(() =>
    invokeResolveFields(app, "form", input({ mode: "hang", ms: 10_500 }), {
      connection: CONNECTION,
      timeoutMs: 60_000,
    })
  );
  const elapsed = performance.now() - t0;
  assertEquals([err.code, err.phase], ["hook_timeout", "resolution"]);
  assert(elapsed >= 9_500 && elapsed < 12_500, `elapsed ${elapsed}ms`);
});

Deno.test("raw hook output crosses the host sanitiser (wire)", async () => {
  const app = await loadApp(FIXTURE);
  const raw = {
    fields: {
      a: { options: [{ value: "x", label: "X", extra: "dropped" }] },
      b: { options: [{ value: "y", label: "Y" }] },
    },
  };
  const out = await invokeResolveFields(
    app,
    "form",
    input({ mode: "raw", raw }, ["a"]),
    { connection: CONNECTION },
  );
  assertEquals(out, { fields: { a: { options: [{ value: "x", label: "X" }] } } });

  const bad = await rejection(() =>
    invokeResolveFields(app, "form", input({ mode: "raw", raw: ["nope"] }), {
      connection: CONNECTION,
    })
  );
  assertEquals([bad.code, bad.phase], ["invalid_fields_output", "resolution"]);
});

Deno.test("sanitizeResolveFieldsOutput (a): non-object raw / fields throws invalid_fields_output", () => {
  for (
    const raw of [null, undefined, 1, "s", [], { fields: null }, { fields: [] }, { fields: 3 }, {}]
  ) {
    let err: unknown;
    try {
      sanitizeResolveFieldsOutput(raw, ["a"]);
    } catch (e) {
      err = e;
    }
    assert(err instanceof W6WError, JSON.stringify(raw));
    assertEquals([err.code, err.phase], ["invalid_fields_output", "resolution"]);
  }
});

Deno.test("sanitizeResolveFieldsOutput (b): only requested own keys survive; __proto__ sets no prototype", () => {
  const out = sanitizeResolveFieldsOutput(
    { fields: { a: { options: [] }, b: { options: [] } } },
    ["a", "missing"],
  );
  assertEquals(Object.keys(out.fields), ["a"]);

  // Inherited names are not own properties of raw.fields.
  assertEquals(Object.keys(sanitizeResolveFieldsOutput({ fields: {} }, ["toString"]).fields), []);

  const evil = JSON.parse('{"fields":{"__proto__":{"options":[{"value":"p","label":"P"}]}}}');
  const res = sanitizeResolveFieldsOutput(evil, ["__proto__"]);
  assert(Object.hasOwn(res.fields, "__proto__"));
  assertEquals(Object.getPrototypeOf(res.fields), Object.prototype);
  assertEquals(Object.keys(res.fields), ["__proto__"]);
  assertEquals(({} as Record<string, unknown>).options, undefined);
});

Deno.test("sanitizeResolveFieldsOutput (c): bad entry or options -> error", () => {
  const msg = "invalid options returned by the app";
  const out = sanitizeResolveFieldsOutput(
    { fields: { a: "str", b: { options: "nope" }, c: null, d: [], e: { options: { 0: 1 } } } },
    ["a", "b", "c", "d", "e"],
  );
  for (const k of ["a", "b", "c", "d", "e"]) assertEquals(out.fields[k], { error: msg }, k);
});

Deno.test("sanitizeResolveFieldsOutput (d): option filtering, field whitelist, clipping", () => {
  const long = "x".repeat(300);
  const out = sanitizeResolveFieldsOutput({
    fields: {
      a: {
        options: [
          { value: "s", label: "str" },
          { value: 7, label: "num", description: "d", disabled: true },
          { value: NaN, label: "nan" },
          { value: Infinity, label: "inf" },
          { value: true, label: "bool" },
          { value: "nolabel" },
          { value: "badlabel", label: 5 },
          "scalar",
          null,
          { value: "L", label: long, description: "y".repeat(600), extra: "no", disabled: "yes" },
        ],
      },
    },
  }, ["a"]);
  const opts = out.fields.a.options!;
  assertEquals(opts.length, 3);
  assertEquals(opts[0], { value: "s", label: "str" });
  assertEquals(opts[1], { value: 7, label: "num", description: "d", disabled: true });
  assertEquals(opts[2].label.length, 200);
  assertEquals(opts[2].description!.length, 500);
  assertEquals(Object.keys(opts[2]).sort(), ["description", "label", "value"]);
});

Deno.test("sanitizeResolveFieldsOutput (e): at most 1000 options, the first 1000", () => {
  assertEquals(RESOLVE_FIELDS_MAX_OPTIONS, 1000);
  const options = Array.from({ length: 1001 }, (_, i) => ({ value: i, label: `o${i}` }));
  const got = sanitizeResolveFieldsOutput({ fields: { a: { options } } }, ["a"]).fields.a.options!;
  assertEquals(got.length, 1000);
  assertEquals(got[0].value, 0);
  assertEquals(got[999].value, 999);
});

Deno.test("sanitizeResolveFieldsOutput (f): error clipped to 500; non-string error dropped", () => {
  const out = sanitizeResolveFieldsOutput({
    fields: {
      a: { error: "e".repeat(900) },
      b: { options: [], error: 42 },
      c: { error: "short", options: [{ value: "v", label: "V" }] },
    },
  }, ["a", "b", "c"]);
  assertEquals(out.fields.a.error!.length, 500);
  assertEquals(out.fields.b, { options: [] });
  assertEquals(out.fields.c, { options: [{ value: "v", label: "V" }], error: "short" });
});
