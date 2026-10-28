import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@^1.0.0";
import { W6WError } from "@w6w/runtime";
import type { ApprovedBinding, TokenEgress } from "@w6w/types";
import { GOOGLE_TOKEN_ENDPOINT, googleServiceAccountV1 as p } from "../mod.ts";
import { testKey } from "./_keys.ts";

const CANARY = "CANARY-7f3a9c-secret-body";
const NOW = 1_700_000_000_000;

async function src(extra: Record<string, unknown> = {}) {
  const k = await testKey();
  return {
    type: "service_account",
    client_email: "sa@proj.iam.gserviceaccount.com",
    private_key: k.pem,
    ...extra,
  };
}

type Call = { url: string; init: Parameters<TokenEgress>[1] };
function mock(res: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const egress: TokenEgress = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(res());
  };
  return { calls, egress };
}
const ok = (o: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({ access_token: "tok-1", expires_in: 3599, token_type: "Bearer", ...o }),
    { status: 200 },
  );

const approved = (over: Partial<ApprovedBinding> = {}): ApprovedBinding => ({
  scopes: ["https://www.googleapis.com/auth/drive"],
  delegatedUser: null,
  ...over,
});

function decode(part: string) {
  const b = part.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b + "=".repeat((4 - (b.length % 4)) % 4)));
}
function jwtOf(call: Call) {
  const m = /assertion=([^&]+)$/.exec(call.init.body)!;
  const [h, c, s] = m[1].split(".");
  return { h: decode(h), c: decode(c), signed: `${h}.${c}`, sig: s };
}

function errOf(e: unknown): W6WError {
  assert(e instanceof W6WError);
  return e;
}
function leaks(e: W6WError, needle: string) {
  return [e.message, String(e), JSON.stringify(e), JSON.stringify(e.details)].some((s) =>
    s.includes(needle)
  );
}

// --- validateSource / displayOf ------------------------------------------------------------

Deno.test("validateSource: keeps exactly the source keys, drops token_uri/scopes/etc", async () => {
  const out = p.validateSource(
    await src({
      private_key_id: "kid1",
      project_id: "proj",
      client_id: "cid",
      token_uri: "https://evil.example/token",
      auth_uri: "x",
      scopes: "a b",
      client_x509_cert_url: "y",
    }),
  ) as Record<string, string>;
  assertEquals(
    Object.keys(out).sort(),
    ["client_email", "client_id", "private_key", "private_key_id", "project_id", "type"],
  );
  assert(!("token_uri" in out) && !("scopes" in out));
});

Deno.test("validateSource: only present optional keys; JSON string input; \\n and trim", async () => {
  const k = await testKey();
  const escaped = " " + k.pem.trim().replace(/\n/g, "\\n") + " ";
  const out = p.validateSource(JSON.stringify({
    type: "service_account",
    client_email: "a@b",
    private_key: escaped,
  })) as Record<string, string>;
  assertEquals(Object.keys(out).sort(), ["client_email", "private_key", "type"]);
  assertEquals(out.private_key, k.pem.trim());
});

Deno.test("validateSource: serviceAccountKey wrapper (object)", async () => {
  const out = p.validateSource({ serviceAccountKey: await src({ token_uri: "x" }) }) as Record<
    string,
    string
  >;
  assertEquals(out.client_email, "sa@proj.iam.gserviceaccount.com");
  assert(!("token_uri" in out));
});

Deno.test("validateSource: serviceAccountKey wrapper (JSON string)", async () => {
  const out = p.validateSource({ serviceAccountKey: JSON.stringify(await src()) }) as Record<
    string,
    string
  >;
  assertEquals(out.type, "service_account");
});

Deno.test("validateSource: wrapper with an extra key is rejected", () => {
  const e = errOf(
    assertThrows(() => p.validateSource({ serviceAccountKey: undefined, other: 1 })),
  );
  assertEquals(e.code, "credential_invalid");
  const e2 = errOf(
    assertThrows(() => p.validateSource({ serviceAccountKey: JSON.stringify({}), other: 1 })),
  );
  assertEquals((e2.details as { field: string }).field, "serviceAccountKey");
});

