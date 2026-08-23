/**
 * Health checks: loading, derivation, credential posture and roll-up.
 * See rfcs/healthcheck.md.
 */
import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import type { Connection, HealthCheck } from "@w6w/types";
import { checkHealth, describe, healthAllowlist, loadApp } from "../mod.ts";
import { type HealthResult, rollUpHealth } from "../src/health.ts";

const SENDGRID_DIR = fromFileUrl(new URL("../../../fixtures/apps/sendgrid", import.meta.url));

Deno.test("loader: exposes declared checks and derives one per auth `test`", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const keys = [...app.healthChecks.keys()].sort();
  assertEquals(keys, ["auth:api-key", "feed", "quota", "reachable", "service", "webhooks"]);

  // Derived from the auth method — the app declared no credential check itself.
  const derived = app.healthChecks.get("auth:api-key")!;
  assertEquals(derived.check.kind, "credential");
  assertEquals(derived.check.scope, "connection");
  assertEquals(derived.check.covers, ["auth:api-key"]);
  assertEquals(derived.check.severity, "fatal");
  assert(derived.hasHook);
});

Deno.test("loader: an `unavailable` declaration carries no probe", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const webhooks = app.healthChecks.get("webhooks")!;
  assertFalse(webhooks.hasHook);
  assertEquals(webhooks.check.unavailable?.reason, "the vendor publishes no webhook health signal");
});

Deno.test("describe: the health surface is part of the app description", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const health = describe(app).health;
  assertEquals(health.length, 6);
  assert(health.some((h) => h.key === "service"));
  assert(health.some((h) => h.key === "auth:api-key"));
});

// --- the security rule ------------------------------------------------------

Deno.test("allowlist: an unsigned check may reach the hosts it declares", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const service = app.healthChecks.get("service")!;
  // `credential` defaults to "none" for kind "service", so the extra host is granted.
  assert(service.netAllowlist.includes("status.example.test"));
  assert(service.netAllowlist.includes("api.sendgrid.com"), "app hosts still apply");
});

Deno.test("allowlist: a SIGNED check cannot widen its egress", () => {
  // The validator rejects this at author time; the loader refuses it anyway,
  // because widening egress on a signed request would hand a third-party host
  // the user's credential.
  const smuggler: HealthCheck = {
    key: "smuggler",
    title: "Exfiltration attempt",
    kind: "quota",
    credential: "signed",
    network: { allow: ["collector.example.test"] },
  };
  const allowlist = healthAllowlist(["api.sendgrid.com"], smuggler);
  assertEquals(allowlist, ["api.sendgrid.com"]);
  assertFalse(allowlist.includes("collector.example.test"));
});

Deno.test("allowlist: a `context` check may widen, since it is still unsigned", () => {
  const check: HealthCheck = {
    key: "site",
    title: "Site reachable",
    kind: "dependency",
    credential: "context",
    network: { allow: ["probe.example.test"] },
  };
  assert(healthAllowlist(["api.example.test"], check).includes("probe.example.test"));
});

// --- roll-up ----------------------------------------------------------------

const AT = "2026-07-26T12:00:00.000Z";
const result = (
  key: string,
  state: HealthResult["report"]["state"],
  check: Partial<HealthCheck> = {},
  report: Partial<HealthResult["report"]> = {},
): HealthResult => ({
  key,
  check: { key, title: key, kind: "service", ...check } as HealthCheck,
  report: { state, ...report },
  checkedAt: AT,
  durationMs: 1,
});

const now = () => new Date(AT);

Deno.test("roll-up: all green is ok, and nothing is attributed", () => {
  const v = rollUpHealth([result("a", "ok"), result("b", "ok")], { now });
  assertEquals(v.state, "ok");
  assertEquals(v.attributedTo, []);
});

Deno.test("roll-up: `unknown` outranks `ok` — an unverifiable target is never shown healthy", () => {
  const v = rollUpHealth([result("a", "ok"), result("b", "unknown")], { now });
  assertEquals(v.state, "unknown");
  assertEquals(v.attributedTo, ["b"]);
});

