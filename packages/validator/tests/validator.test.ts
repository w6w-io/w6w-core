import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1.0.0";
import {
  CATEGORIES,
  unknownCategories,
  validateAction,
  validateApp,
  validateAuth,
  validateHealthCheck,
} from "../mod.ts";
import type { AppManifest } from "@w6w/types";

const VALID_APP: AppManifest = {
  manifestVersion: "1",
  id: "com.acme.slack",
  name: "slack",
  displayName: "Slack",
  version: "1.4.2",
  description: "Send messages in Slack.",
  categories: ["communication"],
  appearance: { icon: { svg: "./icon.svg" } },
  author: { name: "Acme" },
  license: "MIT",
};

function codes(r: { errors: { path: string }[] }): string[] {
  return r.errors.map((e) => e.path).sort();
}

Deno.test("validateApp accepts a valid manifest", () => {
  const r = validateApp(VALID_APP);
  assert(r.ok, JSON.stringify(r.errors));
});

Deno.test("validateApp flags a non-reverse-DNS id", () => {
  const r = validateApp({ ...VALID_APP, id: "slack" });
  assertEquals(r.ok, false);
  assert(codes(r).includes("id"));
});

Deno.test("validateApp flags missing required fields", () => {
  const r = validateApp({ manifestVersion: "1" });
  assertEquals(r.ok, false);
  for (const p of ["id", "name", "displayName", "version", "description", "categories"]) {
    assert(codes(r).includes(p), `expected error at ${p}`);
  }
});

Deno.test("validateApp flags too many categories", () => {
  const r = validateApp({ ...VALID_APP, categories: ["a", "b", "c", "d"] });
  assert(codes(r).includes("categories"));
});

Deno.test("validateAction checks key/type/title", () => {
  assert(validateAction({ key: "send-message", type: "perform", title: "Send" }).ok);
  const bad = validateAction({ key: "Send Message", type: "nope", title: "" });
  assertEquals(bad.ok, false);
  assert(codes(bad).includes("action.key"));
  assert(codes(bad).includes("action.type"));
});

Deno.test("validateAuth requires oauth2 endpoints", () => {
  const r = validateAuth({ key: "oauth", type: "oauth2", displayName: "OAuth" });
  assertEquals(r.ok, false);
  assert(codes(r).includes("auth.oauth2"));

  const ok = validateAuth({
    key: "oauth",
    type: "oauth2",
    displayName: "OAuth",
    oauth2: { authorizationUrl: "https://x.test/a", tokenUrl: "https://x.test/t" },
  });
  assert(ok.ok, JSON.stringify(ok.errors));
});

Deno.test("validateAuth checks the display-only oauth2.setup block", () => {
  const P = "auth.oauth2.setup";
  const run = (setup: unknown) =>
    validateAuth({
      key: "oauth",
      type: "oauth2",
      displayName: "OAuth",
      oauth2: { authorizationUrl: "https://x.test/a", tokenUrl: "https://x.test/t", setup },
    }).errors.map((e) => e.path).sort();

  // Well-formed, partial, empty-string hint, unknown keys and absent all pass.
  assertEquals(run(undefined), []);
  assertEquals(
    run({
      consoleUrl: "https://v.test/apps",
      instructions: "i",
      clientIdHint: "c",
      clientSecretHint: "s",
      redirectUriHint: "r",
      extraHint: "e",
      extraTemplate: { a: [1] },
      future: 1,
    }),
    [],
  );
  assertEquals(run({ instructions: "only" }), []);
  assertEquals(run({ clientIdHint: "" }), []);

  // A non-object block reports only its own path.
  for (const bad of [null, [], "x", 42]) assertEquals(run(bad), [P]);

  for (const consoleUrl of ["http://v.test/apps", "javascript:alert(1)", "/apps", 42]) {
    assertEquals(run({ consoleUrl }), [`${P}.consoleUrl`]);
  }
  for (
    const k of ["instructions", "clientIdHint", "clientSecretHint", "redirectUriHint", "extraHint"]
  ) {
    assertEquals(run({ [k]: 42 }), [`${P}.${k}`]);
  }
  for (const extraTemplate of [[], null, "{}"]) {
    assertEquals(run({ extraTemplate }), [`${P}.extraTemplate`]);
  }
});

Deno.test("CATEGORIES vocabulary contains expected slugs", () => {
  for (const c of ["communication", "developer-tools", "ai", "other"]) {
    assert(CATEGORIES.includes(c), `expected ${c} in CATEGORIES`);
  }
});

Deno.test("unknownCategories returns out-of-vocabulary entries (validator stays loose)", () => {
  const r = validateApp({ ...VALID_APP, categories: ["communication", "made-up-thing"] });
  assert(r.ok, "validator accepts unknown categories");
  assertEquals(
    unknownCategories({ ...VALID_APP, categories: ["communication", "made-up-thing"] }),
    [
      "made-up-thing",
    ],
  );
});

Deno.test("validateAuth checks apiKey config", () => {
  const ok = validateAuth({
    key: "api-key",
    type: "apiKey",
    displayName: "API Key",
    apiKey: { in: "header", name: "Authorization" },
  });
  assert(ok.ok, JSON.stringify(ok.errors));
});