Deno.test("validateSource: rejection table with details.field and no leak", async () => {
  const k = await testKey();
  const base = await src();
  const body = k.pem.split("\n")[1];
  const rows: [string, unknown, string][] = [
    ["not an object", 42, "source"],
    ["array", [], "source"],
    ["bad json", "{nope" + CANARY, "source"],
    ["wrong type", { ...base, type: "authorized_user" }, "type"],
    ["missing email", { ...base, client_email: undefined }, "client_email"],
    ["empty email", { ...base, client_email: "" }, "client_email"],
    ["no armor", { ...base, private_key: CANARY }, "private_key"],
    [
      "encrypted",
      {
        ...base,
        private_key:
          `-----BEGIN ENCRYPTED PRIVATE KEY-----\n${body}\n-----END ENCRYPTED PRIVATE KEY-----`,
      },
      "private_key",
    ],
    [
      "pkcs1",
      {
        ...base,
        private_key: `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`,
      },
      "private_key",
    ],
    [
      "bad base64",
      {
        ...base,
        private_key: `-----BEGIN PRIVATE KEY-----\n${CANARY}!!\n-----END PRIVATE KEY-----`,
      },
      "private_key",
    ],
    ["non-string optional", { ...base, project_id: 5 }, "project_id"],
    ["non-string kid", { ...base, private_key_id: { a: CANARY } }, "private_key_id"],
  ];
  for (const [name, input, field] of rows) {
    const e = errOf(assertThrows(() => p.validateSource(input), W6WError, undefined, name));
    assertEquals(e.code, "credential_invalid", name);
    assertEquals((e.details as { field: string }).field, field, name);
    assert(!leaks(e, CANARY) && !leaks(e, body), name);
  }
});

Deno.test("displayOf: only the four display keys, never key bytes or token_uri", async () => {
  const raw = await src({
    private_key_id: "kid",
    client_id: "cid",
    project_id: "pj",
    token_uri: "https://evil.example/token",
  });
  assertEquals(p.displayOf(raw), {
    client_email: "sa@proj.iam.gserviceaccount.com",
    private_key_id: "kid",
    client_id: "cid",
    project_id: "pj",
  });
  assertEquals(p.displayOf({ ...raw, private_key_id: undefined, client_id: 3 }), {
    client_email: "sa@proj.iam.gserviceaccount.com",
    project_id: "pj",
  });
  assertEquals(p.displayOf(null), {});
});

// --- deriveAuthorization -------------------------------------------------------------------

Deno.test("provider metadata: contract, version, capabilities, no revoke", () => {
  assertEquals(p.contract, "google-service-account.v1");
  assertEquals(p.version, "1.0.0");
  assertEquals(p.capabilities, {
    handoffable: false,
    crossConnectionTokenReuse: false,
    delegation: true,
  });
  assertEquals(p.revoke, undefined);
});

