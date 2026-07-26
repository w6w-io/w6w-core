/**
 * Egress allowlist matching (`w6w.network.allow`).
 *
 * Exact hostnames are the default. The wildcard forms exist for APIs addressed
 * by a per-tenant host that a static manifest cannot enumerate.
 */
import { assert, assertFalse } from "jsr:@std/assert@^1.0.0";
import { hostAllowed } from "../src/runtime.ts";

Deno.test("allowlist: exact hostnames match, and only themselves", () => {
  const allow = ["api.sendgrid.com", "127.0.0.1"];
  assert(hostAllowed(allow, "api.sendgrid.com"));
  assert(hostAllowed(allow, "127.0.0.1"));
  assertFalse(hostAllowed(allow, "sendgrid.com"));
  assertFalse(hostAllowed(allow, "evil.api.sendgrid.com"));
  assertFalse(hostAllowed(allow, "api.sendgrid.com.evil.test"));
});

Deno.test("allowlist: `*.domain` matches subdomains at any depth, not the apex", () => {
  const allow = ["*.zendesk.com"];
  assert(hostAllowed(allow, "acme.zendesk.com"));
  assert(hostAllowed(allow, "eu.acme.zendesk.com"));
  // The apex is a different host — list it explicitly if the app calls it.
  assertFalse(hostAllowed(allow, "zendesk.com"));
  // Suffix matching must be label-aware: `notzendesk.com` must not slip through.
  assertFalse(hostAllowed(allow, "notzendesk.com"));
  assertFalse(hostAllowed(allow, "zendesk.com.evil.test"));
});

Deno.test("allowlist: `*` opts out of egress restriction entirely", () => {
  assert(hostAllowed(["*"], "anything.example.test"));
  assert(hostAllowed(["*"], "127.0.0.1"));
});

Deno.test("allowlist: an empty allowlist denies everything", () => {
  assertFalse(hostAllowed([], "api.sendgrid.com"));
});

Deno.test("allowlist: entries are matched case-insensitively", () => {
  assert(hostAllowed(["API.Sendgrid.com"], "api.sendgrid.com"));
  assert(hostAllowed(["*.Zendesk.COM"], "acme.zendesk.com"));
});
