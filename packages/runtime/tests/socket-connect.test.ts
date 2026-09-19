/**
 * Proves T1.2.2's own mechanism: the pre-connect target check (canonicalize-
 * then-check, every private-range arm), the real `Deno.connect`/`Deno.startTls`,
 * and the iterative handshake loop — wired into `invoke()` end to end against
 * REAL listeners this file starts (`Deno.listen`/`Deno.listenTls`), never a
 * hand-written model of the socket. `socket-sandbox.test.ts` (T1.2.1) already
 * proves the sandbox transport with a fake `onSocket`; this file proves what's
 * behind the real one.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { buildOnSocket, invoke, loadApp, MAX_SOCKET_IO_BYTES, W6WError } from "../mod.ts";
import type { Connection, ConnectionTarget, Invocation } from "@w6w/types";

const DIR = fromFileUrl(new URL("../../../fixtures/apps/socket-connect", import.meta.url));
const EGRESS_DIR = fromFileUrl(new URL("../../../fixtures/apps/egress", import.meta.url));
const CERTS_DIR = new URL("certs/", import.meta.url);

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function writeFully(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const n = await conn.write(data.subarray(offset));
    offset += n;
  }
}

async function readUntilNewline(conn: Deno.Conn): Promise<string> {
  const parts: Uint8Array[] = [];
  const buf = new Uint8Array(4096);
  for (;;) {
    const n = await conn.read(buf);
    if (n === null) break;
    parts.push(buf.slice(0, n));
    const joined = dec(concat(parts));
    if (joined.includes("\n")) return joined;
  }
  return dec(concat(parts));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function inv(action: string, params?: Record<string, unknown>): Invocation {
  return { manifestVersion: "1", app: "io.w6w.socket-connect", action, params };
}

function connectionWithTarget(
  target: ConnectionTarget,
  credential: Record<string, unknown> = { token: "secret-token" },
): Connection {
  return {
    manifestVersion: "1",
    id: "conn_socket_connect",
    app: "io.w6w.socket-connect",
    auth: "handshake-auth",
    owner: "user_1",
    state: "connected",
    credential,
    createdAt: "2026-09-19T00:00:00Z",
    target,
  };
}

/**
 * A listener implementing the fixture's toy protocol: reads the "AUTH
 * <token>\n" handshake frame, acks with "OK\n", then reads and echoes back
 * exactly one further chunk (the action's message), then observes whether
 * the peer closes. Works over both `Deno.listen` and `Deno.listenTls` — both
 * return a `Deno.Listener`.
 */
function startRoundTripListener(listener: Deno.Listener) {
  const result = (async () => {
    const conn = await listener.accept();
    const handshakeFrame = await readUntilNewline(conn);
    await writeFully(conn, enc("OK\n"));

    const buf = new Uint8Array(4096);
    const n = await conn.read(buf);
    const actionFrame = n === null ? null : dec(buf.subarray(0, n));
    if (n !== null) await writeFully(conn, buf.subarray(0, n));

    let closed = false;
    try {
      const n2 = await conn.read(new Uint8Array(1));
      closed = n2 === null;
    } catch {
      closed = true; // reset/gone counts as closed too
    }
    try {
      conn.close();
    } catch {
      // already gone
    }
    return { handshakeFrame, actionFrame, closed };
  })();
  return result;
}

/** A listener that acks the connection but never advances the protocol — for tests that only need Deno.connect() to succeed. */
function listenAndIgnore(): { port: number; close: () => void } {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  return {
    port,
    close: () => {
      try {
        listener.close();
      } catch { /* already gone */ }
    },
  };
}

/** Echoes "PONG\n" for every chunk it receives, forever — for the never-`done` handshake test. */
function startPingPongListener(): { port: number; close: () => void } {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  (async () => {
    try {
      const conn = await listener.accept();
      const buf = new Uint8Array(4096);
      for (;;) {
        const n = await conn.read(buf);
        if (n === null) break;
        await writeFully(conn, enc("PONG\n"));
      }
    } catch {
      // listener closed underneath the loop — fine.
    }
  })();
  return {
    port,
    close: () => {
      try {
        listener.close();
      } catch { /* already gone */ }
    },
  };
}

