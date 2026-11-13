import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import {
  isRefreshable,
  KEEPALIVE_DEFAULT_MAX_IDLE_MS,
  KEEPALIVE_FAILURE_RETRY_MS,
  KEEPALIVE_GIVE_UP_MS,
  KEEPALIVE_LEAD_MS,
  keepAliveDecision,
  keepAliveMaxIdleMs,
  mergeRefreshedCredential,
  oauth2RefreshRequest,
  OAuthRefreshError,
} from "../mod.ts";

const H = 60 * 60 * 1000;
const D = 24 * H;
const NOW = Date.UTC(2027, 1, 1);
const RT_TTL_30D = 2_592_000; // 30 d
const AT_TTL_7D = 604_800; // 7 d

Deno.test("keep-alive constants are the contract's values", () => {
  assertEquals(KEEPALIVE_LEAD_MS, H);
  assertEquals(KEEPALIVE_DEFAULT_MAX_IDLE_MS, 7 * D);
  assertEquals(KEEPALIVE_FAILURE_RETRY_MS, H);
  assertEquals(KEEPALIVE_GIVE_UP_MS, 72 * H);
});

Deno.test("isRefreshable: oauth2 only; a hook always counts; builtinRefresh:false disables built-in", () => {
  assert(isRefreshable({ type: "oauth2" }, false));
  assert(isRefreshable({ type: "oauth2", oauth2: {} }, false));
  assert(isRefreshable({ type: "oauth2", oauth2: { builtinRefresh: true } }, false));
  assert(!isRefreshable({ type: "oauth2", oauth2: { builtinRefresh: false } }, false));
  assert(isRefreshable({ type: "oauth2", oauth2: { builtinRefresh: false } }, true));
  assert(!isRefreshable({ type: "apiKey" }, false));
  assert(!isRefreshable({ type: "custom" }, true));
});

Deno.test("keepAliveMaxIdleMs: a third of the refresh-token TTL, capped at a week", () => {
  assertEquals(keepAliveMaxIdleMs(), KEEPALIVE_DEFAULT_MAX_IDLE_MS);
  assertEquals(keepAliveMaxIdleMs(0), KEEPALIVE_DEFAULT_MAX_IDLE_MS);
  assertEquals(keepAliveMaxIdleMs(-5), KEEPALIVE_DEFAULT_MAX_IDLE_MS);
  assertEquals(keepAliveMaxIdleMs(Number.NaN), KEEPALIVE_DEFAULT_MAX_IDLE_MS);
  assertEquals(keepAliveMaxIdleMs(RT_TTL_30D), KEEPALIVE_DEFAULT_MAX_IDLE_MS); // 10 d → 7 d
  assertEquals(keepAliveMaxIdleMs(3 * 86_400), D); // 3 d → 1 d
  assertEquals(keepAliveMaxIdleMs(3_600), 20 * 60 * 1000);
});

Deno.test("keepAliveDecision: give up once failing for 72 h, at the boundary", () => {
  assertEquals(
    keepAliveDecision({ now: NOW, refreshFailingSince: NOW - KEEPALIVE_GIVE_UP_MS }),
    { giveUp: true },
  );
  assertEquals(
    keepAliveDecision({
      now: NOW,
      refreshFailingSince: NOW - KEEPALIVE_GIVE_UP_MS + 1,
      lastAttemptAt: NOW - 2 * H,
    }),
    { due: true, reason: "retry" },
  );
});

Deno.test("keepAliveDecision: a failing connection retries hourly, even while expiring", () => {
  const failing = { now: NOW, refreshFailingSince: NOW - 5 * H, expiresAt: NOW - D };
  assertEquals(keepAliveDecision({ ...failing, lastAttemptAt: NOW - H + 1 }), { due: false });
  assertEquals(keepAliveDecision({ ...failing, lastAttemptAt: NOW - H }), {
    due: true,
    reason: "retry",
  });
  // No attempt time recorded → measured from when the failure began.
  assertEquals(keepAliveDecision({ now: NOW, refreshFailingSince: NOW - 10 * 60_000 }), {
    due: false,
  });
  assertEquals(keepAliveDecision({ now: NOW, refreshFailingSince: NOW - 2 * H }), {
    due: true,
    reason: "retry",
  });
});

Deno.test("keepAliveDecision: due when the access token expires within the lead", () => {
  const base = { now: NOW, lastRefreshedAt: NOW - H };
  assertEquals(keepAliveDecision({ ...base, expiresAt: NOW + KEEPALIVE_LEAD_MS }), {
    due: true,
    reason: "expiring",
  });
  assertEquals(keepAliveDecision({ ...base, expiresAt: NOW - D }), {
    due: true,
    reason: "expiring",
  });
  assertEquals(keepAliveDecision({ ...base, expiresAt: NOW + KEEPALIVE_LEAD_MS + 1 }), {
    due: false,
  });
});

Deno.test("keepAliveDecision: due after max idle, or when no refresh time is known", () => {
  assertEquals(
    keepAliveDecision({ now: NOW, lastRefreshedAt: NOW - 7 * D, expiresAt: NOW + 30 * D }),
    { due: true, reason: "max_idle" },
  );
  assertEquals(
    keepAliveDecision({ now: NOW, lastRefreshedAt: NOW - 7 * D + 1, expiresAt: NOW + 30 * D }),
    { due: false },
  );
  // A short-lived refresh token tightens the cadence: 3 d TTL → refresh daily.
  assertEquals(
    keepAliveDecision({ now: NOW, lastRefreshedAt: NOW - D, refreshTokenTtlSeconds: 3 * 86_400 }),
    { due: true, reason: "max_idle" },
  );
  assertEquals(keepAliveDecision({ now: NOW }), { due: true, reason: "max_idle" });
  // No expiry and recently refreshed: not due.
  assertEquals(keepAliveDecision({ now: NOW, lastRefreshedAt: NOW - H }), { due: false });
});

