import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { assertPublicDestination, pinnedFetch } from "../src/private-egress.ts";
import { W6WError } from "../src/errors.ts";

const none = { allowPrivate: false };
const res = (m: Record<string, string[]>) => (h: string) => Promise.resolve(m[h] ?? []);

async function code(p: Promise<unknown>): Promise<string> {
  const e = await assertRejects(() => p, W6WError);
  return (e as W6WError).code;
}

Deno.test("metadata IP literal refused with egress_private_denied", async () => {
  assertEquals(
    await code(assertPublicDestination("http://169.254.169.254/latest", none)),
    "egress_private_denied",
  );
});

Deno.test("localhost / loopback / IPv6 literals refused", async () => {
  const resolve = res({ localhost: ["127.0.0.1", "::1"] });
  for (const u of ["http://localhost:5432/", "http://[::1]/", "http://[::ffff:10.0.0.1]/"]) {
    assertEquals(
      await code(assertPublicDestination(u, { ...none, resolve })),
      "egress_private_denied",
    );
  }
});

Deno.test("public name resolving to private (or mixed) refused", async () => {
  const resolve = res({ "a.example": ["10.1.2.3"], "b.example": ["93.184.216.34", "100.64.0.1"] });
  assertEquals(
    await code(assertPublicDestination("https://a.example/", { ...none, resolve })),
    "egress_private_denied",
  );
  assertEquals(
    await code(assertPublicDestination("https://b.example/", { ...none, resolve })),
    "egress_private_denied",
  );
});

Deno.test("unresolvable host refused", async () => {
  assertEquals(
    await code(assertPublicDestination("https://nx.example/", { ...none, resolve: res({}) })),
    "egress_private_denied",
  );
});

Deno.test("public host passes and returns pinned ip", async () => {
  const d = await assertPublicDestination("https://api.example/x", {
    ...none,
    resolve: res({ "api.example": ["93.184.216.34"] }),
  });
  assertEquals(d.pinned, "93.184.216.34");
  assertEquals((await assertPublicDestination("http://8.8.8.8/", none)).pinned, "8.8.8.8");
});

Deno.test("allowPrivate option and W6W_APP_ALLOW_PRIVATE env opt out", async () => {
  await assertPublicDestination("http://169.254.169.254/", { allowPrivate: true });
  Deno.env.set("W6W_APP_ALLOW_PRIVATE", "1");
  try {
    await assertPublicDestination("http://127.0.0.1/");
  } finally {
    Deno.env.delete("W6W_APP_ALLOW_PRIVATE");
  }
  assertEquals(await code(assertPublicDestination("http://127.0.0.1/")), "egress_private_denied");
});

Deno.test("pinnedFetch connects to the pinned IP with the Host header preserved", async () => {
  const srv = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    (r) => new Response("host=" + r.headers.get("host")),
  );
  try {
    const port = (srv.addr as Deno.NetAddr).port;
    // name does not resolve in real DNS: only the pin can reach the server
    const url = `http://pinned.invalid:${port}/`;
    const dest = { host: "pinned.invalid", addresses: ["127.0.0.1"], pinned: "127.0.0.1" };
    const { response, pinned } = await pinnedFetch(url, dest);
    assert(pinned);
    assertEquals(await response.text(), `host=pinned.invalid:${port}`);
  } finally {
    await srv.shutdown();
  }
});

// --- F-1: https pinning (in-process CONNECT proxy → pinned IP, TLS end to end) ---
const CERTS = new URL("certs/", import.meta.url);

async function withTlsServer(
  body: () => BodyInit,
  fn: (port: number, ca: string) => Promise<void>,
) {
  const cert = await Deno.readTextFile(new URL("self-signed.crt.pem", CERTS));
  const key = await Deno.readTextFile(new URL("self-signed.key.pem", CERTS));
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    cert,
    key,
    onListen: () => {},
  }, (req) => new Response(body(), { headers: { "x-host": new URL(req.url).hostname } }));
  try {
    await fn(server.addr.port, cert);
  } finally {
    await server.shutdown();
  }
}

Deno.test("https is pinned: connects to the pinned IP, cert/SNI checked against the name", async () => {
  await withTlsServer(() => "hello", async (port, ca) => {
    const dest = { host: "localhost", addresses: ["127.0.0.1"], pinned: "127.0.0.1" };
    const { response, pinned } = await pinnedFetch(
      `https://localhost:${port}/x`,
      dest,
      {},
      undefined,
      [ca],
    );
    assertEquals(pinned, true);
    assertEquals(await response.text(), "hello");
    // The cert is for "localhost": a different name must fail verification even though the pin works.
    await assertRejects(async () => {
      const r = await pinnedFetch(
        `https://wrong.example:${port}/x`,
        { host: "wrong.example", addresses: ["127.0.0.1"], pinned: "127.0.0.1" },
        {},
        undefined,
        [ca],
      );
      await r.response.text();
    });
  });
});

Deno.test("https dials the pinned IP, not the name's own resolution", async () => {
  await withTlsServer(() => "x", async (port, ca) => {
    // localhost would reach the server; the pin to 127.0.0.2 (nothing listening there) must not.
    await assertRejects(async () => {
      const r = await pinnedFetch(
        `https://localhost:${port}/`,
        { host: "localhost", addresses: ["127.0.0.2"], pinned: "127.0.0.2" },
        {},
        undefined,
        [ca],
      );
      await r.response.text();
    });
  });
});

Deno.test("https streams a large body through the pin", async () => {
  const chunk = new Uint8Array(64 * 1024).fill(97);
  await withTlsServer(
    () =>
      new ReadableStream({
        start(c) {
          for (let i = 0; i < 64; i++) c.enqueue(chunk);
          c.close();
        },
      }),
    async (port, ca) => {
      const { response } = await pinnedFetch(
        `https://localhost:${port}/`,
        { host: "localhost", addresses: ["127.0.0.1"], pinned: "127.0.0.1" },
        {},
        undefined,
        [ca],
      );
      let n = 0;
      for await (const c of response.body!) n += c.byteLength;
      assertEquals(n, 64 * 64 * 1024);
    },
  );
});

Deno.test("v6 special-use arms refused; public v6 and public-embedded forms pass", async () => {
  const denied = [
    "ff02::1", // multicast
    "64:ff9b::a00:1", // NAT64 -> 10.0.0.1
    "2002:0a00:0001::", // 6to4 -> 10.0.0.1
    "fec0::1", // site-local
    "2001:0:4136:e378:8000:63bf:f5ff:fffe", // Teredo, client 10.0.0.1
  ];
  for (const a of denied) {
    assertEquals(
      await code(assertPublicDestination(`http://[${a}]/`, none)),
      "egress_private_denied",
      a,
    );
  }
  // NAT64 to a public v4 (8.8.8.8) and 6to4 of a public v4 stay allowed.
  for (const a of ["64:ff9b::808:808", "2002:0808:0808::1"]) {
    await assertPublicDestination(`http://[${a}]/`, none);
  }
});
