/**
 * `runAuthHook`'s `exchange` (the connect form's fields in, the credential to store out) and the
 * re-auth signal crossing the sandbox boundary (rfcs/auth.md "Failure policy"): a hook error whose
 * `code` is `reauth_required` becomes `W6WError("reauth_required")`; every other error stays
 * `hook_failed`, its code kept only in the well-formed code shape.
 */
import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { REAUTH_REQUIRED, ReauthRequiredError } from "@w6w/types";
import { loadApp, runAuthHook, W6WError } from "../mod.ts";

const DIR = fromFileUrl(new URL("../../../fixtures/apps/session-login", import.meta.url));

async function session() {
  const app = await loadApp(DIR);
  return { app, auth: app.auths[0] };
}

async function refreshFailure(refreshToken: string): Promise<W6WError> {
  const { app, auth } = await session();
  return await assertRejects(
    () => runAuthHook(app, auth, "refresh", { token: "t", refreshToken }),
    W6WError,
  );
}

Deno.test("exchange receives the form's fields and returns the credential to store", async () => {
  const { app, auth } = await session();
  const out = await runAuthHook(app, auth, "exchange", { email: "a@b.example", password: "pw" });
  assertEquals(out, { token: "tok-a@b.example", refreshToken: "r1" });
});

Deno.test("an exchange failure keeps the hook's code, and only the code, in details", async () => {
  const { app, auth } = await session();
  const e = await assertRejects(
    () => runAuthHook(app, auth, "exchange", { email: "a@b.example", password: "wrong" }),
    W6WError,
  );
  assertEquals(e.code, "hook_failed");
  assertEquals((e.details as { code?: string }).code, "invalid_credentials");
});

Deno.test("refresh throwing ReauthRequiredError → W6WError reauth_required with the reason", async () => {
  const e = await refreshFailure("reused");
  assertEquals(e.code, REAUTH_REQUIRED);
  assertEquals(e.phase, "auth");
  assertEquals((e.details as { reason?: string }).reason, "refresh_token_reused");
});

Deno.test("a plain Error with code reauth_required is the same signal (no import needed)", async () => {
  const e = await refreshFailure("revoked-plain");
  assertEquals(e.code, REAUTH_REQUIRED);
  assertEquals((e.details as { reason?: string }).reason, "org_access_revoked");
});

Deno.test("a reason that is not a code is dropped at the boundary; the signal still holds", async () => {
  const e = await refreshFailure("bad-reason");
  assertEquals(e.code, REAUTH_REQUIRED);
  assertEquals((e.details as { reason?: string }).reason, undefined);
});

Deno.test("a code that is not a code is dropped: a plain hook_failed", async () => {
  const e = await refreshFailure("bad-code");
  assertEquals(e.code, "hook_failed");
  assertEquals((e.details as { code?: string }).code, undefined);
});

Deno.test("an uncoded refresh failure is hook_failed (transient)", async () => {
  const e = await refreshFailure("flaky");
  assertEquals(e.code, "hook_failed");
  assertEquals((e.details as { code?: string }).code, undefined);
});

Deno.test("revoke runs (returns nothing)", async () => {
  const { app, auth } = await session();
  assertEquals(
    await runAuthHook(app, auth, "revoke", { token: "t", refreshToken: "r" }),
    undefined,
  );
});

Deno.test("ReauthRequiredError carries the code and the reason", () => {
  const e = new ReauthRequiredError("account_disabled");
  assertEquals(e.code, "reauth_required");
  assertEquals(e.reason, "account_disabled");
  assertEquals(new ReauthRequiredError().reason, undefined);
});
