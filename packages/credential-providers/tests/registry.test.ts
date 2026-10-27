import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import type { CredentialProvider } from "@w6w/types";
import * as mod from "../mod.ts";
import {
  createCredentialProviderRegistry,
  defaultCredentialProviders,
  googleServiceAccountV1,
} from "../mod.ts";

const reg = createCredentialProviderRegistry([googleServiceAccountV1]);

Deno.test("registry: exact id returns the provider", () => {
  assertEquals(reg.get("google-service-account.v1"), googleServiceAccountV1);
});

Deno.test("registry: near-misses, legacy ids and Object.prototype names -> undefined", () => {
  for (
    const id of [
      "Google-Service-Account.v1",
      " google-service-account.v1",
      "google-service-account.v1 ",
      "google-service-account.v2",
      "legacy:io.w6w.gmail#service-account",
      "__proto__",
      "toString",
      "constructor",
      "",
    ]
  ) assertEquals(reg.get(id), undefined, id);
});

Deno.test("registry: duplicate contract and malformed id throw at construction", () => {
  assertThrows(() =>
    createCredentialProviderRegistry([googleServiceAccountV1, googleServiceAccountV1])
  );
  for (const contract of ["Bad.v1", "no-version", "legacy:a#b", "a.v", "__proto__"]) {
    const bad: CredentialProvider = { ...googleServiceAccountV1, contract };
    assertThrows(() => createCredentialProviderRegistry([bad]), Error, undefined, contract);
  }
});

Deno.test("registry: contracts() is a fresh array; the registry is frozen", () => {
  const a = reg.contracts();
  assertEquals(a, ["google-service-account.v1"]);
  a.push("x");
  a.length = 0;
  assertEquals(reg.contracts(), ["google-service-account.v1"]);
  assert(Object.isFrozen(reg));
});

Deno.test("defaultCredentialProviders: deep-equals [googleServiceAccountV1], fresh each call", () => {
  const a = defaultCredentialProviders();
  assertEquals(a, [googleServiceAccountV1]);
  assert(a !== defaultCredentialProviders());
  a.pop();
  assertEquals(defaultCredentialProviders().length, 1);
});

Deno.test("mod.ts exports every BRIEFS I-3 runtime name", () => {
  for (
    const k of [
      "googleServiceAccountV1",
      "GOOGLE_TOKEN_ENDPOINT",
      "normaliseLegacyGoogleServiceAccount",
      "createCredentialProviderRegistry",
      "defaultCredentialProviders",
    ]
  ) assert(k in mod, k);
});