Deno.test("keepAliveDecision: a 7 d access / 30 d refresh token is refreshed within the hour before day 7", () => {
  const granted = NOW;
  const expiresAt = granted + AT_TTL_7D * 1000;
  const at = (t: number) =>
    keepAliveDecision({
      now: t,
      expiresAt,
      lastRefreshedAt: granted,
      refreshTokenTtlSeconds: RT_TTL_30D,
    });
  assertEquals(at(granted + 6 * D), { due: false });
  assertEquals(at(expiresAt - H - 1), { due: false });
  assertEquals(at(expiresAt - H), { due: true, reason: "expiring" });
});

Deno.test("oauth2RefreshRequest: body client auth sends client_id/secret in the form", () => {
  const { headers, body } = oauth2RefreshRequest({
    refreshToken: "rt-1",
    clientId: "cid",
    clientSecret: "sec",
    clientAuth: "body",
  });
  assertEquals(headers["content-type"], "application/x-www-form-urlencoded");
  assertEquals(headers.accept, "application/json");
  assertEquals(headers.authorization, undefined);
  assertEquals(Object.fromEntries(body), {
    grant_type: "refresh_token",
    refresh_token: "rt-1",
    client_id: "cid",
    client_secret: "sec",
  });
});

Deno.test("oauth2RefreshRequest: basic client auth uses an Authorization header, scope when given", () => {
  const { headers, body } = oauth2RefreshRequest({
    refreshToken: "rt-1",
    scope: "read write",
    clientId: "cid",
    clientSecret: "sëc",
    clientAuth: "basic",
  });
  const bytes = new TextEncoder().encode("cid:sëc");
  assertEquals(
    headers.authorization,
    `Basic ${btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))}`,
  );
  assertEquals(Object.fromEntries(body), {
    grant_type: "refresh_token",
    refresh_token: "rt-1",
    scope: "read write",
  });
});

Deno.test("oauth2RefreshRequest: a public client (no secret) sends only client_id in the body", () => {
  for (const clientAuth of ["basic", "body"] as const) {
    const { headers, body } = oauth2RefreshRequest({
      refreshToken: "rt",
      clientId: "cid",
      clientAuth,
    });
    assertEquals(headers.authorization, undefined);
    assertEquals(body.get("client_id"), "cid");
    assertEquals(body.has("client_secret"), false);
  }
});

Deno.test("mergeRefreshedCredential: rotation replaces the refresh token; expires_in sets expiry", () => {
  const out = mergeRefreshedCredential(
    { accessToken: "a0", refreshToken: "r0", expiresAt: 1, scope: "x", tokenType: "Bearer" },
    { access_token: "a1", refresh_token: "r1", expires_in: 3600, token_type: "bearer" },
    { now: NOW },
  );
  assertEquals(out, {
    accessToken: "a1",
    refreshToken: "r1",
    expiresAt: NOW + 3_600_000,
    scope: "x",
    tokenType: "bearer",
  });
});

Deno.test("mergeRefreshedCredential: no rotation keeps the old refresh token; TTL fallback", () => {
  const out = mergeRefreshedCredential(
    { accessToken: "a0", refreshToken: "r0" },
    { access_token: "a1", refresh_token: "" },
    { now: NOW, accessTokenTtlSeconds: AT_TTL_7D },
  );
  assertEquals(out, {
    accessToken: "a1",
    refreshToken: "r0",
    expiresAt: NOW + AT_TTL_7D * 1000,
  });
});

Deno.test("mergeRefreshedCredential: numeric-string expires_in; no expiry info clears the old one", () => {
  assertEquals(
    mergeRefreshedCredential({ accessToken: "a0" }, { access_token: "a1", expires_in: "60" }, {
      now: NOW,
    }).expiresAt,
    NOW + 60_000,
  );
  const out = mergeRefreshedCredential(
    { accessToken: "a0", refreshToken: "r0", expiresAt: NOW - 5 },
    { access_token: "a1" },
    { now: NOW },
  );
  assertEquals("expiresAt" in out, false);
});

Deno.test("mergeRefreshedCredential: keeps unknown members of the stored credential", () => {
  const prev = { accessToken: "a0", refreshToken: "r0", instanceUrl: "https://x.example" };
  const out = mergeRefreshedCredential(prev, { access_token: "a1" }, { now: NOW }) as
    & typeof prev
    & Record<string, unknown>;
  assertEquals(out.instanceUrl, "https://x.example");
  assertEquals(prev.accessToken, "a0"); // input not mutated
});

Deno.test("mergeRefreshedCredential: unusable responses throw a service-authored error", () => {
  const prev = { accessToken: "a0", refreshToken: "r0" };
  for (const res of [null, "x", [], {}, { access_token: "" }]) {
    assertThrows(() => mergeRefreshedCredential(prev, res, { now: NOW }), OAuthRefreshError);
  }
  const e = assertThrows(
    () =>
      mergeRefreshedCredential(
        prev,
        { error: "invalid_grant", error_description: "token sk-secret revoked" },
        { now: NOW },
      ),
    OAuthRefreshError,
  );
  assertEquals(e.code, "invalid_grant");
  assert(!e.message.includes("sk-secret"));
  const bad = assertThrows(
    () => mergeRefreshedCredential(prev, { error: "<script>x</script> leak" }, { now: NOW }),
    OAuthRefreshError,
  );
  assertEquals(bad.code, undefined);
  assert(!bad.message.includes("leak"));
});