// ── (a)/(c) — resolution-based, not a blocklist ─────────────────────────────

Deno.test("(a) a host resolving to loopback, allowPrivate absent, is denied — resolution-based, not a literal-string blocklist", async () => {
  const app = await loadApp(DIR);
  const target: ConnectionTarget = { host: "localhost", port: 9, tlsMode: "disable" };
  const err = await assertRejects(
    () =>
      invoke(app, inv("round-trip", { message: "x" }), {
        connection: connectionWithTarget(target),
      }),
    W6WError,
  );
  assertEquals(err.code, "socket_denied");
});

Deno.test("(b) the same target with allowPrivate:true connects and round-trips — never implicit, not always refused", async () => {
  const app = await loadApp(DIR);
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const captured = startRoundTripListener(listener);

  const target: ConnectionTarget = {
    host: "localhost",
    port,
    tlsMode: "disable",
    allowPrivate: true,
  };
  const result = await invoke(app, inv("round-trip", { message: "ping" }), {
    connection: connectionWithTarget(target),
  });

  const frames = await captured;
  assertEquals(frames.handshakeFrame, "AUTH secret-token\n");
  assertEquals(frames.actionFrame, "ping");
  assertEquals((result.value as { echoed: string | null }).echoed, "ping");
  try {
    listener.close();
  } catch { /* already closed after accept */ }
});

Deno.test("(c) a v4-mapped IPv6 loopback literal, allowPrivate absent, is denied", async () => {
  const app = await loadApp(DIR);
  const target: ConnectionTarget = { host: "::ffff:127.0.0.1", port: 9, tlsMode: "disable" };
  const err = await assertRejects(
    () =>
      invoke(app, inv("round-trip", { message: "x" }), {
        connection: connectionWithTarget(target),
      }),
    W6WError,
  );
  assertEquals(err.code, "socket_denied");
});

// ── (d) — shape validation, each arm separately ─────────────────────────────

const BASE_TARGET: ConnectionTarget = { host: "203.0.113.1", port: 5432, tlsMode: "disable" };

Deno.test("(d) shape validation: port 0", async () => {
  const app = await loadApp(DIR);
  const err = await assertRejects(
    () =>
      invoke(app, inv("round-trip", { message: "x" }), {
        connection: connectionWithTarget({ ...BASE_TARGET, port: 0 }),
      }),
    W6WError,
  );
  assertEquals(err.code, "socket_denied");
});

Deno.test("(d) shape validation: port 70000", async () => {
  const app = await loadApp(DIR);
  const err = await assertRejects(
    () =>
      invoke(app, inv("round-trip", { message: "x" }), {
        connection: connectionWithTarget({ ...BASE_TARGET, port: 70000 }),
      }),
    W6WError,
  );
  assertEquals(err.code, "socket_denied");
});

Deno.test("(d) shape validation: empty host", async () => {
  const app = await loadApp(DIR);
  const err = await assertRejects(
    () =>
      invoke(app, inv("round-trip", { message: "x" }), {
        connection: connectionWithTarget({ ...BASE_TARGET, host: "" }),
      }),
    W6WError,
  );
  assertEquals(err.code, "socket_denied");
});

Deno.test('(d) shape validation: tlsMode "custom-ca" with no caCert', async () => {
  const app = await loadApp(DIR);
  const err = await assertRejects(
    () =>
      invoke(app, inv("round-trip", { message: "x" }), {
        connection: connectionWithTarget({ ...BASE_TARGET, tlsMode: "custom-ca" }),
      }),
    W6WError,
  );
  assertEquals(err.code, "socket_denied");
});

// ── every private/loopback/link-local arm (§Pinned mechanism) ──────────────

const PRIVATE_ADDRESSES: Array<[string, string]> = [
  ["0.0.0.0", "0.0.0.0/8"],
  ["10.1.2.3", "10/8"],
  ["100.64.0.1", "100.64/10 (CGNAT)"],
  ["127.0.0.1", "127/8"],
  ["169.254.169.254", "169.254/16 (cloud-metadata address)"],
  ["172.16.0.1", "172.16/12"],
  ["192.0.0.1", "192.0.0/24"],
  ["192.168.1.1", "192.168/16"],
  ["198.18.0.1", "198.18/15"],
  ["224.0.0.1", "224/4"],
  ["240.0.0.1", "240/4"],
  ["::", "IPv6 unspecified"],
  ["::1", "IPv6 loopback"],
  ["fc00::1", "fc00::/7 unique-local"],
  ["fd12:3456:789a::1", "fc00::/7 unique-local (fd)"],
  ["fe80::1", "fe80::/10 link-local"],
  ["::ffff:10.0.0.5", "v4-mapped 10/8"],
];