Deno.test("derive: egress called exactly once at the pinned URL even with a hostile token_uri", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("ambient fetch must never be used");
  };
  try {
    const m = mock(() => ok());
    const t = await p.deriveAuthorization({
      source: await src({ token_uri: "https://evil.example/token" }),
      binding: {},
      approved: approved(),
      egress: m.egress,
      now: NOW,
    });
    assertEquals(t.accessToken, "tok-1");
    assertEquals(m.calls.length, 1);
    assertEquals(m.calls[0].url, GOOGLE_TOKEN_ENDPOINT);
    assertEquals(GOOGLE_TOKEN_ENDPOINT, "https://oauth2.googleapis.com/token");
    assertEquals(m.calls[0].init.method, "POST");
    assertEquals(m.calls[0].init.headers, { "content-type": "application/x-www-form-urlencoded" });
    assert(m.calls[0].init.body.startsWith(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=",
    ));
    assert(!m.calls[0].init.body.includes("evil.example"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("derive: JWT header/claims key set, values and verifiable RS256 signature", async () => {
  const k = await testKey();
  const m = mock(() => ok());
  const t = await p.deriveAuthorization({
    source: await src({ private_key_id: "kid9" }),
    binding: {},
    approved: approved({ scopes: ["s1", "s2"], delegatedUser: "user@x.com" }),
    egress: m.egress,
    now: NOW,
  });
  const j = jwtOf(m.calls[0]);
  assertEquals(j.h, { alg: "RS256", typ: "JWT", kid: "kid9" });
  assertEquals(Object.keys(j.c).sort(), ["aud", "exp", "iat", "iss", "scope", "sub"]);
  assertEquals(j.c.iss, "sa@proj.iam.gserviceaccount.com");
  assertEquals(j.c.scope, "s1 s2");
  assertEquals(j.c.aud, GOOGLE_TOKEN_ENDPOINT);
  assertEquals(j.c.sub, "user@x.com");
  assertEquals(j.c.iat, Math.floor(NOW / 1000));
  assertEquals(j.c.exp - j.c.iat, 3600);
  const b = j.sig.replace(/-/g, "+").replace(/_/g, "/");
  const sig = Uint8Array.from(
    atob(b + "=".repeat((4 - (b.length % 4)) % 4)),
    (c) => c.charCodeAt(0),
  );
  assert(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      k.publicKey,
      sig,
      new TextEncoder().encode(j.signed),
    ),
  );
  assertEquals(t, { accessToken: "tok-1", tokenType: "Bearer", expiresAt: NOW + 3599 * 1000 });
});

Deno.test("derive: no kid without private_key_id; no sub without a delegate (claims key set)", async () => {
  const m = mock(() => ok());
  await p.deriveAuthorization({
    source: await src(),
    binding: {},
    approved: approved(),
    egress: m.egress,
    now: NOW,
  });
  const j = jwtOf(m.calls[0]);
  assertEquals(Object.keys(j.h).sort(), ["alg", "typ"]);
  assertEquals(Object.keys(j.c).sort(), ["aud", "exp", "iat", "iss", "scope"]);
});

Deno.test("derive: binding wider than approved never feeds scope or sub", async () => {
  const m = mock(() => ok());
  await p.deriveAuthorization({
    source: await src(),
    binding: { scopes: ["wide-1", "wide-2"], delegatedUser: "binding-user@x.com" },
    approved: approved({ scopes: ["narrow"], delegatedUser: null }),
    egress: m.egress,
    now: NOW,
  });
  const j = jwtOf(m.calls[0]);
  assertEquals(j.c.scope, "narrow");
  assert(!("sub" in j.c));
});

Deno.test("derive: empty approved scopes -> scope_not_approved with zero egress", async () => {
  const m = mock(() => ok());
  const e = errOf(
    await assertRejects(async () =>
      p.deriveAuthorization({
        source: await src(),
        binding: { scopes: ["x"] },
        approved: approved({ scopes: [] }),
        egress: m.egress,
      })
    ),
  );
  assertEquals(e.code, "scope_not_approved");
  assertEquals(m.calls.length, 0);
});

Deno.test("derive: key import failure -> credential_invalid with zero egress", async () => {
  const m = mock(() => ok());
  const bad = await src({
    private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
  });
  const e = errOf(
    await assertRejects(() =>
      p.deriveAuthorization({ source: bad, binding: {}, approved: approved(), egress: m.egress })
    ),
  );
  assertEquals(e.code, "credential_invalid");
  assertEquals(m.calls.length, 0);
  assert(!("cause" in e) || e.cause === undefined);
});

Deno.test("derive: stateless -- two calls return the tokens egress returned", async () => {
  const mk = async (tok: string) => {
    const m = mock(() => ok({ access_token: tok }));
    return (await p.deriveAuthorization({
      source: await src(),
      binding: {},
      approved: approved(),
      egress: m.egress,
      now: NOW,
    })).accessToken;
  };
  assertEquals(await mk("A"), "A");
  assertEquals(await mk("B"), "B");
});

Deno.test("derive: token_type is case-insensitive bearer", async () => {
  const m = mock(() => ok({ token_type: "bearer" }));
  const t = await p.deriveAuthorization({
    source: await src(),
    binding: {},
    approved: approved(),
    egress: m.egress,
    now: NOW,
  });
  assertEquals(t.tokenType, "Bearer");
});

// --- error map -----------------------------------------------------------------------------

async function derive(res: () => Response | Promise<Response>, delegate: string | null) {
  const m = mock(res);
  try {
    await p.deriveAuthorization({
      source: await src(),
      binding: {},
      approved: approved({ delegatedUser: delegate }),
      egress: m.egress,
      now: NOW,
    });
  } catch (e) {
    return errOf(e);
  }
  throw new Error("expected rejection");
}
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status });

Deno.test("error map: egress rejects -> credential_invalid retryable", async () => {
  const e2 = await derive(() => {
    throw new Error(CANARY);
  }, null);
  assertEquals(e2.code, "credential_invalid");
  assertEquals(e2.details, { retryable: true, status: null });
  assert(!leaks(e2, CANARY));
});

