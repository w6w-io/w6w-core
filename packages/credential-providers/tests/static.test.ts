import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import { W6WError } from "@w6w/runtime";
import type { CredentialProvider } from "@w6w/types";
import { apiKeyV1, basicV1, bearerV1, defaultCredentialProviders } from "../mod.ts";

const SECRET = "Zq9xK2mWvT7pLrN4sHb8";

/** True when any 4-character window of `secret` appears in `text`. */
function leaks(text: string, secret: string): boolean {
  for (let i = 0; i + 4 <= secret.length; i++) {
    if (text.includes(secret.slice(i, i + 4))) return true;
  }
  return false;
}

Deno.test("static providers: kind, capabilities, descriptors, no deriveAuthorization", () => {
  const [, b, k, u] = defaultCredentialProviders();
  assertEquals([b, k, u], [bearerV1, apiKeyV1, basicV1]);
  for (const p of [bearerV1, apiKeyV1, basicV1]) {
    assertEquals(p.kind, "static");
    assertEquals(p.capabilities, {
      handoffable: true,
      crossConnectionTokenReuse: false,
      delegation: false,
    });
    assertEquals("deriveAuthorization" in p, false);
  }
  assertEquals(bearerV1.descriptor, {
    label: "Bearer token",
    fields: [{ key: "token", label: "Token", secret: true }],
  });
  assertEquals(apiKeyV1.descriptor, {
    label: "API key",
    fields: [{ key: "key", label: "API key", secret: true }],
  });
  assertEquals(basicV1.descriptor, {
    label: "Username and password",
    fields: [
      { key: "username", label: "Username", secret: false },
      { key: "password", label: "Password", secret: true },
    ],
  });
});

Deno.test("static validateSource: exact keys, trimmed, returns the trimmed object", () => {
  assertEquals(bearerV1.validateSource({ token: `  ${SECRET} ` }), { token: SECRET });
  assertEquals(apiKeyV1.validateSource({ key: SECRET }), { key: SECRET });
  assertEquals(basicV1.validateSource({ username: " bob ", password: SECRET }), {
    username: "bob",
    password: SECRET,
  });
});

Deno.test("static validateSource: refusals, with no secret in any message or detail", () => {
  const bad: Array<[typeof bearerV1, unknown]> = [
    [bearerV1, null],
    [bearerV1, [SECRET]],
    [bearerV1, SECRET],
    [bearerV1, {}],
    [bearerV1, { token: SECRET, extra: SECRET }],
    [bearerV1, { key: SECRET }],
    [bearerV1, { token: 123 }],
    [bearerV1, { token: [SECRET] }],
    [bearerV1, { token: { v: SECRET } }],
    [apiKeyV1, { key: [SECRET, SECRET] }],
    [basicV1, { username: "bob", password: { v: SECRET } }],
    [basicV1, { username: { v: SECRET }, password: "x" }],
    [bearerV1, { token: "   " }],
    [bearerV1, { token: `${SECRET}\n` }],
    [bearerV1, { token: `a\rb${SECRET}` }],
    [bearerV1, { token: `${SECRET}\0` }],
    [apiKeyV1, { key: "" }],
    [apiKeyV1, { key: SECRET, token: SECRET }],
    [basicV1, { username: "bob" }],
    [basicV1, { username: "a\nb", password: "x" }],
    [basicV1, { username: "a\rb", password: "x" }],
    [basicV1, { username: "a\0b", password: "x" }],
    [basicV1, { username: "a\nb", password: SECRET }],
    [basicV1, { username: `bo:b${SECRET}`, password: SECRET }],
    [basicV1, { username: "bob", password: `${SECRET}\n` }],
    [basicV1, { username: "bob", password: "", x: SECRET }],
  ];
  for (const [p, input] of bad) {
    let err: unknown;
    try {
      p.validateSource(input);
    } catch (e) {
      err = e;
    }
    assert(err instanceof W6WError, JSON.stringify(input));
    const text = `${err.message} ${JSON.stringify((err as W6WError).details ?? {})}`;
    assert(!leaks(text, SECRET), `leak for ${JSON.stringify(input)}`);
  }
  // A colon is fine in a password, never in a username (RFC 7617).
  assertEquals(basicV1.validateSource({ username: "bob", password: "a:b" }), {
    username: "bob",
    password: "a:b",
  });
  assertThrows(() => basicV1.validateSource({ username: "a:b", password: "x" }), W6WError);
});

Deno.test("static displayOf: never carries a secret, any 4-char slice included", () => {
  assertEquals(bearerV1.displayOf({ token: SECRET }), {});
  assertEquals(apiKeyV1.displayOf({ key: SECRET }), {});
  const d = basicV1.displayOf({ username: "bob", password: SECRET });
  assertEquals(d, { username: "bob" });
  for (const p of [bearerV1, apiKeyV1, basicV1]) {
    const out = p.displayOf({ token: SECRET, key: SECRET, password: SECRET, username: "bob" });
    assert(!leaks(JSON.stringify(out), SECRET));
  }
  assertEquals(bearerV1.displayOf(null), {});
});

Deno.test("static providers: a deriveAuthorization on a static provider fails the type check", () => {
  const bad: CredentialProvider = {
    ...bearerV1,
    kind: "static",
    // @ts-expect-error the static arm declares deriveAuthorization?: never
    deriveAuthorization: () => Promise.resolve({}),
  };
  assert(bad);
});