for (const [host, label] of PRIVATE_ADDRESSES) {
  Deno.test(`private range denied without allowPrivate: ${label} (${host})`, async () => {
    const app = await loadApp(DIR);
    const err = await assertRejects(
      () =>
        invoke(app, inv("round-trip", { message: "x" }), {
          connection: connectionWithTarget({ host, port: 9, tlsMode: "disable" }),
        }),
      W6WError,
    );
    assertEquals(err.code, "socket_denied");
  });
}

// ── (e) — TLS verified by default, never silently skipped ──────────────────

Deno.test("(e) tlsMode verify-full against a self-signed cert fails", async () => {
  const app = await loadApp(DIR);
  const cert = await Deno.readTextFile(new URL("self-signed.crt.pem", CERTS_DIR));
  const key = await Deno.readTextFile(new URL("self-signed.key.pem", CERTS_DIR));
  const listener = Deno.listenTls({ hostname: "127.0.0.1", port: 0, cert, key });
  const port = (listener.addr as Deno.NetAddr).port;
  // Best-effort accept so a slow failure path doesn't leave a dangling accept().
  const acceptResult = listener.accept().catch(() => undefined);

  const target: ConnectionTarget = {
    host: "localhost",
    port,
    tlsMode: "verify-full",
    allowPrivate: true,
  };
  const err = await assertRejects(
    () =>
      invoke(app, inv("round-trip", { message: "x" }), {
        connection: connectionWithTarget(target),
      }),
    W6WError,
  );
  assertEquals(err.code, "socket_unavailable");
  try {
    listener.close();
  } catch { /* already gone */ }
  await acceptResult;
});

Deno.test("(e) tlsMode custom-ca with the cert's own PEM succeeds and round-trips", async () => {
  const app = await loadApp(DIR);
  const cert = await Deno.readTextFile(new URL("self-signed.crt.pem", CERTS_DIR));
  const key = await Deno.readTextFile(new URL("self-signed.key.pem", CERTS_DIR));
  const listener = Deno.listenTls({ hostname: "127.0.0.1", port: 0, cert, key });
  const port = (listener.addr as Deno.NetAddr).port;
  const captured = startRoundTripListener(listener);

  const target: ConnectionTarget = {
    host: "localhost",
    port,
    tlsMode: "custom-ca",
    caCert: cert,
    allowPrivate: true,
  };
  const result = await invoke(app, inv("round-trip", { message: "tls-ping" }), {
    connection: connectionWithTarget(target),
  });

  const frames = await captured;
  assertEquals(frames.handshakeFrame, "AUTH secret-token\n");
  assertEquals(frames.actionFrame, "tls-ping");
  assertEquals((result.value as { echoed: string | null }).echoed, "tls-ping");
  try {
    listener.close();
  } catch { /* already closed after accept */ }
});

// ── (f) — ordering: handshake frames before any action bytes ───────────────

Deno.test("(f) the listener observes the handshake frame before any action bytes, and ctx.socket is live when execute runs", async () => {
  const app = await loadApp(DIR);
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const captured = startRoundTripListener(listener);

  const target: ConnectionTarget = {
    host: "127.0.0.1",
    port,
    tlsMode: "disable",
    allowPrivate: true,
  };
  const result = await invoke(app, inv("round-trip", { message: "action-payload" }), {
    connection: connectionWithTarget(target),
  });

  const frames = await captured;
  assert(frames.handshakeFrame.startsWith("AUTH "), frames.handshakeFrame);
  assertEquals(frames.actionFrame, "action-payload");
  assertEquals((result.value as { echoed: string | null }).echoed, "action-payload");
});

// ── (g) — DC-1: the handshake hook is network-less ──────────────────────────