// --- health checks (rfcs/healthcheck.md) ------------------------------------

Deno.test("validateHealthCheck accepts a service check that widens its egress", () => {
  const r = validateHealthCheck({
    key: "service",
    title: "Platform status",
    kind: "service",
    network: { allow: ["status.example.com"] },
  });
  assert(r.ok, JSON.stringify(r.errors));
});

Deno.test("validateHealthCheck REJECTS a signed check that widens its egress", () => {
  // The security rule: a signed request to a host outside the app allowlist
  // would hand a third party the user's credential.
  const r = validateHealthCheck({
    key: "smuggler",
    title: "Exfiltration attempt",
    kind: "quota",
    credential: "signed",
    network: { allow: ["collector.example.com"] },
  });
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.path.endsWith("network.allow")));
});

Deno.test("validateHealthCheck applies the rule to the DEFAULTED posture too", () => {
  // `kind: "quota"` defaults to `signed`, so omitting `credential` must not be
  // a way around the rule.
  const r = validateHealthCheck({
    key: "sneaky",
    title: "Sneaky",
    kind: "quota",
    network: { allow: ["collector.example.com"] },
  });
  assertEquals(r.ok, false);
});

Deno.test("validateHealthCheck reserves the `auth:` key prefix for derived checks", () => {
  const r = validateHealthCheck({ key: "auth:api-key", title: "X", kind: "credential" });
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.message.includes("reserved")));
});

Deno.test("validateHealthCheck requires exactly one of `check` and `unavailable`", () => {
  const both = validateHealthCheck({
    key: "x",
    title: "X",
    kind: "service",
    unavailable: { reason: "none published" },
    check: () => ({ state: "ok" }),
  });
  assertEquals(both.ok, false);

  const unavailableOnly = validateHealthCheck({
    key: "x",
    title: "X",
    kind: "service",
    unavailable: { reason: "none published" },
  });
  assert(unavailableOnly.ok, JSON.stringify(unavailableOnly.errors));
});

Deno.test("validateHealthCheck constrains covers selectors", () => {
  assert(
    validateHealthCheck({
      key: "x",
      title: "X",
      kind: "service",
      covers: ["*", "action:send", "resource:mail", "auth:api-key", "component:api"],
    }).ok,
  );
  assertEquals(
    validateHealthCheck({ key: "x", title: "X", kind: "service", covers: ["endpoint:foo"] }).ok,
    false,
  );
});

Deno.test("validateAction rejects a health tag on a non-read action", () => {
  const r = validateAction({
    key: "send",
    type: "perform",
    title: "Send",
    healthCheck: { kind: "dependency" },
  });
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.message.includes("only valid on a `read` action")));
});

Deno.test("validateAction rejects a health tag when a required param has no default", () => {
  // A tagged action is invoked with `{}`, so a required param with no default
  // makes it unusable as a probe.
  const r = validateAction({
    key: "get-thing",
    type: "read",
    title: "Get thing",
    params: [{ key: "id", label: "ID", type: "string", required: true }],
    healthCheck: { kind: "dependency" },
  });
  assertEquals(r.ok, false);
  assert(r.errors.some((e) => e.message.includes("cannot be used as a health check")));
});

Deno.test("validateAction accepts a health tag when every param is defaulted", () => {
  const r = validateAction({
    key: "limits-get",
    type: "read",
    title: "Get limits",
    params: [{ key: "scope", label: "Scope", type: "string", required: true, default: "org" }],
    healthCheck: { kind: "quota", severity: "informational" },
  });
  assert(r.ok, JSON.stringify(r.errors));
});

// --- feed-backed checks (rfcs/healthcheck.md § "Feed-backed checks") --------

Deno.test("health feed: a well-formed source validates", () => {
  const r = validateHealthCheck({
    key: "service",
    title: "Platform status",
    kind: "service",
    feed: { url: "https://status.example.com/feed.rss", format: "auto", limit: 25 },
  });
  assert(r.ok, JSON.stringify(r.errors));
});

Deno.test("health feed: a signed check may not declare one", () => {
  // The security rule: a feed widens egress to a status host, and a status host
  // is exactly the kind that must never see a credential.
  const r = validateHealthCheck({
    key: "quota",
    title: "Quota",
    kind: "quota", // defaults to `signed`
    feed: { url: "https://status.example.com/feed.rss" },
  });
  assertFalse(r.ok);
  assert(r.errors.some((e) => e.path === "healthCheck.feed"));
});

Deno.test("health feed: an unsigned posture makes it legal again", () => {
  const r = validateHealthCheck({
    key: "quota",
    title: "Quota",
    kind: "quota",
    credential: "none",
    feed: { url: "https://status.example.com/feed.rss" },
  });
  assert(r.ok, JSON.stringify(r.errors));
});

Deno.test("health feed: the url must be an absolute http(s) URL", () => {
  for (const url of ["/feed.rss", "not a url", "ftp://example.com/feed.rss"]) {
    const r = validateHealthCheck({ key: "s", title: "S", kind: "service", feed: { url } });
    assertFalse(r.ok, `expected ${url} to be rejected`);
    assert(r.errors.some((e) => e.path === "healthCheck.feed.url"));
  }
});

