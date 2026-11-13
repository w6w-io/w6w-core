import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import {
  instantMs,
  isRefreshable,
  KEEPALIVE_DEFAULT_MAX_IDLE_MS,
  KEEPALIVE_FAILURE_RETRY_MS,
  KEEPALIVE_GIVE_UP_MS,
  KEEPALIVE_LEAD_MS,
  keepAliveDecision,
  keepAliveMaxIdleMs,
  keepAliveNextCheckAt,
  mergeRefreshedCredential,
  normalizeHookRefreshedCredential,
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

Deno.test("isRefreshable: a refresh hook on any stored-credential type; oauth2 built-in unless disabled", () => {
  assert(isRefreshable({ type: "oauth2" }, false));
  assert(isRefreshable({ type: "oauth2", oauth2: {} }, false));
  assert(isRefreshable({ type: "oauth2", oauth2: { builtinRefresh: true } }, false));
  assert(!isRefreshable({ type: "oauth2", oauth2: { builtinRefresh: false } }, false));
  assert(isRefreshable({ type: "oauth2", oauth2: { builtinRefresh: false } }, true));
  // A bearer / custom / apiKey / basic auth is refreshable exactly when it has a refresh hook.
  for (const type of ["bearer", "custom", "apiKey", "basic"]) {
    assert(isRefreshable({ type }, true), type);
    assert(!isRefreshable({ type }, false), type);
  }
  // Nothing stored to renew: never, hook or not.
  for (const type of ["jit", "tenantAuth", "serviceAccount"]) {
    assert(!isRefreshable({ type }, true), type);
    assert(!isRefreshable({ type }, false), type);
  }
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

Deno.test("keepAliveDecision: give up only once an attempt has failed at or past the 72 h mark", () => {
  const since = NOW - KEEPALIVE_GIVE_UP_MS;
  // The hourly retry at the mark itself is the attempt that decides.
  assertEquals(
    keepAliveDecision({ now: NOW, refreshFailingSince: since, lastAttemptAt: NOW - H }),
    { due: true, reason: "final_retry" },
  );
  assertEquals(
    keepAliveDecision({ now: NOW + 15 * 60_000, refreshFailingSince: since, lastAttemptAt: NOW }),
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

Deno.test("keepAliveDecision: after downtime past 72 h, one more attempt before giving up", () => {
  // One failure, then the host was down for 4 days: the streak is old only because nobody tried.
  const since = NOW - 4 * D;
  assertEquals(
    keepAliveDecision({ now: NOW, refreshFailingSince: since, lastAttemptAt: since }),
    { due: true, reason: "final_retry" },
  );
  // No attempt time at all: the same.
  assertEquals(keepAliveDecision({ now: NOW, refreshFailingSince: since }), {
    due: true,
    reason: "final_retry",
  });
  // That attempt failed (lastAttemptAt = now): give up.
  assertEquals(
    keepAliveDecision({ now: NOW, refreshFailingSince: since, lastAttemptAt: NOW }),
    { giveUp: true },
  );
});

Deno.test("keepAliveDecision: a failing connection retries hourly, even while its token is expiring", () => {
  const failing = {
    now: NOW,
    refreshFailingSince: NOW - 5 * H,
    refreshTokenExpiresAt: NOW + 60_000,
  };
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

Deno.test("keepAliveDecision: due when the REFRESH token expires within the lead", () => {
  const base = { now: NOW, lastRefreshedAt: NOW - H };
  assertEquals(keepAliveDecision({ ...base, refreshTokenExpiresAt: NOW + KEEPALIVE_LEAD_MS }), {
    due: true,
    reason: "expiring",
  });
  assertEquals(keepAliveDecision({ ...base, refreshTokenExpiresAt: NOW - D }), {
    due: true,
    reason: "expiring",
  });
  assertEquals(
    keepAliveDecision({ ...base, refreshTokenExpiresAt: NOW + 30 * D }),
    { due: false },
  );
});

Deno.test("keepAliveDecision: the access token's expiry never makes a connection due", () => {
  // A 1 h access token, long expired, refreshed an hour ago: keep-alive leaves it to on-use.
  const input = { now: NOW, lastRefreshedAt: NOW - H, expiresAt: NOW - 59 * 60_000 };
  assertEquals(keepAliveDecision(input as Parameters<typeof keepAliveDecision>[0]), {
    due: false,
  });
});

Deno.test("keepAliveDecision: due after max idle, or when no refresh time is known", () => {
  assertEquals(
    keepAliveDecision({ now: NOW, lastRefreshedAt: NOW - 7 * D }),
    { due: true, reason: "max_idle" },
  );
  assertEquals(
    keepAliveDecision({ now: NOW, lastRefreshedAt: NOW - 7 * D + 1 }),
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

Deno.test("keepAliveDecision: the response's refresh-token expiry outranks the declared TTL", () => {
  // Declared 30 d, but the vendor's last response said 3 d: max idle is 1 d, not 7 d.
  const at = (t: number) =>
    keepAliveDecision({
      now: t,
      lastRefreshedAt: NOW,
      refreshTokenExpiresAt: NOW + 3 * D,
      refreshTokenTtlSeconds: RT_TTL_30D,
    });
  assertEquals(at(NOW + D - 1), { due: false });
  assertEquals(at(NOW + D), { due: true, reason: "max_idle" });
  // The response said 90 d; the declared 3 d no longer shortens the cadence.
  assertEquals(
    keepAliveDecision({
      now: NOW + 2 * D,
      lastRefreshedAt: NOW,
      refreshTokenExpiresAt: NOW + 90 * D,
      refreshTokenTtlSeconds: 3 * 86_400,
    }),
    { due: false },
  );
  // A stale expiry (not after the last refresh) is ignored: the declared TTL applies.
  assertEquals(
    keepAliveDecision({
      now: NOW + D,
      lastRefreshedAt: NOW,
      refreshTokenExpiresAt: NOW,
      refreshTokenTtlSeconds: 3 * 86_400,
    }),
    { due: true, reason: "expiring" },
  );
});

Deno.test("keepAliveDecision: a 7 d access / 30 d refresh token is refreshed at day 7 (max idle)", () => {
  const granted = NOW;
  const at = (t: number) =>
    keepAliveDecision({ now: t, lastRefreshedAt: granted, refreshTokenTtlSeconds: RT_TTL_30D });
  assertEquals(at(granted + 6 * D), { due: false });
  assertEquals(at(granted + 7 * D - 1), { due: false });
  assertEquals(at(granted + 7 * D), { due: true, reason: "max_idle" });
  // The same when the lifetime came only from the token response.
  assertEquals(
    keepAliveDecision({
      now: granted + 7 * D,
      lastRefreshedAt: granted,
      refreshTokenExpiresAt: granted + RT_TTL_30D * 1000,
    }),
    { due: true, reason: "max_idle" },
  );
});

Deno.test("keepAliveDecision: an idle 1 h access token is refreshed once a week, not hourly", () => {
  let last = NOW;
  let grants = 0;
  for (let t = NOW; t <= NOW + 28 * D; t += 15 * 60_000) {
    const d = keepAliveDecision({ now: t, lastRefreshedAt: last });
    if ("due" in d && d.due) {
      grants++;
      last = t;
    }
  }
  assertEquals(grants, 4);
});

Deno.test("keepAliveNextCheckAt: the first instant the decision is no longer 'not due'", () => {
  const cases = [
    { now: NOW, lastRefreshedAt: NOW - D },
    { now: NOW, lastRefreshedAt: NOW - 12 * H, refreshTokenTtlSeconds: 3 * 86_400 },
    // A refresh token with 80 min to live: the lead rule comes before a third of its life.
    { now: NOW, lastRefreshedAt: NOW - 10 * 60_000, refreshTokenExpiresAt: NOW + 70 * 60_000 },
    { now: NOW, lastRefreshedAt: NOW - D, refreshTokenExpiresAt: NOW + 30 * D },
    { now: NOW, refreshFailingSince: NOW - 5 * H, lastAttemptAt: NOW - 10 * 60_000 },
    { now: NOW, refreshFailingSince: NOW - 71.5 * H, lastAttemptAt: NOW - 10 * 60_000 },
  ];
  for (const c of cases) {
    const at = keepAliveNextCheckAt(c);
    assert(at > NOW, JSON.stringify(c));
    assertEquals(keepAliveDecision({ ...c, now: at - 1 }), { due: false }, JSON.stringify(c));
    const then = keepAliveDecision({ ...c, now: at });
    assert("giveUp" in then || then.due, JSON.stringify(c));
  }
  // Due (or to be given up) now → now.
  assertEquals(keepAliveNextCheckAt({ now: NOW }), NOW);
  assertEquals(
    keepAliveNextCheckAt({
      now: NOW,
      refreshFailingSince: NOW - 4 * D,
      lastAttemptAt: NOW - H,
    }),
    NOW,
  );
  assert(keepAliveNextCheckAt({ now: NOW, lastRefreshedAt: NOW - 8 * D }) <= NOW);
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

Deno.test("mergeRefreshedCredential: refresh_token_expires_in sets refreshTokenExpiresAt; absent clears it", () => {
  const out = mergeRefreshedCredential(
    { accessToken: "a0", refreshToken: "r0" },
    { access_token: "a1", refresh_token: "r1", refresh_token_expires_in: 259_200 },
    { now: NOW },
  );
  assertEquals(out.refreshTokenExpiresAt, NOW + 3 * D);
  assertEquals(
    mergeRefreshedCredential(
      { accessToken: "a0", refreshToken: "r0" },
      { access_token: "a1", refresh_token_expires_in: "3600" },
      { now: NOW },
    ).refreshTokenExpiresAt,
    NOW + H,
  );
  // The next response says nothing: the old instant is not carried over.
  const next = mergeRefreshedCredential(out, { access_token: "a2", refresh_token: "r2" }, {
    now: NOW + D,
  });
  assertEquals("refreshTokenExpiresAt" in next, false);
  for (const bad of [0, -1, "x", null]) {
    assertEquals(
      "refreshTokenExpiresAt" in
        mergeRefreshedCredential(out, { access_token: "a2", refresh_token_expires_in: bad }, {
          now: NOW,
        }),
      false,
    );
  }
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

Deno.test("instantMs: epoch ms or ISO 8601; anything else is absent", () => {
  assertEquals(instantMs(NOW), NOW);
  assertEquals(instantMs(new Date(NOW).toISOString()), NOW);
  for (const v of [undefined, null, "", "soon", NaN, Infinity, {}, true]) {
    assertEquals(instantMs(v), undefined, String(v));
  }
});

Deno.test("normalizeHookRefreshedCredential: the hook's new instants are kept, as epoch ms", () => {
  const prev = { token: "t0", refreshToken: "r0", expiresAt: NOW - H };
  const out = normalizeHookRefreshedCredential(prev, {
    token: "t1",
    refreshToken: "r1",
    expiresAt: new Date(NOW + 7 * D).toISOString(),
    refreshTokenExpiresAt: NOW + 30 * D,
  }, { now: NOW, accessTokenTtlSeconds: 3600 });
  assertEquals(out, {
    token: "t1",
    refreshToken: "r1",
    expiresAt: NOW + 7 * D,
    refreshTokenExpiresAt: NOW + 30 * D,
  });
});

Deno.test("normalizeHookRefreshedCredential: no new expiresAt → now + accessTokenTtlSeconds, else unset", () => {
  const prev = { token: "t0", refreshToken: "r0", expiresAt: NOW - H };
  // Omitted.
  assertEquals(
    normalizeHookRefreshedCredential(prev, { token: "t1", refreshToken: "r1" }, {
      now: NOW,
      accessTokenTtlSeconds: AT_TTL_7D,
    }).expiresAt,
    NOW + 7 * D,
  );
  // Carried over from the old credential by a spread: it was the OLD token's instant.
  assertEquals(
    normalizeHookRefreshedCredential(prev, { ...prev, token: "t1" }, {
      now: NOW,
      accessTokenTtlSeconds: AT_TTL_7D,
    }).expiresAt,
    NOW + 7 * D,
  );
  // Unparseable counts as omitted.
  assertEquals(
    normalizeHookRefreshedCredential(prev, { token: "t1", expiresAt: "later" }, {
      now: NOW,
      accessTokenTtlSeconds: AT_TTL_7D,
    }).expiresAt,
    NOW + 7 * D,
  );
  // No TTL declared: unset, never a stale instant.
  const out = normalizeHookRefreshedCredential(prev, { ...prev, token: "t1" }, { now: NOW });
  assert(!("expiresAt" in out));
});

Deno.test("normalizeHookRefreshedCredential: a carried-over refresh-token expiry is dropped only on rotation", () => {
  const prev = {
    token: "t0",
    refreshToken: "r0",
    refreshTokenExpiresAt: new Date(NOW + 2 * D).toISOString(),
  };
  // Rotated, expiry copied by the spread: it described r0, not r1.
  const rotated = normalizeHookRefreshedCredential(prev, {
    ...prev,
    token: "t1",
    refreshToken: "r1",
  }, { now: NOW });
  assert(!("refreshTokenExpiresAt" in rotated));
  assertEquals(rotated.refreshToken, "r1");
  // Not rotated: the same refresh token keeps its (absolute) expiry.
  const kept = normalizeHookRefreshedCredential(prev, { ...prev, token: "t1" }, { now: NOW });
  assertEquals(kept.refreshTokenExpiresAt, NOW + 2 * D);
});

Deno.test("normalizeHookRefreshedCredential: the result REPLACES the credential; nothing is merged back", () => {
  const prev = { token: "t0", refreshToken: "r0", extra: "kept-only-if-returned" };
  const out = normalizeHookRefreshedCredential(prev, { token: "t1" }, { now: NOW });
  assertEquals(out, { token: "t1" });
  assertEquals(prev.token, "t0"); // input not mutated
});