Deno.test("(g) a handshake hook attempting ctx.fetch fails the step, and the invocation surfaces connection_broken", async () => {
  const app = await loadApp(DIR);
  const { port, close } = listenAndIgnore();

  const target: ConnectionTarget = {
    host: "127.0.0.1",
    port,
    tlsMode: "disable",
    allowPrivate: true,
  };
  const connection = connectionWithTarget(target, { token: "x", mode: "fetch" });
  const err = await assertRejects(
    () => invoke(app, inv("round-trip", { message: "x" }), { connection }),
    W6WError,
  );
  assertEquals(err.code, "connection_broken");
  assertEquals(err.phase, "auth");
  close();
});

// ── (h) — bounded loop ───────────────────────────────────────────────────

Deno.test("(h) a handshake hook that never returns done rejects at the step cap, not a hang", async () => {
  const app = await loadApp(DIR);
  const { port, close } = startPingPongListener();

  const target: ConnectionTarget = {
    host: "127.0.0.1",
    port,
    tlsMode: "disable",
    allowPrivate: true,
  };
  const connection = connectionWithTarget(target, { token: "x", mode: "never-done" });
  const started = Date.now();
  const err = await assertRejects(
    () => invoke(app, inv("round-trip", { message: "x" }), { connection, timeoutMs: 5_000 }),
    W6WError,
  );
  const elapsedMs = Date.now() - started;
  // Observed: a step-cap rejection well under the 5s per-step timeout budget —
  // not a hang, and not a `hook_timeout` (which would mean the cap never
  // fired and every step burned its own timeout instead).
  assertEquals(err.code, "connection_broken");
  assert(elapsedMs < 5_000, `expected a fast step-cap rejection, took ${elapsedMs}ms`);
  close();
});

// ── (i) — the finally: closed on BOTH the resolve and the reject path ──────

Deno.test("(i) the listener observes the socket closed after invoke() resolves", async () => {
  const app = await loadApp(DIR);
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const captured = startRoundTripListener(listener);

  const target: ConnectionTarget = {
    host: "127.0.0.1",
    port,
    tlsMode: "disable",
    allowPrivate: true,
  };
  await invoke(app, inv("round-trip", { message: "close-check" }), {
    connection: connectionWithTarget(target),
  });

  const frames = await captured;
  assertEquals(frames.closed, true);
});

Deno.test("(i) the listener observes the socket closed after invoke() REJECTS", async () => {
  const app = await loadApp(DIR);
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const captured = startRoundTripListener(listener);

  const target: ConnectionTarget = {
    host: "127.0.0.1",
    port,
    tlsMode: "disable",
    allowPrivate: true,
  };
  await assertRejects(
    () =>
      invoke(app, inv("round-trip", { message: "close-check", failAfter: true }), {
        connection: connectionWithTarget(target),
      }),
  );

  const frames = await captured;
  // The round trip itself still happened (the action fails AFTER using the
  // socket) — only the reject path is new evidence here, the close is.
  assertEquals(frames.actionFrame, "close-check");
  assertEquals(frames.closed, true);
});

// ── (j) — the ctx.fetch-only path is untouched ──────────────────────────────

Deno.test("(j) an existing ctx.fetch-only app invoked with no target behaves exactly as before", async () => {
  const app = await loadApp(EGRESS_DIR);
  let received: string | null = null;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      received = req.headers.get("x-api-key");
      return new Response("ok", { status: 200 });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;

  const connection: Connection = {
    manifestVersion: "1",
    id: "conn_egress",
    app: "io.w6w.egress",
    auth: "api-key-header",
    owner: "user_1",
    state: "connected",
    credential: { apiKey: "k-123" },
    createdAt: "2026-09-19T00:00:00Z",
    // Deliberately no `target` — this Connection never carries a socket target.
  };

  const result = await invoke(
    app,
    {
      manifestVersion: "1",
      app: "io.w6w.egress",
      action: "call",
      params: { url: `http://127.0.0.1:${port}/` },
    },
    { connection },
  );
  assertEquals((result.value as { status: number }).status, 200);
  assertEquals(received, "k-123");
  await server.shutdown();
});

// ── FU-4 — bounded onSocket, sanitized errors ───────────────────────────────

