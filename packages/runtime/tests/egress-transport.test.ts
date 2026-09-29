/**
 * `InvokeOptions.egressTransport` (R-14/R-19): when set, it replaces the
 * `sign` hook AND host egress as ONE unit, and every other credential-bearing
 * path (`refresh`, a socket `handshake`) is refused under it. Unset behaviour
 * is covered by the rest of this package's suite (auth.test.ts,
 * socket-connect.test.ts) — this file only exercises the new option, plus the
 * hub-style direct call to the exported `signingFetch` (Acceptance 5).
 */
import { assert, assertEquals, assertFalse, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import {
  authFor,
  invoke,
  loadApp,
  type SignableRequest,
  signingFetch,
  W6WError,
  type WireResponse,
} from "../mod.ts";
import type { Connection, Invocation } from "@w6w/types";

const SENDGRID_DIR = fromFileUrl(new URL("../../../fixtures/apps/sendgrid", import.meta.url));

/** A proxy-mode Connection: OMITS `credential` entirely (strict `!== undefined` guard). */
const PROXY_CONNECTION: Connection = {
  manifestVersion: "1",
  id: "conn_proxy",
  app: "io.w6w.sendgrid",
  auth: "api-key",
  owner: "user_1",
  state: "connected",
  createdAt: "2026-09-28T00:00:00Z",
};

/** A handoff-mode Connection carrying a real credential — used to prove the guard. */
const CREDENTIAL_CONNECTION: Connection = {
  ...PROXY_CONNECTION,
  id: "conn_credential",
  credential: { apiKey: "test-key-123" },
};

function sendInvocation(apiBase: string, overrides?: Invocation["overrides"]): Invocation {
  return {
    manifestVersion: "1",
    app: "io.w6w.sendgrid",
    action: "send-email",
    connection: PROXY_CONNECTION.id,
    params: { to: "a@b.c", from: "x@y.z", subject: "s", body: "b", apiBase },
    ...(overrides ? { overrides } : {}),
  };
}

/** Records every request the transport sees; returns a canned response. */
function transportSpy(status = 202) {
  const seen: SignableRequest[] = [];
  const transport = (request: SignableRequest): Promise<WireResponse> => {
    seen.push(request);
    return Promise.resolve({
      status,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ ok: true })),
    });
  };
  return { transport, seen };
}

/** As auth.test.ts's captureServer — proves whether the HOST ever fetched anything. */
function captureServer() {
  let hits = 0;
  let captured: { authorization: string | null; body: string } | undefined;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      hits++;
      captured = { authorization: req.headers.get("authorization"), body: await req.text() };
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return { server, port, hits: () => hits, get: () => captured };
}

Deno.test(
  "request reaches the transport unsigned and post-override, and no host egress occurs",
  async () => {
    const app = await loadApp(SENDGRID_DIR);
    const { server, hits } = captureServer();
    const { transport, seen } = transportSpy();
    try {
      const result = await invoke(
        app,
        sendInvocation("https://api.sendgrid.com", { headers: { "x-trace": "abc" } }),
        { connection: PROXY_CONNECTION, egressTransport: transport },
      );
      assertEquals((result.value as { status: number }).status, 202);
    } finally {
      await server.shutdown();
    }

    // Never touched the real host — the transport replaced it entirely.
    assertEquals(hits(), 0);

    assertEquals(seen.length, 1);
    const req = seen[0];
    // Post-override: the caller's override header reached the transport...
    assertEquals(req.headers["x-trace"], "abc");
    // ...but no `sign` hook ran: no Authorization header was injected.
    assertFalse(
      Object.keys(req.headers).some((k) => /authorization/i.test(k)),
      "the transport must see the request UNSIGNED",
    );
    // Pinned to `https://api.sendgrid.com`, not the capture server: proves the
    // transport received the real, post-param request, not a stand-in.
    assertEquals(new URL(req.url).hostname, "api.sendgrid.com");
  },
);