Deno.test("error map: 429 and >=500 -> credential_invalid retryable", async () => {
  for (const status of [429, 500, 503]) {
    const e = await derive(json(status, { error: "invalid_grant" }), "u@x.com");
    assertEquals(e.code, "credential_invalid", String(status));
    assertEquals((e.details as { retryable: boolean }).retryable, true, String(status));
    assertEquals((e.details as { status: number }).status, status);
  }
});

Deno.test("error map: 5xx is retryable:true (not false)", async () => {
  const e = await derive(() => new Response("upstream down", { status: 502 }), null);
  assertEquals((e.details as { retryable: boolean }).retryable, true);
});

Deno.test("error map: unauthorized_client/invalid_grant with sub -> delegation_rejected", async () => {
  for (const error of ["unauthorized_client", "invalid_grant"]) {
    const e = await derive(json(401, { error }), "u@x.com");
    assertEquals(e.code, "delegation_rejected", error);
    assertEquals(e.details, { retryable: false, status: 401, oauthError: error });
  }
});

Deno.test("error map: invalid_grant WITHOUT sub -> credential_invalid", async () => {
  for (const error of ["unauthorized_client", "invalid_grant"]) {
    const e = await derive(json(400, { error }), null);
    assertEquals(e.code, "credential_invalid", error);
    assertEquals((e.details as { retryable: boolean }).retryable, false);
  }
});

Deno.test("error map: other non-2xx -> credential_invalid non-retryable", async () => {
  const e = await derive(json(400, { error: "invalid_scope" }), "u@x.com");
  assertEquals(e.code, "credential_invalid");
  assertEquals(e.details, { retryable: false, status: 400, oauthError: "invalid_scope" });
  const e2 = await derive(() => new Response("nope", { status: 302 }), null);
  assertEquals(e2.details, { retryable: false, status: 302 });
});

Deno.test("error map: malformed 2xx variants -> credential_invalid non-retryable", async () => {
  const variants: Array<() => Response> = [
    () => new Response("not json", { status: 200 }),
    () => new Response("[]", { status: 200 }),
    () => new Response(JSON.stringify({ expires_in: 5, token_type: "Bearer" }), { status: 200 }),
    () => ok({ access_token: "" }),
    () => ok({ access_token: 5 }),
    () => ok({ expires_in: 0 }),
    () => ok({ expires_in: -5 }),
    () => ok({ expires_in: "3600" }),
    () => ok({ expires_in: null }),
    () => ok({ token_type: "MAC" }),
    () => ok({ token_type: undefined }),
  ];
  for (const [i, v] of variants.entries()) {
    const e = await derive(v, null);
    assertEquals(e.code, "credential_invalid", `variant ${i}`);
    assertEquals(e.details, { retryable: false, status: 200 }, `variant ${i}`);
  }
});

Deno.test("canary: error_description never surfaces", async () => {
  const e = await derive(json(400, { error: "invalid_scope", error_description: CANARY }), null);
  assert(!leaks(e, CANARY));
});

Deno.test("canary: the error value itself never surfaces; unknown error leaves no oauthError", async () => {
  const e = await derive(json(400, { error: CANARY }), "u@x.com");
  assert(!leaks(e, CANARY));
  assertEquals("oauthError" in (e.details as object), false);
  const e2 = await derive(json(401, { error: CANARY + "invalid_grant" }), "u@x.com");
  assertEquals(e2.code, "credential_invalid");
  assert(!leaks(e2, CANARY));
});

Deno.test("canary: 5xx text body never surfaces", async () => {
  const e = await derive(() => new Response(CANARY, { status: 500 }), null);
  assert(!leaks(e, CANARY));
});

Deno.test("canary: non-token field of a malformed 2xx never surfaces", async () => {
  const e = await derive(
    () =>
      new Response(JSON.stringify({ access_token: "", note: CANARY, error_description: CANARY }), {
        status: 200,
      }),
    null,
  );
  assert(!leaks(e, CANARY));
});

Deno.test("canary: the minted token and signed assertion never appear in errors", async () => {
  const e = await derive(
    () => new Response(JSON.stringify({ access_token: CANARY, expires_in: 0 }), { status: 200 }),
    null,
  );
  assert(!leaks(e, CANARY));
});