Deno.test("FU-4: an oversized read `max` is clamped, never allocated at the requested size", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const acceptPromise = listener.accept();
  const client = await Deno.connect({ hostname: "127.0.0.1", port });
  const server = await acceptPromise;
  await writeFully(server, enc("hi"));

  const onSocket = buildOnSocket(client);
  // If the implementation ever allocated `new Uint8Array(request.max)`
  // directly, this would throw a RangeError (invalid typed array length)
  // before it got anywhere near a real read — the assertion is that it does
  // NOT throw, and still returns the small real payload.
  const result = await onSocket({ op: "read", max: Number.MAX_SAFE_INTEGER });
  assertEquals(result.op, "read");
  assert(result.op === "read" && result.bytes && dec(result.bytes) === "hi");

  try {
    client.close();
  } catch { /* already gone */ }
  try {
    server.close();
  } catch { /* already gone */ }
  try {
    listener.close();
  } catch { /* already gone */ }
});

Deno.test("FU-4: an oversized write is rejected with socket_failed before the real write is attempted", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const acceptPromise = listener.accept();
  const client = await Deno.connect({ hostname: "127.0.0.1", port });
  const server = await acceptPromise;

  const onSocket = buildOnSocket(client);
  const oversized = new Uint8Array(MAX_SOCKET_IO_BYTES + 1);
  const err = await assertRejects(() => onSocket({ op: "write", bytes: oversized }), W6WError);
  assertEquals(err.code, "socket_failed");

  // Prove nothing was actually written: the server sees no bytes within a
  // short window, rather than the (much larger) oversized payload.
  const raceResult = await Promise.race([
    server.read(new Uint8Array(16)).then(() => "got-data" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 200)),
  ]);
  assertEquals(raceResult, "timeout");

  try {
    client.close();
  } catch { /* already gone */ }
  try {
    server.close();
  } catch { /* already gone */ }
  try {
    listener.close();
  } catch { /* already gone */ }
});

Deno.test("FU-4: a raw connect failure's relayed message does not contain the target's raw address", async () => {
  const app = await loadApp(DIR);
  // Port 1 is privileged/unassigned in this container — nothing listens
  // there, so Deno.connect refuses fast and deterministically.
  const target: ConnectionTarget = {
    host: "127.0.0.1",
    port: 1,
    tlsMode: "disable",
    allowPrivate: true,
  };
  const err = await assertRejects(
    () =>
      invoke(app, inv("round-trip", { message: "x" }), {
        connection: connectionWithTarget(target),
      }),
    W6WError,
  );
  assertEquals(err.code, "socket_unavailable");
  assert(!err.message.includes("127.0.0.1"), err.message);
  assert(!err.message.includes(":1"), err.message);
});

// ── FU-6 — trailing post-handshake bytes are never dropped ─────────────────

Deno.test("FU-6: bytes a batching server sends after the auth-confirmation frame, in the SAME write, are not dropped — the first post-handshake ctx.socket.read() yields them", async () => {
  const app = await loadApp(DIR);
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;

  const serverDone = (async () => {
    const conn = await listener.accept();
    await readUntilNewline(conn); // consumes "AUTH <token>\n"
    // ONE single write batching the "OK\n" auth-confirmation frame AND the
    // next protocol message — mirrors a real Postgres server batching
    // AuthenticationSASLFinal+AuthenticationOk+ParameterStatus+BackendKeyData
    // +ReadyForQuery in a single TCP burst.
    await writeFully(conn, enc("OK\nNEXT-MESSAGE\n"));
    try {
      conn.close();
    } catch {
      // already gone
    }
  })();

  const target: ConnectionTarget = {
    host: "127.0.0.1",
    port,
    tlsMode: "disable",
    allowPrivate: true,
  };
  const connection = connectionWithTarget(target, { token: "secret-token", mode: "leftover" });

  // `skipWrite` — the first `ctx.socket.read()` must be satisfiable entirely
  // from the handshake's queued leftover, with no fresh write to prompt the
  // listener (which has already said everything it's going to say).
  const result = await invoke(app, inv("round-trip", { message: "unused", skipWrite: true }), {
    connection,
  });

  await serverDone;
  try {
    listener.close();
  } catch {
    // already gone
  }

  assertEquals((result.value as { echoed: string | null }).echoed, "NEXT-MESSAGE\n");
});
