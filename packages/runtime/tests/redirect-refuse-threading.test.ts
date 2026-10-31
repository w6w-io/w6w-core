// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  authFor,
  invoke,
  invokeResolveFields,
  invokeTriggerHook,
  loadApp,
  prepareAuthorization,
  runAuthHook,
  signingFetch,
} from "../mod.ts";
import type { Connection } from "@w6w/types";

// `InvokeOptions.redirects` is threaded to every host egress an invocation can
// make. redirect-refuse.test.ts pins the hostFetch behaviour through
// signingFetch and invoke; this file pins the REST of the threading (the
// in-core refresh arm behind each prepareAuthorization call site, runAuthHook
// signed + unsigned, the trigger hook, resolveFields) and the fail-closed rule.
// Each case has a control arm (option unset) that DOES follow, so a green
// "target got zero requests" cannot come from a hop that never happens.

const INDEX = `export default {
  actions: [{
    key: "call", type: "perform", title: "Call",
    params: [{ key: "url", label: "URL", type: "string", required: true }],
    async execute(input, ctx) {
      const r = await ctx.fetch(input.url, { method: "POST", body: "payload" });
      return { status: r.status };
    },
  }, {
    key: "form", type: "perform", title: "Form",
    params: [{ key: "channel", label: "Channel", type: "string", options: { source: "resolveFields" } }],
    execute() { return {}; },
    async resolveFields(input, ctx) {
      const r = await ctx.fetch(input.form.url, { method: "POST", body: "payload" });
      return { fields: { channel: { options: [{ value: "c1", label: "status:" + r.status }] } } };
    },
  }],
  auth: [{
    key: "k", type: "apiKey", displayName: "K", apiKey: { in: "header", name: "x-api-key" },
    fields: [{ key: "apiKey", label: "Key", type: "secret", required: true }],
    sign({ request, credential }) {
      request.headers["x-api-key"] = credential.apiKey ?? credential.accessToken;
      return request;
    },
    test() { return { ok: true }; },
    async afterConnect({ credential, credentialDisplay }, ctx) {
      const url = (credential && credential.probeUrl) || credentialDisplay.probeUrl;
      const r = await ctx.fetch(url, { method: "POST", body: "payload" });
      return { label: "x", probeStatus: r.status };
    },
    async refresh({ credential }, ctx) {
      const r = await ctx.fetch(credential.probeUrl, { method: "POST", body: "payload" });
      return { ...credential, refreshedStatus: r.status };
    },
    async revoke({ credential }, ctx) {
      const r = await ctx.fetch(credential.probeUrl, { method: "POST", body: "payload" });
      return { revokeStatus: r.status };
    },
  }],
  triggers: [{
    key: "t", title: "T",
    params: [{ key: "url", label: "URL", type: "string" }],
    async onSubscribe({ params }, ctx) {
      const r = await ctx.fetch(params.url, { method: "POST", body: "payload" });
      return { status: r.status };
    },
    onUnsubscribe() {},
  }],
};
`;

async function makeApp() {
  const dir = await Deno.makeTempDir({ prefix: "redirect-threading-" });
  await Deno.writeTextFile(
    `${dir}/package.json`,
    JSON.stringify({
      name: "@w6w-fixtures/redirect-threading",
      version: "1.0.0",
      license: "MIT",
      private: true,
      description: "redirects threading fixture",
      author: { name: "w6w" },
      w6w: {
        id: "io.test.redirect-threading",
        displayName: "Redirect threading",
        categories: ["other"],
        appearance: {
          icon: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>' },
        },
        network: { allow: ["127.0.0.1"] },
        entry: "./index.ts",
      },
    }),
  );
  await Deno.writeTextFile(`${dir}/index.ts`, INDEX);
  return await loadApp(dir);
}

