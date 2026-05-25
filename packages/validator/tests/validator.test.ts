import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { validateAction, validateApp, validateAuth } from "../mod.ts";
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

Deno.test("validateAuth checks apiKey config", () => {
  const ok = validateAuth({
    key: "api-key",
    type: "apiKey",
    displayName: "API Key",
    apiKey: { in: "header", name: "Authorization" },
  });
  assert(ok.ok, JSON.stringify(ok.errors));
});