Deno.test("roll-up: `unknown` ranks BELOW `degraded` — a broken status page is not an outage", () => {
  const v = rollUpHealth([result("a", "unknown"), result("b", "degraded")], { now });
  assertEquals(v.state, "degraded");
  assertEquals(v.attributedTo, ["b"]);
});

Deno.test("roll-up: a `degraded`-severity check caps how bad it can make the verdict", () => {
  // kind "service" defaults to severity "degraded", so a down vendor degrades
  // rather than downs the target.
  const v = rollUpHealth([result("service", "down")], { now });
  assertEquals(v.state, "degraded");
});

Deno.test("roll-up: a `fatal` check takes the verdict down with it", () => {
  const v = rollUpHealth([result("auth:x", "down", { kind: "credential" })], { now });
  assertEquals(v.state, "down");
  assertEquals(v.attributedTo, ["auth:x"]);
});

Deno.test("roll-up: an `informational` check never worsens the verdict", () => {
  const v = rollUpHealth([
    result("a", "ok"),
    result("quota", "down", { severity: "informational" }),
  ], { now });
  assertEquals(v.state, "ok");
  assertEquals(v.attributedTo, []);
});

Deno.test("roll-up: a result past its ttl decays to unknown", () => {
  const stale = result("a", "ok", {}, { ttlSeconds: 60 });
  const later = () => new Date(new Date(AT).getTime() + 120_000);
  assertEquals(rollUpHealth([stale], { now: later }).state, "unknown");
  // Still inside the ttl it stands.
  assertEquals(rollUpHealth([stale], { now }).state, "ok");
});

Deno.test("roll-up: every check at the worst state is attributed, not just the first", () => {
  const v = rollUpHealth([
    result("a", "down", { kind: "credential" }),
    result("b", "down", { kind: "credential" }),
    result("c", "ok"),
  ], { now });
  assertEquals(v.state, "down");
  assertEquals(v.attributedTo, ["a", "b"]);
});

// --- posture controls signing, end to end -----------------------------------

/** One-shot local endpoint that records whether a credential arrived. */
function captureServer() {
  let captured: { authorization: string | null } | undefined;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      captured = { authorization: req.headers.get("authorization") };
      return new Response(JSON.stringify({ remain: 5, total: 10 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  return {
    server,
    port: (server.addr as Deno.NetAddr).port,
    get: () => captured,
  };
}

function connectionAt(port: number): Connection {
  return {
    manifestVersion: "1",
    id: "conn_health",
    app: "io.w6w.sendgrid",
    auth: "api-key",
    owner: "user_1",
    state: "connected",
    credential: { apiKey: "test-key-123" },
    // `context` checks read the host from here — display data, never a credential.
    display: { apiBase: `http://127.0.0.1:${port}` },
    createdAt: "2026-05-24T00:00:00Z",
  };
}

Deno.test("posture: a `context` check reaches the network WITHOUT the credential", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { server, port, get } = captureServer();
  try {
    const result = await checkHealth(app, "reachable", { connection: connectionAt(port) });
    assertEquals(result.report.state, "ok");
    // The whole contract: it knew which host to call, and `sign` never ran.
    assertEquals(get()?.authorization, null);
  } finally {
    await server.shutdown();
  }
});

Deno.test("posture: a `signed` check DOES carry the credential", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const { server, port, get } = captureServer();
  try {
    const result = await checkHealth(app, "quota", { connection: connectionAt(port) });
    assertEquals(result.report.state, "ok");
    assertEquals(result.report.quota?.[0], {
      id: "credits",
      remaining: 5,
      limit: 10,
      unit: "requests",
    });
    assertEquals(get()?.authorization, "Bearer test-key-123");
  } finally {
    await server.shutdown();
  }
});

Deno.test("posture: a check needing a connection reports unknown without one", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const result = await checkHealth(app, "reachable");
  assertEquals(result.report.state, "unknown");
  assert(result.report.message?.includes("requires a connection"));
});

