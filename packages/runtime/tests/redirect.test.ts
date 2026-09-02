import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { invoke, loadApp, W6WError } from "../mod.ts";
import type { Connection, Invocation } from "@w6w/types";

const EGRESS_DIR = fromFileUrl(new URL("../../../fixtures/apps/egress", import.meta.url));

const CONNECTION_BASE = {
  manifestVersion: "1",
  id: "conn_test",
  app: "io.w6w.egress",
  owner: "user_1",
  state: "connected" as const,
  createdAt: "2026-05-24T00:00:00Z",
};

function inv(url: string, connection: Connection): Invocation {
  return {
    manifestVersion: "1",
    app: "io.w6w.egress",
    action: "call",
    connection: connection.id,
    params: { url },
  };
}

interface Captured {
  path: string;
  method: string;
  headers: Headers;
}

/**
 * As `auth.test.ts`'s `captureServer()`, doubled and generalized to route by
 * path: each test needs server A (or B) to answer different paths
 * differently (redirect here, 200 there), which a single fixed handler can't
 * express.
 */
function pathServer(
  hostname: string,
  respond: (path: string, req: Request) => Response | Promise<Response>,
) {
  const requests: Captured[] = [];
  const server = Deno.serve(
    { port: 0, hostname, onListen: () => {} },
    async (req) => {
      const url = new URL(req.url);
      requests.push({ path: url.pathname, method: req.method, headers: req.headers });
      return await respond(url.pathname, req);
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    server,
    port,
    /** First request captured, or `undefined` if none arrived. */
    get: () => requests[0],
    /** The (first) request captured for a given path. */
    byPath: (path: string) => requests.find((r) => r.path === path),
    count: () => requests.length,
    reset: () => {
      requests.length = 0;
    },
  };
}

Deno.test("R0 - liveness control: the denied server genuinely answers", async () => {
  const server = pathServer("localhost", () => new Response("probe-ok", { status: 200 }));
  try {
    const res = await fetch(`http://localhost:${server.port}/probe`);
    assertEquals(res.status, 200);
    await res.text();
    assert(server.get() !== undefined, "server did not record the direct probe");
    server.reset();
    assertEquals(server.get(), undefined, "reset must clear the capture");
  } finally {
    await server.server.shutdown();
  }
});

Deno.test("R1 - cross-host redirect is denied and the credential never arrives there", async () => {
  const app = await loadApp(EGRESS_DIR);
  // Bind the non-allowlisted server as "localhost" (not "127.0.0.1"): under a
  // mutant that drops `redirect: "manual"`, the redirect would be followed
  // natively, and this is the server that must genuinely be reachable for
  // "captured nothing" to mean anything.
  const B = pathServer("localhost", () => new Response("landed", { status: 200 }));
  const A = pathServer("127.0.0.1", (path) => {
    if (path === "/start") {
      return new Response(null, {
        status: 302,
        headers: { location: `http://localhost:${B.port}/landed` },
      });
    }
    return new Response("unexpected", { status: 404 });
  });
  try {
    const connection: Connection = {
      ...CONNECTION_BASE,
      auth: "api-key-header",
      credential: { apiKey: "live-secret-abc123" },
    };
    const err = await assertRejects(
      () => invoke(app, inv(`http://127.0.0.1:${A.port}/start`, connection), { connection }),
      W6WError,
    );
    assertEquals(err.code, "egress_denied");
    assertEquals(err.phase, "execute");
    // The non-allowlisted server captured nothing at all...
    assertEquals(B.get(), undefined);
    // ...and the first, legitimate hop DID carry the credential — the
    // positive half, without which "B got nothing" is satisfiable by an
    // implementation that sends nothing anywhere.
    assertEquals(A.get()?.headers.get("x-api-key"), "live-secret-abc123");
  } finally {
    await A.server.shutdown();
    await B.server.shutdown();
  }
});

Deno.test("R2 - same-host redirect is followed, signed header intact", async () => {
  const app = await loadApp(EGRESS_DIR);
  // A second same-hostname server on a DIFFERENT port — proves a port-only
  // change is still same-host (hostAllowed keys on hostname, not host:port).
  const C = pathServer(
    "127.0.0.1",
    (path) =>
      path === "/landed-port"
        ? new Response("final-port", { status: 200 })
        : new Response("unexpected", { status: 404 }),
  );
  const A = pathServer("127.0.0.1", (path) => {
    if (path === "/same") {
      return new Response(null, { status: 302, headers: { location: "/landed2" } });
    }
    if (path === "/landed2") {
      return new Response("final", { status: 200 });
    }
    if (path === "/port-hop") {
      return new Response(null, {
        status: 302,
        headers: { location: `http://127.0.0.1:${C.port}/landed-port` },
      });
    }
    return new Response("unexpected", { status: 404 });
  });
  try {
    const connection: Connection = {
      ...CONNECTION_BASE,
      auth: "api-key-header",
      credential: { apiKey: "k-r2" },
    };

    const result = await invoke(app, inv(`http://127.0.0.1:${A.port}/same`, connection), {
      connection,
    });
    const value = result.value as { status: number; body: string };
    // Assert all three: status alone would pass an implementation that
    // returns the 302 itself.
    assertEquals(value.status, 200);
    assertEquals(value.body, "final");
    assertEquals(A.byPath("/landed2")?.headers.get("x-api-key"), "k-r2");

    // M6 guard: a redirect that changes only the PORT, keeping the hostname,
    // must still be followed as same-host.
    const portHopResult = await invoke(
      app,
      inv(`http://127.0.0.1:${A.port}/port-hop`, connection),
      {
        connection,
      },
    );
    const portHopValue = portHopResult.value as { status: number; body: string };
    assertEquals(portHopValue.status, 200);
    assertEquals(portHopValue.body, "final-port");
  } finally {
    await A.server.shutdown();
    await C.server.shutdown();
  }
});

Deno.test("R3 - a same-host redirect loop terminates at the hop cap", async () => {
  const app = await loadApp(EGRESS_DIR);
  const A = pathServer(
    "127.0.0.1",
    () => new Response(null, { status: 302, headers: { location: "/loop" } }),
  );
  try {
    const connection: Connection = {
      ...CONNECTION_BASE,
      auth: "api-key-header",
      credential: { apiKey: "k-r3" },
    };
    const err = await assertRejects(
      () => invoke(app, inv(`http://127.0.0.1:${A.port}/loop`, connection), { connection }),
      W6WError,
    );
    assertEquals(err.code, "too_many_redirects");
    assertEquals(err.phase, "execute");
    // The count assertion is what proves the cap is the cap and not the 30s
    // timeout — a timeout would still eventually reject, but not this fast
    // and not after exactly this many requests.
    assert(A.count() <= 6, `expected at most 6 requests, got ${A.count()}`);
  } finally {
    await A.server.shutdown();
  }
});

Deno.test("R4 - pre-sign check denies before `sign` can rescue an off-allowlist request", async () => {
  const app = await loadApp(EGRESS_DIR);
  const A = pathServer(
    "127.0.0.1",
    (path) =>
      path === "/landed"
        ? new Response("ok", { status: 200 })
        : new Response("unexpected", { status: 404 }),
  );
  const B = pathServer("localhost", () => new Response("unexpected", { status: 404 }));
  try {
    const connection: Connection = {
      ...CONNECTION_BASE,
      auth: "rewrite-to-allowed",
      credential: { apiKey: "k-r4", rewriteTo: `http://127.0.0.1:${A.port}/landed` },
    };
    // The request URL is NOT allowlisted; `sign` would rewrite it to A
    // (allowlisted), but the pre-sign check must reject it before `sign`
    // ever runs. On the base tree this invocation succeeds and A.get() is
    // defined — that is the divergence this case exists for.
    const err = await assertRejects(
      () => invoke(app, inv(`http://localhost:${B.port}/start`, connection), { connection }),
      W6WError,
    );
    assertEquals(err.code, "egress_denied");
    assertEquals(A.get(), undefined, "nothing should have reached the allowlisted server either");
  } finally {
    await A.server.shutdown();
    await B.server.shutdown();
  }
});

Deno.test("R5 - pre-sign check denies before the throwing sign hook is ever spawned", async () => {
  const app = await loadApp(EGRESS_DIR);
  const connection: Connection = {
    ...CONNECTION_BASE,
    auth: "throwing",
    credential: { apiKey: "k-r5" },
  };
  // Non-allowlisted destination; nothing ever listens here — the point is
  // that no connection is ever attempted.
  const err = await assertRejects(
    () => invoke(app, inv("http://localhost:1/anything", connection), { connection }),
    W6WError,
  );
  assertEquals(err.code, "egress_denied");
  assert(
    !err.message.includes("SIGN HOOK RAN"),
    `rejection leaked the sign hook's marker, meaning it ran: ${err.message}`,
  );
});

Deno.test("R6 - post-sign check is retained: sign rewriting off-allowlist is still denied", async () => {
  const app = await loadApp(EGRESS_DIR);
  const B = pathServer("localhost", () => new Response("unexpected", { status: 404 }));
  try {
    const connection: Connection = {
      ...CONNECTION_BASE,
      auth: "rewrite-to-denied",
      credential: { apiKey: "k-r6", rewriteTo: `http://localhost:${B.port}/landed` },
    };
    // The request URL IS allowlisted; `sign` rewrites it off-allowlist.
    // hostFetch's own (post-sign) check must still catch this — green here
    // by design, and the case that goes green for the wrong reason if the
    // pre-sign check were implemented by MOVING the existing check rather
    // than adding a second one.
    const err = await assertRejects(
      () => invoke(app, inv("http://127.0.0.1:1/start", connection), { connection }),
      W6WError,
    );
    assertEquals(err.code, "egress_denied");
    assertEquals(B.get(), undefined);
  } finally {
    await B.server.shutdown();
  }
});
