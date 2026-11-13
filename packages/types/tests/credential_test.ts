import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1.0.0";
import {
  acceptedContractsFor,
  type AccessScope,
  type AfterConnectHook,
  type Auth,
  AUTH_TYPES,
  type AuthDefinition,
  type AuthType,
  type Connection,
  CREDENTIAL_CONTRACT_ID_RE,
  CREDENTIAL_ERROR_CODES,
  type CredentialOwnership,
  type CredentialRecord,
  genericContractFor,
  isLegacyContractId,
  legacyContractId,
  mapGenericSource,
  type Param,
  redact,
  type RedactedConnection,
  type ResolvedAuthorization,
  STATIC_CREDENTIAL_CONTRACTS,
  type StoredToken,
} from "../mod.ts";

Deno.test("AUTH_TYPES pins the canonical order", () => {
  assertEquals([...AUTH_TYPES], [
    "oauth2",
    "apiKey",
    "basic",
    "bearer",
    "custom",
    "tenantAuth",
    "jit",
    "serviceAccount",
  ]);
});

Deno.test("CREDENTIAL_ERROR_CODES are exactly the ten resolution-time codes, in order", () => {
  assertEquals([...CREDENTIAL_ERROR_CODES], [
    "credential_disabled",
    "credential_missing",
    "credential_revoked",
    "delegation_rejected",
    "provider_unsupported",
    "scope_not_approved",
    "auth_not_found",
    "jit_unavailable_in_background",
    "credential_invalid",
    "user_context_required",
  ]);
  assertEquals(CREDENTIAL_ERROR_CODES.length, 10);
});

Deno.test("legacy contract ids", () => {
  assertEquals(
    legacyContractId("io.w6w.gmail", "service-account"),
    "legacy:io.w6w.gmail#service-account",
  );
  assert(isLegacyContractId("legacy:io.w6w.gmail#service-account"));
  assert(isLegacyContractId("legacy:"));
  assertFalse(isLegacyContractId("google-service-account.v1"));
  assertFalse(isLegacyContractId("Legacy:x"));
  assertFalse(isLegacyContractId(""));
});

Deno.test("CREDENTIAL_CONTRACT_ID_RE accepts and rejects the pinned rows", () => {
  assertEquals(CREDENTIAL_CONTRACT_ID_RE.flags, "");
  for (const ok of ["google-service-account.v1", "a.v10"]) {
    assert(CREDENTIAL_CONTRACT_ID_RE.test(ok), ok);
  }
  for (
    const bad of [
      "Google-sa.v1",
      "x.v1.2",
      "x",
      "x.v",
      "x.V1",
      "google-service-account.v1x",
      "_google-service-account.v1",
      "Xgoogle-service-account.v1",
      "legacy:io.w6w.gmail#service-account",
    ]
  ) {
    assertFalse(CREDENTIAL_CONTRACT_ID_RE.test(bad), bad);
  }
});

Deno.test("type shapes are pinned", () => {
  const a: AuthType = "serviceAccount";
  // @ts-expect-error "none" is not an auth type
  const b: AuthType = "none";
  const ok: StoredToken = {
    token: { accessToken: "t", tokenType: "Bearer", expiresAt: 1 },
    source: "provider",
    sourceRevision: 1,
    bindingRevision: 1,
    version: 1,
  };
  const jit: StoredToken = {
    ...ok,
    // @ts-expect-error a JIT token is never stored
    source: "jit",
  };
  const rec: CredentialRecord = {
    id: "c",
    tenant: "t",
    account: "a",
    createdBy: "u",
    accessScope: "account",
    name: "n",
    contract: "google-service-account.v1",
    revision: 1,
    refreshSeq: 0,
    status: "active",
    display: {},
    ownerConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    // @ts-expect-error a record never carries a payload
    source: {},
  };
  const rec2: CredentialRecord = {
    ...rec,
    // @ts-expect-error a record never carries ciphertext
    ciphertext: "x",
  };
  // @ts-expect-error a derived authorization needs sourceRevision
  const d: ResolvedAuthorization = {
    kind: "derived",
    token: ok.token,
    expiresAt: 1,
  };
  assert(a && b && jit && rec2 && d);
});