Deno.test("an `unavailable` check reports its reason rather than failing", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const result = await checkHealth(app, "webhooks");
  assertEquals(result.report.state, "unknown");
  assertEquals(result.report.message, "the vendor publishes no webhook health signal");
});

Deno.test("a probe that throws becomes `unknown`, never an exception", async () => {
  const app = await loadApp(SENDGRID_DIR);
  // `service` calls a host that does not resolve; the check must still report.
  const logged: { message: string; data?: unknown }[] = [];
  const result = await checkHealth(app, "service", {
    onLog: (_level, message, data) => logged.push({ message, data }),
  });
  assertEquals(result.report.state, "unknown");
  // Conformance rule 9: the message is end-user prose, and the transport reason
  // it replaced went to `onLog` rather than to the reader.
  assertEquals(result.report.message, "The status check could not be completed.");
  assert(
    logged.some((l) => l.message.includes('check "service" failed')),
    "the underlying reason is still reachable by an operator",
  );
});

Deno.test("a probe failure never leaks the transport error into `message`", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const result = await checkHealth(app, "service");
  const message = result.report.message ?? "";
  // The concrete regression: a certificate/DNS/connect error reaching a status
  // pill. Assert on the SHAPE of a leak, not on one vendor's wording.
  for (
    const internal of [
      "probe failed",
      "error sending request",
      "certificate",
      "http://",
      "https://",
    ]
  ) {
    assert(
      !message.toLowerCase().includes(internal),
      `message must not carry "${internal}" — got: ${message}`,
    );
  }
});

// --- feed-backed checks (rfcs/healthcheck.md § "Feed-backed checks") --------

Deno.test("health: a declared feed's host is allowed implicitly", () => {
  const check: HealthCheck = {
    key: "feed",
    title: "Feed",
    kind: "service",
    feed: { url: "https://status.example.test/feed.rss" },
  };
  const allowed = healthAllowlist(["api.example.test"], check);
  assert(allowed.includes("status.example.test"), "feed host must be reachable by this hook");
  assert(allowed.includes("api.example.test"), "app allowlist is still honoured");
});

Deno.test("health: a signed check never has its feed host added", () => {
  // The posture rule: a status host must never see a credential. The validator
  // rejects this pairing at author time; this is the belt to its braces.
  const check: HealthCheck = {
    key: "feed",
    title: "Feed",
    kind: "quota",
    credential: "signed",
    feed: { url: "https://status.example.test/feed.rss" },
  };
  assertEquals(healthAllowlist(["api.example.test"], check), ["api.example.test"]);
});

Deno.test("health: a malformed feed URL widens nothing", () => {
  const check: HealthCheck = {
    key: "feed",
    title: "Feed",
    kind: "service",
    feed: { url: "not a url" },
  };
  assertEquals(healthAllowlist(["api.example.test"], check), ["api.example.test"]);
});

Deno.test("health: the fixture's feed check is exposed with its source", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const feed = app.healthChecks.get("feed")!;
  assert(feed, "fixture declares a feed-backed check");
  assertEquals(feed.check.feed?.url, "https://status.example.test/feed.rss");
  assertEquals(feed.check.feed?.limit, 25);
  assert(
    feed.netAllowlist.includes("status.example.test"),
    "the feed host is folded into the check's allowlist at load time",
  );
});

Deno.test("health: an unreachable feed reports unknown, never down", async () => {
  const app = await loadApp(SENDGRID_DIR);
  // status.example.test does not resolve, so the host-side fetch fails and the
  // hook receives `feed.error` — a broken feed says nothing about the vendor.
  const result = await checkHealth(app, "feed", { timeoutMs: 5000 });
  assertEquals(result.report.state, "unknown");
  // The check echoes `feed.error` into `message` (the RFC's own worked pattern),
  // so that string is user-facing by construction — rule 9 binds it too.
  assertEquals(result.report.message, "The status feed could not be read.");
});
