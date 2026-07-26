import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
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