const APP_ID = "io.test.redirect-threading";
const CONN: Connection = {
  manifestVersion: "1",
  id: "conn_p",
  app: APP_ID,
  owner: "user_1",
  state: "connected",
  createdAt: "2026-05-24T00:00:00Z",
  auth: "k",
  credential: { apiKey: "live-secret-abc123" },
};

interface Captured {
  path: string;
  apikey: string | null;
  auth: string | null;
}
function recorder(respond: (path: string) => Response) {
  const requests: Captured[] = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    requests.push({
      path: url.pathname,
      apikey: req.headers.get("x-api-key"),
      auth: req.headers.get("authorization"),
    });
    return respond(url.pathname);
  });
  return { server, port: (server.addr as Deno.NetAddr).port, requests };
}

/** A 307 origin pointing at a target on ANOTHER port of the same hostname. */
function pair() {
  const target = recorder(() => new Response("landed", { status: 200 }));
  const origin = recorder((path) =>
    path === "/start"
      ? new Response("redirect-body", {
        status: 307,
        headers: { location: `http://127.0.0.1:${target.port}/landed` },
      })
      : new Response("unexpected", { status: 404 })
  );
  return {
    origin,
    target,
    url: `http://127.0.0.1:${origin.port}/start`,
    async close() {
      await origin.server.shutdown();
      await target.server.shutdown();
    },
  };
}

type Opt = Record<string, unknown>;
const OPTS: { name: string; opts: Opt; follows: boolean }[] = [
  { name: "unset", opts: {}, follows: true },
  { name: "same-host", opts: { redirects: "same-host" }, follows: true },
  { name: "refuse", opts: { redirects: "refuse" }, follows: false },
];

/** Run `fn` against a fresh pair per option; origin is hit once, the target only when following. */
async function eachOption(
  fn: (p: ReturnType<typeof pair>, opts: Opt) => Promise<void>,
  label: string,
) {
  for (const o of OPTS) {
    const p = pair();
    try {
      await fn(p, o.opts);
      assertEquals(p.origin.requests.length, 1, `${label} [${o.name}]: origin hit once`);
      assertEquals(
        p.target.requests.length,
        o.follows ? 1 : 0,
        `${label} [${o.name}]: the Location target's hit count`,
      );
    } finally {
      await p.close();
    }
  }
}

Deno.test("threading: runAuthHook unsigned (afterConnect, revoke) reaches hostFetch", async () => {
  const app = await makeApp();
  for (const hook of ["afterConnect", "revoke"]) {
    await eachOption(async (p, opts) => {
      await runAuthHook(
        app,
        authFor(app, CONN),
        hook as "afterConnect",
        { apiKey: "live-secret-abc123", probeUrl: p.url },
        opts,
      );
    }, `runAuthHook unsigned ${hook}`);
  }
});

Deno.test("threading: runAuthHook SIGNED (derived authorization) reaches signingFetch", async () => {
  const app = await makeApp();
  await eachOption(async (p, opts) => {
    await runAuthHook(
      app,
      authFor(app, CONN),
      "afterConnect",
      { apiKey: "unused", probeUrl: p.url },
      {
        ...opts,
        signing: {
          credentialDisplay: { probeUrl: p.url },
          authorization: {
            kind: "derived",
            token: {
              accessToken: "derived-tok-xyz",
              tokenType: "Bearer",
              expiresAt: Date.now() + 3600_000,
            },
            expiresAt: Date.now() + 3600_000,
            sourceRevision: 1,
          },
        },
      } as any,
    );
    // The signed request is the one that carries the derived token.
    assertEquals(p.origin.requests[0]?.apikey, "derived-tok-xyz");
  }, "runAuthHook signed");
});

Deno.test("threading: prepareAuthorization in-core refresh arm", async () => {
  const app = await makeApp();
  await eachOption(async (p, opts) => {
    const conn = {
      ...CONN,
      state: "needs_refresh",
      credential: { apiKey: "live-secret-abc123", probeUrl: p.url },
    } as Connection;
    await prepareAuthorization(app, authFor(app, conn), conn, { purpose: "invoke", ...opts });
  }, "prepareAuthorization refresh");
});

