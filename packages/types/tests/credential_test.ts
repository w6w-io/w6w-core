import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1.0.0";
import {
  AUTH_TYPES,
  type AuthType,
  type Connection,
  CREDENTIAL_CONTRACT_ID_RE,
  CREDENTIAL_ERROR_CODES,
  type CredentialRecord,
  isLegacyContractId,
  legacyContractId,
  redact,
  type RedactedConnection,
  type ResolvedAuthorization,
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

Deno.test("CREDENTIAL_ERROR_CODES are exactly the nine resolution-time codes, in order", () => {
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
  ]);
  assertEquals(CREDENTIAL_ERROR_CODES.length, 9);
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