Deno.test("onEgress observes the transport's response", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { transport } = transportSpy(201);
  const events: { status: number }[] = [];
  const result = await invoke(app, sendInvocation("https://api.sendgrid.com"), {
    connection: PROXY_CONNECTION,
    egressTransport: transport,
    onEgress: (info) => events.push({ status: info.status }),
  });
  assertEquals((result.value as { status: number }).status, 201);
  assertEquals(events.length, 1);
  assertEquals(events[0].status, 201);
});

Deno.test(
  "pre-sign allowlist check still refuses an off-allowlist URL; transport never called",
  async () => {
    const app = await loadApp(SENDGRID_DIR);
    const { transport, seen } = transportSpy();
    const err = await assertRejects(
      () =>
        invoke(app, sendInvocation("https://evil.example"), {
          connection: PROXY_CONNECTION,
          egressTransport: transport,
        }),
      W6WError,
    );
    assertEquals(err.code, "egress_denied");
    assertEquals(seen.length, 0, "the transport must never be called for a refused destination");
  },
);

Deno.test("a Connection carrying a credential is refused", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { transport, seen } = transportSpy();
  const err = await assertRejects(
    () =>
      invoke(app, sendInvocation("https://api.sendgrid.com"), {
        connection: CREDENTIAL_CONNECTION,
        egressTransport: transport,
      }),
    W6WError,
  );
  assertEquals(err.code, "egress_transport_conflict");
  assertEquals(err.phase, "auth");
  assertEquals(seen.length, 0);
});

Deno.test("a needs_refresh Connection is refused; the refresh hook never runs", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { transport, seen } = transportSpy();
  const err = await assertRejects(
    () =>
      invoke(app, sendInvocation("https://api.sendgrid.com"), {
        connection: { ...PROXY_CONNECTION, state: "needs_refresh" },
        egressTransport: transport,
      }),
    W6WError,
  );
  assertEquals(err.code, "egress_transport_conflict");
  assertEquals(err.phase, "auth");
  assertEquals(seen.length, 0, "refused before the refresh hook could hand off to the transport");
});

Deno.test("a socket-target Connection is refused; no connect attempted", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { transport, seen } = transportSpy();
  const err = await assertRejects(
    () =>
      invoke(app, sendInvocation("https://api.sendgrid.com"), {
        connection: {
          ...PROXY_CONNECTION,
          target: { host: "127.0.0.1", port: 9, tlsMode: "disable" },
        },
        egressTransport: transport,
      }),
    W6WError,
  );
  assertEquals(err.code, "egress_transport_conflict");
  assertEquals(err.phase, "execute");
  assertEquals(seen.length, 0);
});

Deno.test(
  "exported signingFetch called hub-style (sendgrid auth, credential, no transport) signs and performs host egress",
  async () => {
    const app = await loadApp(SENDGRID_DIR);
    const auth = authFor(app, CREDENTIAL_CONNECTION);
    const { server, port, hits, get } = captureServer();
    try {
      const handler = signingFetch(app, auth, CREDENTIAL_CONNECTION.credential, {});
      const res = await handler({
        url: `http://127.0.0.1:${port}/v3/mail/send`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "a@b.c" }),
      });
      assertEquals(res.status, 202);
    } finally {
      await server.shutdown();
    }
    assertEquals(hits(), 1);
    assertEquals(get()?.authorization, "Bearer test-key-123");
  },
);

Deno.test("unset egressTransport keeps signing and host egress exactly as before", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { server, port, get } = captureServer();
  try {
    const result = await invoke(app, sendInvocation(`http://127.0.0.1:${port}`), {
      connection: CREDENTIAL_CONNECTION,
    });
    assert((result.value as { status: number }).status === 202);
  } finally {
    await server.shutdown();
  }
  assertEquals(get()?.authorization, "Bearer test-key-123");
});
