import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.0";
import {
  authorizationCacheKey,
  type AuthorizationCacheKeyInput,
  credentialError,
  isExpiring,
  normalizeScopes,
  TOKEN_SKEW_MS,
  W6WError,
} from "../mod.ts";

const BASE: AuthorizationCacheKeyInput = {
  tenant: "t1",
  account: "acct",
  credentialId: "cred_1",
  revision: 1,
  providerVersion: "v1",
  bindingRevision: 1,
  scopes: ["b", "a"],
  delegatedUser: null,
  audience: null,
};

Deno.test("normalizeScopes trims, drops empties, dedupes and sorts (R-3)", () => {
  assertEquals(normalizeScopes([" b ", "a", "", "b"]), ["a", "b"]);
  assertEquals(normalizeScopes([]), []);
  assertEquals(normalizeScopes(["  ", ""]), []);
  // Sorted by code unit, not declared order.
  assertEquals(normalizeScopes(["z", "B", "a"]), ["B", "a", "z"]);
});

Deno.test("normalizeScopes never splits an entry on inner whitespace", () => {
  assertEquals(normalizeScopes(["a b", " c "]), ["a b", "c"]);
});

Deno.test("normalizeScopes does not mutate its input", () => {
  const input = ["b", "a"];
  normalizeScopes(input);
  assertEquals(input, ["b", "a"]);
});

// One assertion per field: dropping any one field from the encoding turns
// exactly its own case red.
const FIELD_CHANGES: Array<
  [keyof AuthorizationCacheKeyInput, Partial<AuthorizationCacheKeyInput>]
> = [
  ["tenant", { tenant: "t2" }],
  ["account", { account: "acct2" }],
  ["credentialId", { credentialId: "cred_2" }],
  ["revision", { revision: 2 }],
  ["providerVersion", { providerVersion: "v2" }],
  ["bindingRevision", { bindingRevision: 2 }],
  ["scopes", { scopes: ["a", "b", "c"] }],
  ["delegatedUser", { delegatedUser: "u@example.com" }],
  ["audience", { audience: "https://aud.example" }],
];

for (const [field, change] of FIELD_CHANGES) {
  Deno.test(`authorizationCacheKey changes when ${field} changes`, () => {
    assertNotEquals(authorizationCacheKey({ ...BASE, ...change }), authorizationCacheKey(BASE));
  });
}

Deno.test("authorizationCacheKey: null and a value differ for the nullable fields", () => {
  assertNotEquals(
    authorizationCacheKey({ ...BASE, delegatedUser: "" }),
    authorizationCacheKey({ ...BASE, delegatedUser: null }),
  );
  assertNotEquals(
    authorizationCacheKey({ ...BASE, audience: "" }),
    authorizationCacheKey({ ...BASE, audience: null }),
  );
});

Deno.test("authorizationCacheKey ignores scope order, duplicates and padding", () => {
  const k = authorizationCacheKey(BASE);
  assertEquals(authorizationCacheKey({ ...BASE, scopes: ["a", "b"] }), k);
  assertEquals(authorizationCacheKey({ ...BASE, scopes: ["a", "b", "a", " b "] }), k);
});

Deno.test("authorizationCacheKey: a delimiter-collision pair yields different keys", () => {
  const a = authorizationCacheKey({ ...BASE, tenant: "a|b", account: "c" });
  const b = authorizationCacheKey({ ...BASE, tenant: "a", account: "b|c" });
  assertNotEquals(a, b);
  // Same for the other common delimiters.
  for (const d of [":", ",", "\n", "\0", '"']) {
    assertNotEquals(
      authorizationCacheKey({ ...BASE, tenant: `a${d}b`, account: "c" }),
      authorizationCacheKey({ ...BASE, tenant: "a", account: `b${d}c` }),
      `delimiter ${JSON.stringify(d)}`,
    );
  }
});

Deno.test("TOKEN_SKEW_MS is 60s", () => {
  assertEquals(TOKEN_SKEW_MS, 60_000);
});

Deno.test("isExpiring is true exactly at expiresAt - skew === now, false 1 ms earlier", () => {
  const expiresAt = 1_000_000;
  const edge = expiresAt - TOKEN_SKEW_MS;
  assert(isExpiring(expiresAt, edge), "true exactly at the boundary");
  assert(isExpiring(expiresAt, edge + 1), "true after it");
  assert(!isExpiring(expiresAt, edge - 1), "false 1 ms before");
  // Explicit skew.
  assert(isExpiring(1000, 900, 100));
  assert(!isExpiring(1000, 899, 100));
  // Default `now` is the clock.
  assert(isExpiring(Date.now() - 1));
  assert(!isExpiring(Date.now() + 10 * TOKEN_SKEW_MS));
});

Deno.test("credentialError yields a W6WError in phase auth with the given code", () => {
  const e = credentialError("credential_revoked", "gone", { id: "c" });
  assert(e instanceof W6WError);
  assertEquals([e.code, e.phase, e.message, e.details], ["credential_revoked", "auth", "gone", {
    id: "c",
  }]);
});