Deno.test("CredentialRecord requires accessScope; a user record carries ownerSubject", () => {
  const base = {
    id: "c",
    tenant: "t",
    account: "a",
    createdBy: "u",
    name: "n",
    contract: "bearer.v1",
    revision: 1,
    refreshSeq: 0,
    status: "active" as const,
    display: {},
    ownerConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  // @ts-expect-error accessScope is required
  const missing: CredentialRecord = { ...base };
  const user: CredentialRecord = { ...base, accessScope: "user", ownerSubject: "sub_1" };
  const own: CredentialOwnership = { accessScope: "user", ownerSubject: "sub_1" };
  // @ts-expect-error a user-scoped ownership needs ownerSubject
  const bad: CredentialOwnership = { accessScope: "user" };
  const acct: CredentialOwnership = { accessScope: "account" };
  const scope: AccessScope = user.accessScope;
  assertEquals(user.ownerSubject, "sub_1");
  assert(missing && own && bad && acct && scope);
});

const FULL: Connection = {
  manifestVersion: "1",
  id: "conn_1",
  app: "io.w6w.gmail",
  auth: "service-account",
  owner: "u",
  state: "connected",
  credential: { secret: "x" },
  display: { email: "a@b.c" },
  label: "L",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastTestedAt: "2026-01-02T00:00:00.000Z",
  lastRefreshedAt: "2026-01-03T00:00:00.000Z",
  expiresAt: "2026-01-04T00:00:00.000Z",
  target: { host: "h", port: 1, tlsMode: "disable" },
  credentialId: "cred_1",
  binding: { scopes: ["s"], delegatedUser: "d@b.c" },
  approved: { scopes: ["s"], delegatedUser: null },
  bindingRevision: 2,
};

Deno.test("redact returns exactly the 11 pinned keys", () => {
  const out = redact(FULL);
  assertEquals(Object.keys(out).sort(), [
    "app",
    "auth",
    "createdAt",
    "display",
    "expiresAt",
    "id",
    "label",
    "lastTestedAt",
    "owner",
    "state",
    "target",
  ]);
  // @ts-expect-error credentialId is not part of the redacted projection
  assertEquals(out.credentialId, undefined);
});

Deno.test("redact is a pick: an undeclared extra property does not survive", () => {
  const out = redact({ ...FULL, extra: "leak" } as Connection) as Record<string, unknown>;
  assertEquals(out.extra, undefined);
  assertFalse("extra" in out);
});

Deno.test("redact of a minimal Connection has only its present keys", () => {
  const min: Connection = {
    manifestVersion: "1",
    id: "c",
    app: "io.w6w.x",
    auth: "k",
    owner: "u",
    state: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const out: RedactedConnection = redact(min);
  assertEquals(Object.keys(out).sort(), ["app", "auth", "createdAt", "id", "owner", "state"]);
});

Deno.test("test/afterConnect inputs: binding and credentialDisplay are optional, display is string-valued", () => {
  type In = Parameters<AfterConnectHook>[0];
  const bare: In = { credential: null };
  const full: In = {
    credential: null,
    binding: { delegatedUser: "u@x.test" },
    credentialDisplay: { client_email: "sa@p.iam" },
  };
  // @ts-expect-error credentialDisplay values are strings
  const bad: In = { credential: null, credentialDisplay: { n: 1 } };
  type TestIn = Parameters<AuthDefinition["test"]>[0];
  const t1: TestIn = { credential: null };
  const t2: TestIn = { credential: null, binding: {}, credentialDisplay: { a: "b" } };
  assert(bare && full && bad && t1 && t2);
});

// ---- derivation helpers: auth literals copied from real files in packages/apps/apps ----

const secretField = (key: string, extra: Record<string, unknown> = {}) =>
  ({ key, label: key, type: "secret", required: true, ...extra }) as Param;

// apps/deepseek/auth/api-key.ts — bearer, one secret field `apiKey`.
const deepseekBearer: Pick<Auth, "type" | "fields"> = {
  type: "bearer",
  fields: [secretField("apiKey")],
};
// apps/chatwork/auth/api-token.ts — apiKey, the sole secret field is `apiToken` (not `apiKey`).
const chatworkApiKey: Pick<Auth, "type" | "fields"> = {
  type: "apiKey",
  fields: [secretField("apiToken")],
};
// apps/booqable/auth/access-token.ts — bearer with an extra `companySlug` string field.
const booqableBearer: Pick<Auth, "type" | "fields"> = {
  type: "bearer",
  fields: [
    { key: "companySlug", label: "Company slug", type: "string", required: true },
    secretField("accessToken"),
  ],
};
// apps/browserless/auth/api-token.ts — apiKey with `token` + `region`.
const browserlessApiKey: Pick<Auth, "type" | "fields"> = {
  type: "apiKey",
  fields: [
    secretField("token"),
    { key: "region", label: "Region", type: "string" },
  ],
};
// apps/aircall/auth/basic.ts — basic, two secret fields, NO credentialRole.
const aircallBasic: Pick<Auth, "type" | "fields"> = {
  type: "basic",
  fields: [secretField("apiId", { row: "creds" }), secretField("apiToken", { row: "creds" })],
};
// Same aircall shape once the apps node tags it (roles are the only difference).
const aircallTagged: Pick<Auth, "type" | "fields"> = {
  type: "basic",
  fields: [
    secretField("apiId", { row: "creds", credentialRole: "username" }),
    secretField("apiToken", { row: "creds", credentialRole: "password" }),
  ],
};
// apps/google/google-sheets/auth/service-account.ts
const sheetsServiceAccount: Pick<Auth, "type" | "fields" | "serviceAccount"> = {
  type: "serviceAccount",
  fields: [secretField("serviceAccountKey", { type: "json", secret: true })],
  serviceAccount: {
    accepts: ["google-service-account.v1"],
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    impersonation: "optional",
  } as Auth["serviceAccount"],
};
// apps/acuityscheduling/auth/oauth2.ts — oauth2.
const acuityOauth: Pick<Auth, "type" | "fields"> = { type: "oauth2" };

Deno.test("genericContractFor: 1:1 type compatibility from real auth shapes", () => {
  assertEquals(genericContractFor(deepseekBearer), "bearer.v1");
  assertEquals(genericContractFor(chatworkApiKey), "api-key.v1");
  assertEquals(genericContractFor(booqableBearer), null);
  assertEquals(genericContractFor(browserlessApiKey), null);
  assertEquals(genericContractFor(aircallBasic), null);
  assertEquals(genericContractFor(aircallTagged), "basic.v1");
  assertEquals(genericContractFor(sheetsServiceAccount), null);
  assertEquals(genericContractFor(acuityOauth), null);
  // fields absent / empty, non-secret sole field, one role only
  assertEquals(genericContractFor({ type: "bearer" }), null);
  assertEquals(genericContractFor({ type: "bearer", fields: [] }), null);
  assertEquals(
    genericContractFor({ type: "apiKey", fields: [{ key: "k", label: "k", type: "string" }] }),
    null,
  );
  assertEquals(
    genericContractFor({
      type: "apiKey",
      fields: [{ key: "k", label: "k", type: "string", secret: true }],
    }),
    "api-key.v1",
  );
  assertEquals(
    genericContractFor({
      type: "basic",
      fields: [
        secretField("a", { credentialRole: "username" }),
        secretField("b", { credentialRole: "username" }),
      ],
    }),
    null,
  );
  // Same secret fields on a non-basic type never become basic.v1.
  assertEquals(genericContractFor({ ...aircallTagged, type: "bearer" }), null);
  assertEquals(genericContractFor({ type: "custom", fields: [secretField("x")] }), null);
});

Deno.test("acceptedContractsFor: serviceAccount accepts, generic, or nothing", () => {
  assertEquals(acceptedContractsFor(sheetsServiceAccount), ["google-service-account.v1"]);
  assertEquals(acceptedContractsFor(deepseekBearer), ["bearer.v1"]);
  assertEquals(acceptedContractsFor(chatworkApiKey), ["api-key.v1"]);
  assertEquals(acceptedContractsFor(aircallTagged), ["basic.v1"]);
  assertEquals(acceptedContractsFor(booqableBearer), []);
  assertEquals(acceptedContractsFor(aircallBasic), []);
  assertEquals(acceptedContractsFor(acuityOauth), []);
  // returns a copy, not the auth's own array
  const out = acceptedContractsFor(sheetsServiceAccount);
  out.push("x");
  assertEquals(sheetsServiceAccount.serviceAccount!.accepts, ["google-service-account.v1"]);
});

Deno.test("mapGenericSource: the auth's OWN field key receives the secret", () => {
  assertEquals(mapGenericSource(deepseekBearer, "bearer.v1", { token: "T1" }), { apiKey: "T1" });
  assertEquals(mapGenericSource(chatworkApiKey, "api-key.v1", { key: "K1" }), { apiToken: "K1" });
  assertEquals(
    mapGenericSource(aircallTagged, "basic.v1", { username: "U1", password: "P1" }),
    { apiId: "U1", apiToken: "P1" },
  );
  // role order in the fields array does not matter
  assertEquals(
    mapGenericSource(
      { type: "basic", fields: [...aircallTagged.fields!].reverse() },
      "basic.v1",
      { username: "U1", password: "P1" },
    ),
    { apiId: "U1", apiToken: "P1" },
  );
});

Deno.test("mapGenericSource: null on contract mismatch, incompatible auth, or bad source", () => {
  assertEquals(mapGenericSource(deepseekBearer, "api-key.v1", { key: "K" }), null);
  assertEquals(mapGenericSource(chatworkApiKey, "bearer.v1", { token: "T" }), null);
  assertEquals(mapGenericSource(deepseekBearer, "google-service-account.v1", {}), null);
  assertEquals(mapGenericSource(booqableBearer, "bearer.v1", { token: "T" }), null);
  assertEquals(mapGenericSource(aircallBasic, "basic.v1", { username: "u", password: "p" }), null);
  assertEquals(mapGenericSource(deepseekBearer, "bearer.v1", { key: "T" }), null);
  assertEquals(mapGenericSource(deepseekBearer, "bearer.v1", { token: 5 }), null);
  assertEquals(mapGenericSource(deepseekBearer, "bearer.v1", null), null);
  assertEquals(mapGenericSource(aircallTagged, "basic.v1", { username: "u" }), null);
  assertEquals(STATIC_CREDENTIAL_CONTRACTS, {
    bearer: "bearer.v1",
    apiKey: "api-key.v1",
    basic: "basic.v1",
  });
});

// apps/gocanvas/auth/basic.ts — basic, two secret fields keyed `username`/`password`, NO roles.
// The names alone must never decide: a name heuristic would map a secret into a username slot (R-2).
const gocanvasBasic: Pick<Auth, "type" | "fields"> = {
  type: "basic",
  fields: [
    secretField("username", { row: "creds" }),
    secretField("password", { row: "creds" }),
  ],
};
// apps/wordpress/auth/basic.ts — siteUrl + username + password (3 fields), here with both roles.
const wordpressBasicTagged: Pick<Auth, "type" | "fields"> = {
  type: "basic",
  fields: [
    { key: "siteUrl", label: "WordPress Site URL", type: "string", required: true },
    {
      key: "username",
      label: "Username",
      type: "string",
      required: true,
      credentialRole: "username",
    },
    secretField("password", { credentialRole: "password" }),
  ],
};

Deno.test("untagged basic with username/password KEYS is not basic.v1 (no name heuristic)", () => {
  assertEquals(genericContractFor(gocanvasBasic), null);
  assertEquals(acceptedContractsFor(gocanvasBasic), []);
  assertEquals(mapGenericSource(gocanvasBasic, "basic.v1", { username: "u", password: "p" }), null);
});

Deno.test("basic.v1 needs exactly 2 fields: wordpress shape with both roles is refused", () => {
  assertEquals(wordpressBasicTagged.fields!.length, 3);
  // Same three fields with the roled pair first: a "at least 2" check would pass this one.
  const reordered = {
    type: "basic" as const,
    fields: [...wordpressBasicTagged.fields!.slice(1), wordpressBasicTagged.fields![0]],
  };
  assertEquals(genericContractFor(reordered), null);
  assertEquals(genericContractFor(wordpressBasicTagged), null);
  assertEquals(acceptedContractsFor(wordpressBasicTagged), []);
  assertEquals(
    mapGenericSource(wordpressBasicTagged, "basic.v1", { username: "u", password: "p" }),
    null,
  );
});

// apps/atlassian/bitbucket/auth/basic.ts — basic, `username` string + `password` secret, NO roles.
// The shape reads like username/password, but without the explicit role marker nothing maps (R-2).
const bitbucketBasic: Pick<Auth, "type" | "fields"> = {
  type: "basic",
  fields: [
    { key: "username", label: "Username", type: "string", required: true },
    { key: "password", label: "App password", type: "secret", required: true },
  ],
};

Deno.test("untagged (string username, secret password) basic is not basic.v1 (R-20a)", () => {
  assertEquals(genericContractFor(bitbucketBasic), null);
  assertEquals(acceptedContractsFor(bitbucketBasic), []);
  assertEquals(
    mapGenericSource(bitbucketBasic, "basic.v1", { username: "u", password: "p" }),
    null,
  );
});

// Roles contradict the key names: the mapping must follow the roles, never the names (R-20c).
const crossedBasic: Pick<Auth, "type" | "fields"> = {
  type: "basic",
  fields: [
    secretField("username", { credentialRole: "password" }),
    secretField("password", { credentialRole: "username" }),
  ],
};

Deno.test("crossed credentialRole fixture maps by role, not by key name (R-20c)", () => {
  assertEquals(genericContractFor(crossedBasic), "basic.v1");
  assertEquals(
    mapGenericSource(crossedBasic, "basic.v1", { username: "U", password: "P" }),
    { password: "U", username: "P" },
  );
});