Deno.test("health feed: format and limit are constrained", () => {
  const bad = validateHealthCheck({
    key: "s",
    title: "S",
    kind: "service",
    feed: { url: "https://x.test/f", format: "json", limit: 0 },
  });
  assertFalse(bad.ok);
  assert(bad.errors.some((e) => e.path === "healthCheck.feed.format"));
  assert(bad.errors.some((e) => e.path === "healthCheck.feed.limit"));
});

Deno.test("health feed: cannot be combined with `unavailable`", () => {
  // A declared absence has no hook, so there is nothing to hand the entries to.
  const r = validateHealthCheck({
    key: "s",
    title: "S",
    kind: "service",
    unavailable: { reason: "nothing published" },
    feed: { url: "https://x.test/f" },
  });
  assertFalse(r.ok);
  assert(r.errors.some((e) => e.path === "healthCheck.feed"));
});

Deno.test("validateAuth checks optional OAuth token authentication and encoding", () => {
  const auth = {
    key: "oauth",
    type: "oauth2",
    displayName: "OAuth",
    oauth2: {
      authorizationUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenUrl: "https://api.notion.com/v1/oauth/token",
      tokenAuthMethod: "client_secret_basic",
      tokenBodyFormat: "json",
    },
  };
  assertEquals(validateAuth(auth).ok, true);
  assertEquals(
    validateAuth({ ...auth, oauth2: { ...auth.oauth2, tokenAuthMethod: "unsupported" } }).ok,
    false,
  );
  assertEquals(
    validateAuth({ ...auth, oauth2: { ...auth.oauth2, tokenBodyFormat: "xml" } }).ok,
    false,
  );
});

// ── serviceAccount / tenantAuth / jit ────────────────────────────────────────
const SA_AUTH = {
  key: "service-account",
  type: "serviceAccount",
  displayName: "Service account",
  serviceAccount: {
    accepts: ["google-service-account.v1"],
    scopes: ["https://www.googleapis.com/auth/gmail.send"],
    impersonation: "optional",
  },
};
const HOOKS = { hooks: ["test", "sign"] };
const saWith = (patch: Record<string, unknown>) => ({
  ...SA_AUTH,
  serviceAccount: { ...SA_AUTH.serviceAccount, ...patch },
});

Deno.test("validateAuth: a well-formed serviceAccount auth passes in both sign-hook forms", () => {
  const viaList = validateAuth(SA_AUTH, "auth", HOOKS);
  assert(viaList.ok, JSON.stringify(viaList.errors));
  const viaFn = validateAuth({ ...SA_AUTH, sign: () => ({}) });
  assert(viaFn.ok, JSON.stringify(viaFn.errors));
  const withBinding = validateAuth(
    saWith({ bindingFields: [{ key: "delegatedUser", label: "User", type: "string" }] }),
    "auth",
    HOOKS,
  );
  assert(withBinding.ok, JSON.stringify(withBinding.errors));
});

Deno.test("validateAuth: serviceAccount rejections by path", () => {
  const run = (a: unknown, opts = HOOKS) => codes(validateAuth(a, "auth", opts));
  assertEquals(run({ ...SA_AUTH, serviceAccount: undefined }), ["auth.serviceAccount"]);
  assertEquals(run(SA_AUTH, { hooks: ["test"] }), ["auth.sign"]);
  assertEquals(validateAuth(SA_AUTH).errors.map((e) => e.path), ["auth.sign"]);
  assertEquals(run(saWith({ accepts: [] })), ["auth.serviceAccount.accepts"]);
  assertEquals(run(saWith({ accepts: ["Bad.v1"] })), ["auth.serviceAccount.accepts[0]"]);
  assertEquals(run(saWith({ accepts: ["legacy:a#b"] })), ["auth.serviceAccount.accepts[0]"]);
  assertEquals(run(saWith({ scopes: [] })), ["auth.serviceAccount.scopes"]);
  assertEquals(run(saWith({ scopes: [""] })), ["auth.serviceAccount.scopes[0]"]);
  assertEquals(run(saWith({ impersonation: "always" })), ["auth.serviceAccount.impersonation"]);
  assertEquals(
    run(saWith({ bindingFields: [{ key: "k", label: "K", type: "secret" }] })),
    ["auth.serviceAccount.bindingFields[0].type"],
  );
});

Deno.test("validateAuth: serviceAccount keys are an allowlist (no destination can be declared)", () => {
  for (const k of ["tokenUrl", "tokenUri", "endpoint", "audience", "anything"]) {
    assertEquals(
      codes(validateAuth(saWith({ [k]: "https://evil.test/t" }), "auth", HOOKS)),
      [`auth.serviceAccount.${k}`],
      k,
    );
  }
});

Deno.test("validateAuth: tenantAuth and jit auths validate ok", () => {
  for (const type of ["tenantAuth", "jit"]) {
    const r = validateAuth({ key: type, type, displayName: type });
    assert(r.ok, JSON.stringify(r.errors));
  }
});
