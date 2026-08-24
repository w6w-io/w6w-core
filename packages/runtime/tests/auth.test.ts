import { assert, assertEquals, assertFalse, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { describe, invoke, loadApp, W6WError } from "../mod.ts";
import type { Connection, Invocation } from "@w6w/types";

const SENDGRID_DIR = fromFileUrl(new URL("../../../fixtures/apps/sendgrid", import.meta.url));

const CONNECTION: Connection = {
  manifestVersion: "1",
  id: "conn_test",
  app: "io.w6w.sendgrid",
  auth: "api-key",
  owner: "user_1",
  state: "connected",
  credential: { apiKey: "test-key-123" },
  createdAt: "2026-05-24T00:00:00Z",
};

/** Spins up a one-shot local endpoint that records the request it receives. */
function captureServer() {
  let captured: { authorization: string | null; body: string } | undefined;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      captured = { authorization: req.headers.get("authorization"), body: await req.text() };
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return { server, port, get: () => captured };
}

function withState(state: Connection["state"]): Connection {
  return { ...CONNECTION, state };
}

function sendInvocation(
  apiBase: string,
  connection: string | undefined = CONNECTION.id,
): Invocation {
  return {
    manifestVersion: "1",
    app: "io.w6w.sendgrid",
    action: "send-email",
    connection,
    params: { to: "a@b.c", from: "x@y.z", subject: "s", body: "b", apiBase },
  };
}

Deno.test("describe extracts auth config from the code module", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { auth } = describe(app);
  assertEquals(auth.length, 1);
  assertEquals(auth[0].key, "api-key");
  assertEquals(auth[0].type, "apiKey");
  // hook functions must not leak into the serializable config:
  assertFalse("sign" in auth[0]);
  assertFalse("test" in auth[0]);
});

Deno.test("sign injects the credential at the wire; the action never sees it", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { server, port, get } = captureServer();

  try {
    const invocation: Invocation = {
      manifestVersion: "1",
      app: "io.w6w.sendgrid",
      action: "send-email",
      connection: CONNECTION.id,
      params: {
        to: "alice@example.com",
        from: "noreply@acme.example",
        subject: "Hi",
        body: "Hello!",
        apiBase: `http://127.0.0.1:${port}`,
      },
    };

    const result = await invoke(app, invocation, { connection: CONNECTION });
    const value = result.value as { status: number; connectionKeys: string[] };

    // The host performed the call and got the echo server's 202.
    assertEquals(value.status, 202);

    // sign() injected the credential — the server saw the Bearer token.
    assertEquals(get()?.authorization, "Bearer test-key-123");

    // The action's view of the connection is redacted: no credential.
    assertFalse(value.connectionKeys.includes("credential"));
    assert(value.connectionKeys.includes("id"));
  } finally {
    await server.shutdown();
  }
});

Deno.test("requests to hosts off the allowlist are denied by the host", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const invocation: Invocation = {
    manifestVersion: "1",
    app: "io.w6w.sendgrid",
    action: "send-email",
    connection: CONNECTION.id,
    params: {
      to: "a@b.c",
      from: "x@y.z",
      subject: "s",
      body: "b",
      apiBase: "https://evil.example",
    },
  };

  let threw = false;
  try {
    await invoke(app, invocation, { connection: CONNECTION });
  } catch {
    threw = true;
  }
  assert(threw, "expected the off-allowlist request to fail the invocation");
});

// --- Connection lifecycle gates (Invocation RFC resolution sequence step 2) ---

for (
  const [state, code] of [
    ["pending", "connection_pending"],
    ["revoked", "connection_revoked"],
    ["broken", "connection_broken"],
  ] as const
) {
  Deno.test(`gate: "${state}" connection is rejected before execute`, async () => {
    const app = await loadApp(SENDGRID_DIR);
    const err = await assertRejects(
      () =>
        invoke(app, sendInvocation("https://api.sendgrid.com"), { connection: withState(state) }),
      W6WError,
    );
    assertEquals(err.code, code);
    assertEquals(err.phase, "auth");
  });
}

Deno.test("gate: needs_refresh runs the refresh hook, then signs with the new credential", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { server, port, get } = captureServer();
  try {
    const result = await invoke(app, sendInvocation(`http://127.0.0.1:${port}`), {
      connection: withState("needs_refresh"),
    });
    assertEquals((result.value as { status: number }).status, 202);
    // refresh derived "<key>-refreshed"; sign used the refreshed credential.
    assertEquals(get()?.authorization, "Bearer test-key-123-refreshed");
  } finally {
    await server.shutdown();
  }
});

