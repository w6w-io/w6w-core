import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { invoke, loadApp, signingFetch } from "../mod.ts";
import type { Connection, Invocation } from "@w6w/types";

// `InvokeOptions.redirects`: "refuse" returns the first 3xx as-is and never
// contacts its Location; unset / "same-host" is today's follow behaviour
// (covered further in redirect.test.ts, whose R2 is the unchanged reference).

const EGRESS_DIR = fromFileUrl(new URL("../../../fixtures/apps/egress", import.meta.url));

const CONNECTION: Connection = {
  manifestVersion: "1",
  id: "conn_test",
  app: "io.w6w.egress",
  owner: "user_1",
  state: "connected",
  createdAt: "2026-05-24T00:00:00Z",
  auth: "api-key-header",
  credential: { apiKey: "live-secret-abc123" },
};

interface Captured {
  path: string;
  method: string;
  body: string;
  headers: Headers;
}

function recorder(respond: (path: string) => Response) {
  const requests: Captured[] = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    requests.push({
      path: url.pathname,
      method: req.method,
      body: await req.text(),
      headers: req.headers,
    });
    return respond(url.pathname);
  });
  return { server, port: (server.addr as Deno.NetAddr).port, requests };
}

/** A target server (answers 200) and a redirecting server pointing at it on ANOTHER port. */
function pair(status: number) {
  const target = recorder(() => new Response("landed", { status: 200 }));
  const origin = recorder((path) =>
    path === "/start"
      ? new Response("redirect-body", {
        status,
        headers: { location: `http://127.0.0.1:${target.port}/landed` },
      })
      : new Response("unexpected", { status: 404 })
  );
  return {
    origin,
    target,
    async close() {
      await origin.server.shutdown();
      await target.server.shutdown();
    },
  };
}

const text = (b: Uint8Array | string | null | undefined) =>
  typeof b === "string" ? b : new TextDecoder().decode(b ?? new Uint8Array());

for (const status of [301, 302, 303, 307, 308]) {
  Deno.test(`redirects:"refuse" - ${status} is returned as-is, the Location gets ZERO requests`, async () => {
    const app = await loadApp(EGRESS_DIR);
    const p = pair(status);
    try {
      const fetchRefuse = signingFetch(app, undefined, undefined, { redirects: "refuse" });
      const res = await fetchRefuse({
        url: `http://127.0.0.1:${p.origin.port}/start`,
        method: "POST",
        headers: { authorization: "Bearer live-secret" },
        body: "payload",
      });
      assertEquals(res.status, status);
      assertEquals(res.headers["location"], `http://127.0.0.1:${p.target.port}/landed`);
      assertEquals(text(res.body), "redirect-body");
      // Positive half: the first hop DID carry the credential and body.
      assertEquals(p.origin.requests.length, 1);
      assertEquals(p.origin.requests[0].headers.get("authorization"), "Bearer live-secret");
      assertEquals(p.origin.requests[0].body, "payload");
      // The point: the redirect target is never contacted.
      assertEquals(p.target.requests.length, 0);
    } finally {
      await p.close();
    }
  });
}

Deno.test("redirects unset and 'same-host' follow a same-hostname other-port 307: one request lands", async () => {
  const app = await loadApp(EGRESS_DIR);
  for (const opts of [{}, { redirects: "same-host" as const }]) {
    const p = pair(307);
    try {
      const res = await signingFetch(app, undefined, undefined, opts)({
        url: `http://127.0.0.1:${p.origin.port}/start`,
        method: "POST",
        headers: { authorization: "Bearer live-secret" },
        body: "payload",
      });
      assertEquals(res.status, 200);
      assertEquals(text(res.body), "landed");
      assertEquals(p.origin.requests.length, 1);
      assertEquals(p.target.requests.length, 1);
      // 307 preserves headers and body: this is the leak "refuse" closes.
      assertEquals(p.target.requests[0].headers.get("authorization"), "Bearer live-secret");
      assertEquals(p.target.requests[0].body, "payload");
    } finally {
      await p.close();
    }
  }
});

Deno.test("redirects:'refuse' returns a CROSS-host 3xx too (no egress_denied throw), still ZERO requests", async () => {
  const app = await loadApp(EGRESS_DIR);
  const target = recorder(() => new Response("landed"));
  const origin = recorder(() =>
    new Response(null, {
      status: 302,
      headers: { location: `http://localhost:${target.port}/landed` },
    })
  );
  try {
    const res = await signingFetch(app, undefined, undefined, { redirects: "refuse" })({
      url: `http://127.0.0.1:${origin.port}/start`,
      method: "GET",
      headers: {},
    });
    assertEquals(res.status, 302);
    assertEquals(target.requests.length, 0);
  } finally {
    await origin.server.shutdown();
    await target.server.shutdown();
  }
});

Deno.test("redirects:'refuse' through invoke: signed 307 comes back as the action's value, target untouched", async () => {
  const app = await loadApp(EGRESS_DIR);
  const p = pair(307);
  try {
    const invocation: Invocation = {
      manifestVersion: "1",
      app: "io.w6w.egress",
      action: "call",
      connection: CONNECTION.id,
      params: { url: `http://127.0.0.1:${p.origin.port}/start` },
    };
    const result = await invoke(app, invocation, { connection: CONNECTION, redirects: "refuse" });
    assertEquals((result.value as { status: number }).status, 307);
    assertEquals(p.origin.requests[0]?.headers.get("x-api-key"), "live-secret-abc123");
    assertEquals(p.target.requests.length, 0);

    // Same invocation, option unset: the hop is followed and the key travels.
    const followed = await invoke(app, invocation, { connection: CONNECTION });
    assertEquals((followed.value as { status: number }).status, 200);
    assertEquals(p.target.requests.length, 1);
    assert(p.target.requests[0].headers.get("x-api-key") === "live-secret-abc123");
  } finally {
    await p.close();
  }
});

Deno.test("redirects:'refuse' leaves a non-redirect response untouched", async () => {
  const app = await loadApp(EGRESS_DIR);
  const s = recorder(() => new Response("plain", { status: 200 }));
  try {
    const res = await signingFetch(app, undefined, undefined, { redirects: "refuse" })({
      url: `http://127.0.0.1:${s.port}/x`,
      method: "GET",
      headers: {},
    });
    assertEquals(res.status, 200);
    assertEquals(text(res.body), "plain");
  } finally {
    await s.server.shutdown();
  }
});