// The refresh arm reached THROUGH each entry point: each passes `redirects` to
// its own prepareAuthorization call, so each needs its own pin.
for (const entry of ["invoke", "invokeTriggerHook", "invokeResolveFields"] as const) {
  Deno.test(`threading: refresh arm via ${entry}`, async () => {
    const app = await makeApp();
    await eachOption(async (p, opts) => {
      const live = recorder(() => new Response("ok", { status: 200 }));
      try {
        const conn = {
          ...CONN,
          state: "needs_refresh",
          credential: { apiKey: "live-secret-abc123", probeUrl: p.url },
        } as Connection;
        const liveUrl = `http://127.0.0.1:${live.port}/live`;
        if (entry === "invoke") {
          await invoke(
            app,
            {
              manifestVersion: "1",
              app: APP_ID,
              action: "call",
              connection: CONN.id,
              params: { url: liveUrl },
            },
            { connection: conn, ...opts },
          );
        } else if (entry === "invokeTriggerHook") {
          await invokeTriggerHook(app, {
            triggerKey: "t",
            hook: "onSubscribe",
            input: { params: { url: liveUrl } },
            connection: conn,
            ...opts,
          } as any);
        } else {
          await invokeResolveFields(
            app,
            "form",
            { form: { url: liveUrl }, fields: ["channel"] } as any,
            { connection: conn, ...opts },
          );
        }
        assertEquals(live.requests.length, 1, "the live call itself still happens");
      } finally {
        await live.server.shutdown();
      }
    }, `refresh arm via ${entry}`);
  });
}

Deno.test("threading: invokeTriggerHook ctx.fetch (signed)", async () => {
  const app = await makeApp();
  await eachOption(async (p, opts) => {
    await invokeTriggerHook(app, {
      triggerKey: "t",
      hook: "onSubscribe",
      input: { params: { url: p.url } },
      connection: CONN,
      ...opts,
    } as any);
    assertEquals(p.origin.requests[0]?.apikey, "live-secret-abc123");
  }, "invokeTriggerHook");
});

Deno.test("threading: invokeResolveFields ctx.fetch (signed)", async () => {
  const app = await makeApp();
  await eachOption(async (p, opts) => {
    await invokeResolveFields(
      app,
      "form",
      { form: { url: p.url }, fields: ["channel"] } as any,
      { connection: CONN, ...opts },
    );
    assertEquals(p.origin.requests[0]?.apikey, "live-secret-abc123");
  }, "invokeResolveFields");
});

// Fail closed: the type allows only "same-host" | "refuse", but a caller that
// slips past it (JS, a cast, a typo) must not get same-host following back.
for (const bad of ["Refuse", "REFUSE", "deny", " refuse", "", true, 1, null]) {
  Deno.test(`redirects fails CLOSED on ${JSON.stringify(bad)}: 307 returned, target untouched`, async () => {
    const app = await makeApp();
    const p = pair();
    try {
      const res = await signingFetch(app, undefined, undefined, { redirects: bad } as any)({
        url: p.url,
        method: "POST",
        headers: { authorization: "Bearer live-secret" },
        body: "payload",
      });
      assertEquals(res.status, 307);
      assertEquals(p.origin.requests.length, 1);
      assertEquals(p.target.requests.length, 0);
    } finally {
      await p.close();
    }
  });
}

Deno.test("redirects: undefined (explicit) still follows same-host", async () => {
  const app = await makeApp();
  const p = pair();
  try {
    const res = await signingFetch(app, undefined, undefined, { redirects: undefined })({
      url: p.url,
      method: "POST",
      headers: {},
      body: "payload",
    });
    assertEquals(res.status, 200);
    assert(p.target.requests.length === 1);
  } finally {
    await p.close();
  }
});