Deno.test("gate: an auth app requires a connection", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const invocation: Invocation = {
    manifestVersion: "1",
    app: "io.w6w.sendgrid",
    action: "send-email",
    // no `connection` at all
    params: {
      to: "a@b.c",
      from: "x@y.z",
      subject: "s",
      body: "b",
      apiBase: "https://api.sendgrid.com",
    },
  };
  const err = await assertRejects(() => invoke(app, invocation), W6WError);
  assertEquals(err.code, "connection_required");
  assertEquals(err.phase, "auth");
});

Deno.test("gate: a referenced connection not provided to the runtime is unknown_connection", async () => {
  const app = await loadApp(SENDGRID_DIR);
  // invocation references a connection id, but no Connection object is passed.
  const err = await assertRejects(
    () => invoke(app, sendInvocation("https://api.sendgrid.com")),
    W6WError,
  );
  assertEquals(err.code, "unknown_connection");
  assertEquals(err.phase, "auth");
});

// ── Request overrides ──────────────────────────────────────────────────────
// The caller's escape hatch for a vendor field the Action does not declare.
// These are the end-to-end assertions: that it reaches the wire at all, and
// that it cannot reach past the two boundaries it must not cross.

/** As `captureServer`, but recording the whole request. */
function fullCaptureServer() {
  let captured: { url: string; headers: Headers; body: string } | undefined;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    async (req) => {
      captured = { url: req.url, headers: req.headers, body: await req.text() };
      return new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return { server, port, get: () => captured };
}

Deno.test("overrides reach the wire without the action declaring them", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { server, port, get } = fullCaptureServer();
  try {
    await invoke(
      app,
      {
        ...sendInvocation(`http://127.0.0.1:${port}`),
        // Nothing in the fixture's params declares any of these — that is the
        // point. `resolveParams` would have dropped them; the wire merge does not.
        overrides: {
          body: { send_at: 1700000000, categories: ["ops"] },
          query: { verbose: "1" },
          headers: { "x-trace": "abc" },
        },
      },
      { connection: CONNECTION },
    );
  } finally {
    await server.shutdown();
  }
  const captured = get()!;
  const body = JSON.parse(captured.body);
  assertEquals(body.send_at, 1700000000);
  assertEquals(body.categories, ["ops"]);
  // ...and what the action itself built is still there.
  assertEquals(body.subject, "s");
  assertEquals(new URL(captured.url).searchParams.get("verbose"), "1");
  assertEquals(captured.headers.get("x-trace"), "abc");
});

Deno.test("a path override sets one leaf of the built body end to end", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { server, port, get } = fullCaptureServer();
  try {
    await invoke(
      app,
      {
        ...sendInvocation(`http://127.0.0.1:${port}`),
        overrides: { body: { "tracking_settings.open_tracking.enable": false } },
      },
      { connection: CONNECTION },
    );
  } finally {
    await server.shutdown();
  }
  const body = JSON.parse(get()!.body);
  assertEquals(body.tracking_settings, { open_tracking: { enable: false } });
  assertEquals(body.subject, "s", "the action's own fields survive");
});

Deno.test("overrides cannot hijack the auth header the sign hook owns", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { server, port, get } = fullCaptureServer();
  try {
    await invoke(
      app,
      {
        ...sendInvocation(`http://127.0.0.1:${port}`),
        overrides: { headers: { authorization: "Bearer attacker-supplied" } },
      },
      { connection: CONNECTION },
    );
  } finally {
    await server.shutdown();
  }
  // The merge runs BEFORE `sign`, so the app's auth overwrites it. An override
  // can add a header; it can never replace authentication.
  assertEquals(get()!.headers.get("authorization"), "Bearer test-key-123");
});

Deno.test("overrides cannot redirect the request off the allowlisted host", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { server, port, get } = fullCaptureServer();
  try {
    await invoke(
      app,
      {
        ...sendInvocation(`http://127.0.0.1:${port}`),
        // A `host` header does not move a fetch, and only the query string is
        // rewritten — host and path stay exactly as the action wrote them.
        overrides: { headers: { host: "evil.example.com" }, query: { a: "1" } },
      },
      { connection: CONNECTION },
    );
  } finally {
    await server.shutdown();
  }
  assertEquals(new URL(get()!.url).hostname, "127.0.0.1");
});

Deno.test("an invocation with no overrides is byte-identical to before", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const runOnce = async (overrides?: Record<string, never>) => {
    const { server, port, get } = fullCaptureServer();
    try {
      await invoke(
        app,
        {
          ...sendInvocation(`http://127.0.0.1:${port}`),
          ...(overrides ? { overrides } : {}),
        },
        { connection: CONNECTION },
      );
    } finally {
      await server.shutdown();
    }
    const c = get()!;
    return { body: c.body, path: new URL(c.url).pathname + new URL(c.url).search };
  };
  const plain = await runOnce();
  // An empty envelope must be a no-op, not "merge nothing but re-serialize".
  const empty = await runOnce({});
  assertEquals(empty.body, plain.body);
  assertEquals(empty.path, plain.path);
});
