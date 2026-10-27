/**
 * The runtime's credential seam: `prepareAuthorization`, the strict `authFor`
 * it sits behind, and the isolation guarantees its output carries to the
 * `sign` hook and the signed `test`/`afterConnect` path. Asserted at the sink:
 * the bytes the sign hook emitted, captured at a stub host.
 */
import { assert, assertEquals, assertFalse, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import {
  authFor,
  checkHealth,
  type CredentialPurpose,
  type CredentialResolver,
  invoke,
  invokeResolveFields,
  invokeTriggerHook,
  loadApp,
  prepareAuthorization,
  runAuthHook,
  W6WError,
} from "../mod.ts";
import type { Connection, DerivedToken, Invocation, ResolvedAuthorization } from "@w6w/types";

const fx = (name: string) =>
  fromFileUrl(new URL(`../../../fixtures/apps/${name}`, import.meta.url));
const SENDGRID = fx("sendgrid");
const SERVICE_ACCOUNT = fx("service-account");

const CONNECTION: Connection = {
  manifestVersion: "1",
  id: "conn_prep",
  app: "io.w6w.sendgrid",
  auth: "api-key",
  owner: "user_1",
  state: "connected",
  credential: { apiKey: "stored-key" },
  display: { apiBase: "http://127.0.0.1:1" },
  createdAt: "2026-10-27T00:00:00Z",
};

function spyResolver(
  answer: ResolvedAuthorization | (() => Promise<ResolvedAuthorization>),
) {
  const calls: Array<{ connection: Connection; authKey: string; purpose: CredentialPurpose }> = [];
  const resolver: CredentialResolver = {
    prepare(i) {
      calls.push(i);
      return typeof answer === "function" ? answer() : Promise.resolve(answer);
    },
  };
  return { resolver, calls };
}

const FROM_RESOLVER: ResolvedAuthorization = {
  kind: "legacyOpaque",
  source: "stored",
  credential: { apiKey: "from-resolver" },
  sourceRevision: 1,
};

/** A one-shot stub host that records every request's headers (lower-cased) and body. */
function stubHost() {
  const seen: Array<{ headers: Record<string, string>; url: string }> = [];
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      seen.push({ headers, url: req.url });
      return new Response(JSON.stringify({ remain: 5, total: 10, channels: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return { server, port, base: `http://127.0.0.1:${port}`, seen };
}

const sendInvocation = (apiBase: string): Invocation => ({
  manifestVersion: "1",
  app: "io.w6w.sendgrid",
  action: "send-email",
  connection: CONNECTION.id,
  params: { to: "a@b.c", from: "x@y.z", subject: "s", body: "b", apiBase },
});

// ── AC1: one seam, gates before the resolver ────────────────────────────────

for (
  const [state, code] of [
    ["pending", "connection_pending"],
    ["revoked", "connection_revoked"],
    ["broken", "connection_broken"],
  ] as const
) {
  Deno.test(`AC1: a ${state} connection throws ${code} before the resolver is called`, async () => {
    const app = await loadApp(SENDGRID);
    const { resolver, calls } = spyResolver(FROM_RESOLVER);
    const err = await assertRejects(
      () =>
        prepareAuthorization(app, authFor(app, CONNECTION), { ...CONNECTION, state }, {
          purpose: "invoke",
          credentialResolver: resolver,
        }),
      W6WError,
    );
    assertEquals([err.code, err.phase], [code, "auth"]);
    assertEquals(calls.length, 0);
  });
}

Deno.test("AC1: connected -> resolver called exactly once with authKey and purpose; credential never read", async () => {
  const app = await loadApp(SENDGRID);
  const conn: Connection = { ...CONNECTION };
  Object.defineProperty(conn, "credential", {
    enumerable: true,
    get() {
      throw new Error("connection.credential was read");
    },
  });
  const { resolver, calls } = spyResolver(FROM_RESOLVER);
  const prepared = await prepareAuthorization(app, authFor(app, conn), conn, {
    purpose: "fields",
    credentialResolver: resolver,
  });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].authKey, "api-key");
  assertEquals(calls[0].purpose, "fields");
  assert(calls[0].connection === conn);
  assertEquals(prepared.signCredential, { apiKey: "from-resolver" });
  assertEquals(prepared.authorization, FROM_RESOLVER);
});

Deno.test("AC1: needs_refresh + resolver -> core never runs refresh; the resolver output signs (M4)", async () => {
  const app = await loadApp(SENDGRID);
  const { resolver, calls } = spyResolver(FROM_RESOLVER);
  const { server, base, seen } = stubHost();
  try {
    await invoke(app, sendInvocation(base), {
      connection: { ...CONNECTION, state: "needs_refresh" },
      credentialResolver: resolver,
    });
    assertEquals(calls.length, 1);
    // The sendgrid `refresh` hook would have produced "stored-key-refreshed".
    assertEquals(seen[0].headers["authorization"], "Bearer from-resolver");
    assertEquals(calls[0].purpose, "invoke");
  } finally {
    await server.shutdown();
  }
});

Deno.test("AC1: arms map none/legacyOpaque/derived to the sign credential", async () => {
  const app = await loadApp(SENDGRID);
  const auth = authFor(app, CONNECTION);
  const token: DerivedToken = { accessToken: "tok", tokenType: "Bearer", expiresAt: 1234 };
  const prep = (a: ResolvedAuthorization) =>
    prepareAuthorization(app, auth, CONNECTION, {
      purpose: "invoke",
      credentialResolver: spyResolver(a).resolver,
    });

  const none = await prep({ kind: "none" });
  assertEquals(none.signCredential, undefined);

  const legacy = await prep(FROM_RESOLVER);
  assertEquals(legacy.signCredential, { apiKey: "from-resolver" });

  const derived = await prep({
    kind: "derived",
    token: { ...token, privateKey: "SENTINEL" } as DerivedToken,
    expiresAt: 1234,
    sourceRevision: 7,
  });
  // The token and nothing else — not the wrapper, not an extra member.
  assertEquals(derived.signCredential, token);
});

Deno.test("AC1: an unknown resolver kind fails provider_unsupported (phase auth)", async () => {
  const app = await loadApp(SENDGRID);
  const { resolver } = spyResolver({ kind: "jit" } as unknown as ResolvedAuthorization);
  const err = await assertRejects(
    () =>
      prepareAuthorization(app, authFor(app, CONNECTION), CONNECTION, {
        purpose: "invoke",
        credentialResolver: resolver,
      }),
    W6WError,
  );
  assertEquals([err.code, err.phase], ["provider_unsupported", "auth"]);
});

Deno.test("AC1: a resolver rejection propagates unchanged", async () => {
  const app = await loadApp(SENDGRID);
  const boom = new W6WError("credential_revoked", "auth", "revoked upstream");
  const { resolver } = spyResolver(() => Promise.reject(boom));
  const err = await assertRejects(() =>
    prepareAuthorization(app, authFor(app, CONNECTION), CONNECTION, {
      purpose: "invoke",
      credentialResolver: resolver,
    })
  );
  assert(err === boom);
});

Deno.test("AC1: egressTransport -> resolver never called, result is none, refusals stand (M6)", async () => {
  const app = await loadApp(SENDGRID);
  const auth = authFor(app, CONNECTION);
  const egressTransport = () => Promise.reject(new Error("unused"));
  const { credential: _c, ...proxy } = CONNECTION;

  const { resolver, calls } = spyResolver(FROM_RESOLVER);
  const ok = await prepareAuthorization(app, auth, proxy as Connection, {
    purpose: "invoke",
    credentialResolver: resolver,
    egressTransport,
  });
  assertEquals(ok.authorization, { kind: "none" });
  assertEquals(ok.signCredential, undefined);

  const withCred = await assertRejects(
    () =>
      prepareAuthorization(app, auth, CONNECTION, {
        purpose: "invoke",
        credentialResolver: resolver,
        egressTransport,
      }),
    W6WError,
  );
  assertEquals([withCred.code, withCred.phase], ["egress_transport_conflict", "auth"]);

  const refresh = await assertRejects(
    () =>
      prepareAuthorization(app, auth, { ...proxy, state: "needs_refresh" } as Connection, {
        purpose: "invoke",
        credentialResolver: resolver,
        egressTransport,
      }),
    W6WError,
  );
  assertEquals(refresh.code, "egress_transport_conflict");

  const pending = await assertRejects(
    () =>
      prepareAuthorization(app, auth, { ...proxy, state: "pending" } as Connection, {
        purpose: "invoke",
        credentialResolver: resolver,
        egressTransport,
      }),
    W6WError,
  );
  assertEquals(pending.code, "connection_pending");
  assertEquals(calls.length, 0);
});

// ── AC2: no resolver = today ────────────────────────────────────────────────

Deno.test("AC2: no resolver -> legacyOpaque stored; the connection's own credential", async () => {
  const app = await loadApp(SENDGRID);
  const p = await prepareAuthorization(app, authFor(app, CONNECTION), CONNECTION, {
    purpose: "invoke",
  });
  assertEquals(p.authorization, {
    kind: "legacyOpaque",
    source: "stored",
    credential: { apiKey: "stored-key" },
    sourceRevision: null,
  });
  assertEquals(p.signCredential, { apiKey: "stored-key" });
  assertFalse("credential" in p.redacted);
});

Deno.test("AC2: no resolver + needs_refresh still runs the in-core refresh hook", async () => {
  const app = await loadApp(SENDGRID);
  const p = await prepareAuthorization(
    app,
    authFor(app, CONNECTION),
    { ...CONNECTION, state: "needs_refresh" },
    { purpose: "invoke" },
  );
  assertEquals(p.signCredential, { apiKey: "stored-key-refreshed" });
  assertEquals(p.redacted.state, "connected");
});

// ── AC1/M11: the purpose at each of the five call sites ─────────────────────

Deno.test("M11: invoke prepares with purpose invoke", async () => {
  const app = await loadApp(SENDGRID);
  const { resolver, calls } = spyResolver(FROM_RESOLVER);
  const { server, base } = stubHost();
  try {
    await invoke(app, sendInvocation(base), {
      connection: CONNECTION,
      credentialResolver: resolver,
    });
    assertEquals(calls.map((c) => c.purpose), ["invoke"]);
  } finally {
    await server.shutdown();
  }
});

Deno.test("M11: invokeTriggerHook prepares with purpose trigger", async () => {
  const triggers = await loadApp(fx("trigger-hooks"));
  // The trigger fixture declares no auth; borrow sendgrid's so a connection can name one.
  const sendgrid = await loadApp(SENDGRID);
  const app = { ...triggers, auths: sendgrid.auths };
  const { resolver, calls } = spyResolver(FROM_RESOLVER);
  await invokeTriggerHook(app, {
    triggerKey: "pl",
    hook: "poll",
    input: { params: {}, state: { n: 2 }, subscriptionId: "s" },
    connection: CONNECTION,
    credentialResolver: resolver,
  });
  assertEquals(calls.map((c) => c.purpose), ["trigger"]);
});

Deno.test("M11: invokeResolveFields prepares with purpose fields", async () => {
  const app = await loadApp(fx("resolve-fields"));
  const { resolver, calls } = spyResolver(FROM_RESOLVER);
  const { server, base, seen } = stubHost();
  try {
    await invokeResolveFields(
      app,
      "form",
      { reason: "init", form: { mode: "isolation", base }, fields: ["channel"], unresolved: [] },
      {
        connection: { ...CONNECTION, app: "io.w6w.resolve-fields" },
        credentialResolver: resolver,
      },
    );
    assertEquals(calls.map((c) => c.purpose), ["fields"]);
    assertEquals(seen[0].headers["authorization"], "Bearer from-resolver");
  } finally {
    await server.shutdown();
  }
});

Deno.test("M11: a signed health check prepares with purpose health and signs the resolver output", async () => {
  const app = await loadApp(SENDGRID);
  const { resolver, calls } = spyResolver(FROM_RESOLVER);
  const { server, base, seen } = stubHost();
  try {
    const result = await checkHealth(app, "quota", {
      connection: { ...CONNECTION, display: { apiBase: base } },
      credentialResolver: resolver,
    });
    assertEquals(result.report.state, "ok");
    assertEquals(calls.map((c) => c.purpose), ["health"]);
    assertEquals(seen[0].headers["authorization"], "Bearer from-resolver");
  } finally {
    await server.shutdown();
  }
});

Deno.test("M11: a connection with a socket target prepares with purpose socket (even though the connect fails)", async () => {
  const app = await loadApp(fx("socket-connect"));
  const { resolver, calls } = spyResolver({
    kind: "legacyOpaque",
    source: "stored",
    credential: { token: "t" },
    sourceRevision: null,
  });
  await assertRejects(() =>
    invoke(
      app,
      { manifestVersion: "1", app: "io.w6w.socket-connect", action: "round-trip", params: {} },
      {
        connection: {
          manifestVersion: "1",
          id: "conn_sock",
          app: "io.w6w.socket-connect",
          auth: "handshake-auth",
          owner: "user_1",
          state: "connected",
          credential: { token: "stored" },
          createdAt: "2026-10-27T00:00:00Z",
          // Port 1 on loopback: nothing listens, so the connect itself is refused.
          target: { host: "127.0.0.1", port: 1, tlsMode: "disable", allowPrivate: true },
        },
        credentialResolver: resolver,
      },
    )
  );
  assertEquals(calls.map((c) => c.purpose), ["socket"]);
});

// ── AC3: the stub saw nothing for a mismatched auth ─────────────────────────
// (authFor's own strictness tests live in auth.test.ts.)

Deno.test("AC3: a mismatched connection.auth rejects auth_not_found and the host sees zero requests", async () => {
  const app = await loadApp(SENDGRID);
  const { resolver, calls } = spyResolver(FROM_RESOLVER);
  const { server, base, seen } = stubHost();
  try {
    const err = await assertRejects(
      () =>
        invoke(app, sendInvocation(base), {
          connection: { ...CONNECTION, auth: "no-such-auth" },
          credentialResolver: resolver,
        }),
      W6WError,
    );
    assertEquals([err.code, err.phase], ["auth_not_found", "auth"]);
    assertEquals(seen.length, 0);
    assertEquals(calls.length, 0);
  } finally {
    await server.shutdown();
  }
});

// ── AC4: sign sees only the derived token ───────────────────────────────────

const TOKEN: DerivedToken = {
  accessToken: "ya29.derived",
  tokenType: "Bearer",
  expiresAt: 4102444800000,
};
const SA_CONNECTION: Connection = {
  manifestVersion: "1",
  id: "conn_sa",
  app: "io.w6w.service-account",
  auth: "service-account",
  owner: "user_1",
  state: "connected",
  credential: {
    privateKey: "-----BEGIN PRIVATE KEY-----SENTINEL-----END PRIVATE KEY-----",
    private_key: "-----BEGIN PRIVATE KEY-----SENTINEL-----END PRIVATE KEY-----",
  },
  createdAt: "2026-10-27T00:00:00Z",
};
const whoami = (url: string): Invocation => ({
  manifestVersion: "1",
  app: "io.w6w.service-account",
  action: "whoami",
  connection: SA_CONNECTION.id,
  params: { url },
});

Deno.test("AC4: with a derived authorization sign receives exactly the DerivedToken", async () => {
  const app = await loadApp(SERVICE_ACCOUNT);
  const { resolver } = spyResolver({
    kind: "derived",
    token: TOKEN,
    expiresAt: TOKEN.expiresAt,
    sourceRevision: 3,
  });
  const { server, base, seen } = stubHost();
  try {
    await invoke(app, whoami(`${base}/whoami`), {
      connection: SA_CONNECTION,
      credentialResolver: resolver,
    });
    assertEquals(seen.length, 1);
    const h = seen[0].headers;
    assertEquals(h["authorization"], `Bearer ${TOKEN.accessToken}`);
    assertEquals(JSON.parse(h["x-sign-input"]), TOKEN);
    const raw = JSON.stringify(h);
    for (const forbidden of ["privateKey", "private_key", "SENTINEL"]) {
      assertFalse(raw.includes(forbidden), `${forbidden} reached the wire`);
    }
  } finally {
    await server.shutdown();
  }
});

// ── AC5 / R-14: signed test + afterConnect ──────────────────────────────────

const DERIVED: Extract<ResolvedAuthorization, { kind: "derived" }> = {
  kind: "derived",
  token: TOKEN,
  expiresAt: TOKEN.expiresAt,
  sourceRevision: 3,
};

/** Replace globalThis.fetch with a recorder for the duration of `fn`; always restored. */
async function withFetchStub<T>(
  fn: (calls: Array<{ url: string; headers: Headers }>) => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("AC5: signed test runs with credential:null and a signed fetch; nothing else reaches it", async () => {
  const app = await loadApp(SERVICE_ACCOUNT);
  const auth = authFor(app, SA_CONNECTION);
  await withFetchStub(async (calls) => {
    const out = await runAuthHook<{ ok: boolean; message: string; keys: string[] }>(
      app,
      auth,
      "test",
      SA_CONNECTION.credential, // the positional credential must be ignored
      { signing: { authorization: DERIVED } },
    );
    assertEquals(out.message, '{"credential":null}');
    assertEquals(out.ok, true);
    assertEquals(out.keys, ["credential"]);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].url, "https://probe.w6w.test/whoami");
    assertEquals(calls[0].headers.get("authorization"), `Bearer ${TOKEN.accessToken}`);
    assertFalse(JSON.stringify([...calls[0].headers]).includes("SENTINEL"));
  });
});

Deno.test("R-14: signed test forwards exactly binding and credentialDisplay when present", async () => {
  const app = await loadApp(SERVICE_ACCOUNT);
  const auth = authFor(app, SA_CONNECTION);
  const binding = { scopes: ["https://www.googleapis.com/auth/drive"], delegatedUser: "u@x.test" };
  const credentialDisplay = { client_email: "sa@proj.iam.gserviceaccount.com" };
  await withFetchStub(async () => {
    const out = await runAuthHook<{ message: string }>(app, auth, "test", "ignored", {
      // Extra members on the signing object must never be forwarded wholesale.
      signing: { authorization: DERIVED, binding, credentialDisplay },
    });
    assertEquals(JSON.parse(out.message), { credential: null, binding, credentialDisplay });

    // Only one of the two: the absent key is omitted, not undefined-valued.
    const onlyDisplay = await runAuthHook<{ message: string; keys: string[] }>(
      app,
      auth,
      "test",
      "ignored",
      {
        signing: { authorization: DERIVED, credentialDisplay },
      },
    );
    assertEquals(onlyDisplay.message, JSON.stringify({ credential: null, credentialDisplay }));
    assertEquals(onlyDisplay.keys, ["credential", "credentialDisplay"]);
  });
});

Deno.test("AC5: signing with refresh/revoke throws invalid_credential_hook", async () => {
  const app = await loadApp(SENDGRID);
  const auth = authFor(app, CONNECTION);
  for (const hook of ["refresh", "revoke"] as const) {
    const err = await assertRejects(
      () => runAuthHook(app, auth, hook, null, { signing: { authorization: DERIVED } }),
      W6WError,
    );
    assertEquals([err.code, err.phase], ["invalid_credential_hook", "auth"]);
  }
});

Deno.test("AC5 (M8): signing on an auth without a sign hook throws hook_not_declared before any worker spawns", async () => {
  const app = await loadApp(SENDGRID);
  const auth = authFor(app, CONNECTION);
  const noSign = { ...auth, hooks: new Set([...auth.hooks].filter((h) => h !== "sign")) };
  await withFetchStub(async (calls) => {
    const err = await assertRejects(
      () => runAuthHook(app, noSign, "test", null, { signing: { authorization: DERIVED } }),
      W6WError,
    );
    assertEquals([err.code, err.phase], ["hook_not_declared", "auth"]);
    assertEquals(calls.length, 0);
  });
});

Deno.test("AC5: signed mode refuses a non-derived authorization", async () => {
  const app = await loadApp(SERVICE_ACCOUNT);
  const err = await assertRejects(
    () =>
      runAuthHook(app, authFor(app, SA_CONNECTION), "test", null, {
        signing: { authorization: FROM_RESOLVER },
      }),
    W6WError,
  );
  assertEquals([err.code, err.phase], ["provider_unsupported", "auth"]);
});

Deno.test("AC5: a denied host in signed mode resurfaces as egress_denied (auth) with zero fetches", async () => {
  const app = await loadApp(SERVICE_ACCOUNT);
  await withFetchStub(async (calls) => {
    const err = await assertRejects(
      () =>
        runAuthHook(app, authFor(app, SA_CONNECTION), "afterConnect", null, {
          signing: { authorization: DERIVED },
        }),
      W6WError,
    );
    assertEquals([err.code, err.phase], ["egress_denied", "auth"]);
    assertEquals(calls.length, 0);
  });
});

Deno.test("AC5: without signing, runAuthHook is unchanged (positional credential, unsigned fetch)", async () => {
  const app = await loadApp(SERVICE_ACCOUNT);
  await withFetchStub(async (calls) => {
    const out = await runAuthHook<{ message: string }>(
      app,
      authFor(app, SA_CONNECTION),
      "test",
      { k: 1 },
    );
    assertEquals(out.message, '{"credential":{"k":1}}');
    assertEquals(calls[0].headers.get("authorization"), null);
  });
});

// ── ROUND 2: health never reads the credential; one pick; socket handshake ──

/** A copy of `conn` whose `credential` getter counts reads and throws. */
function credentialTripwire(conn: Connection) {
  let reads = 0;
  const tripped: Connection = { ...conn };
  Object.defineProperty(tripped, "credential", {
    enumerable: true,
    get() {
      reads++;
      throw new Error("connection.credential was read");
    },
  });
  return { conn: tripped, reads: () => reads };
}

Deno.test("B1: a signed health check with a resolver never reads connection.credential", async () => {
  const app = await loadApp(SENDGRID);
  const { resolver, calls } = spyResolver(FROM_RESOLVER);
  const { server, base, seen } = stubHost();
  try {
    const t = credentialTripwire({ ...CONNECTION, display: { apiBase: base } });
    const result = await checkHealth(app, "quota", {
      connection: t.conn,
      credentialResolver: resolver,
    });
    assertEquals(t.reads(), 0);
    assertEquals(calls.length, 1);
    assertEquals(result.report.state, "ok");
    assertEquals(seen[0].headers["authorization"], "Bearer from-resolver");
  } finally {
    await server.shutdown();
  }
});

Deno.test("F1: signed runAuthHook strips extra members from the derived token (same pick as invoke)", async () => {
  const app = await loadApp(SERVICE_ACCOUNT);
  const auth = authFor(app, SA_CONNECTION);
  const token = { ...TOKEN, privateKey: "SENTINEL-EXTRA" } as DerivedToken;
  await withFetchStub(async (calls) => {
    await runAuthHook(app, auth, "test", null, {
      signing: { authorization: { ...DERIVED, token } },
    });
    assertEquals(calls.length, 1);
    assertEquals(calls[0].headers.get("authorization"), `Bearer ${TOKEN.accessToken}`);
    assertFalse(JSON.stringify([...calls[0].headers]).includes("SENTINEL-EXTRA"));
  });
});

Deno.test("F2: the socket handshake receives the prepared credential, never connection.credential", async () => {
  const app = await loadApp(fx("socket-connect"));
  const { resolver } = spyResolver({
    kind: "legacyOpaque",
    source: "stored",
    credential: { token: "from-resolver" },
    sourceRevision: 1,
  });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const frame = (async () => {
    const c = await listener.accept();
    const buf = new Uint8Array(4096);
    const n = await c.read(buf);
    const first = new TextDecoder().decode(buf.subarray(0, n ?? 0));
    await c.write(new TextEncoder().encode("OK\n"));
    const n2 = await c.read(buf);
    if (n2) await c.write(buf.subarray(0, n2));
    try {
      await c.read(new Uint8Array(1));
    } catch { /* closed by the peer */ }
    try {
      c.close();
    } catch { /* already gone */ }
    return first;
  })();
  const t = credentialTripwire({
    manifestVersion: "1",
    id: "conn_sock",
    app: "io.w6w.socket-connect",
    auth: "handshake-auth",
    owner: "user_1",
    state: "connected",
    credential: { token: "stored-SENTINEL" },
    createdAt: "2026-10-27T00:00:00Z",
    target: { host: "localhost", port, tlsMode: "disable", allowPrivate: true },
  });
  try {
    await invoke(
      app,
      {
        manifestVersion: "1",
        app: "io.w6w.socket-connect",
        action: "round-trip",
        params: { message: "ping" },
      },
      { connection: t.conn, credentialResolver: resolver },
    );
    assertEquals(await frame, "AUTH from-resolver\n");
    assertEquals(t.reads(), 0);
  } finally {
    try {
      listener.close();
    } catch { /* already closed */ }
  }
});
