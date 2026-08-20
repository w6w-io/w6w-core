/**
 * `runAuthHook` — the one function that runs a credential-bearing Auth
 * lifecycle hook (`test` | `afterConnect` | `refresh` | `revoke`) in the
 * sandbox with host-mediated, allowlist-enforced egress. See DECISIONS.md
 * D-4, D-14 and rfcs/hook-runtime.md "Credential isolation".
 */
import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { loadApp, runAuthHook, W6WError } from "../mod.ts";
import type { CredentialHookKind } from "../mod.ts";

const SENDGRID_DIR = fromFileUrl(new URL("../../../fixtures/apps/sendgrid", import.meta.url));

/** Spins up a one-shot local endpoint that answers with a fixed status. */
function captureServer(status: number) {
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response(null, { status }),
  );
  const port = (server.addr as Deno.NetAddr).port;
  return { server, port };
}

Deno.test("afterConnect returns the hook's value, derived from the credential (not a constant)", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const auth = app.auths[0];

  const a = await runAuthHook<{ label: string }>(app, auth, "afterConnect", {
    apiKey: "key-A",
  });
  const b = await runAuthHook<{ label: string }>(app, auth, "afterConnect", {
    apiKey: "key-B",
  });

  assertEquals(a.label, "SendGrid (key-A)");
  assertEquals(b.label, "SendGrid (key-B)");
  assertNotEquals(a.label, b.label);
});

Deno.test("test returns the hook's { ok, message? } verbatim — one function serves both hooks", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const auth = app.auths[0];

  const result = await runAuthHook<{ ok: boolean }>(app, auth, "test", { apiKey: "key-A" });
  assertEquals(result, { ok: true });
});

Deno.test("a hook's ctx.fetch against an allowed host succeeds and the response is usable", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const auth = app.auths[0];
  const { server, port } = captureServer(201);

  try {
    const result = await runAuthHook<{ label: string; probeStatus: number }>(
      app,
      auth,
      "afterConnect",
      { apiKey: "key-A", probeUrl: `http://127.0.0.1:${port}/` },
    );
    // onFetch was wired: the hook got a real Response and read its status.
    assertEquals(result.probeStatus, 201);
  } finally {
    await server.shutdown();
  }
});

Deno.test("a hook's ctx.fetch against a host off the allowlist is denied with egress_denied", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const auth = app.auths[0];

  const err = await assertRejects(
    () =>
      runAuthHook(app, auth, "afterConnect", {
        apiKey: "key-A",
        probeUrl: "https://evil.example",
      }),
    W6WError,
  );
  assertEquals(err.code, "egress_denied");
});

Deno.test(
  "ROUND 2 REGRESSION: a hook's own thrown error is never reclassified as egress_denied, " +
    "even when its message happens to end with hostFetch's exact wording, when ctx.fetch was " +
    "never called",
  async () => {
    const app = await loadApp(SENDGRID_DIR);
    const auth = app.auths[0];

    const err = await assertRejects(
      () =>
        runAuthHook(app, auth, "afterConnect", {
          apiKey: "key-A",
          // Deliberately ends with hostFetch's exact `egress_denied` wording,
          // but `afterConnect` throws this directly — it never touches
          // ctx.fetch. A string-matching reclassification would misfire on
          // this; the closure-flag mechanism must not.
          throwMessage: `Vendor account "acme" is not in the app's network allowlist.`,
        }),
      W6WError,
    );
    assertNotEquals(err.code, "egress_denied");
    assertEquals(err.code, "hook_failed");
  },
);

Deno.test("sign is refused at runtime, not only by the type — no network-capable sign runs", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const auth = app.auths[0];
  // sendgrid's auth DOES declare `sign` — proves this is a kind refusal, not
  // a "hook not declared" one falling through by coincidence.
  assert(auth.hooks.has("sign"));

  const err = await assertRejects(
    () => runAuthHook(app, auth, "sign" as CredentialHookKind, { apiKey: "key-A" }),
    W6WError,
  );
  assertNotEquals(err.code, "egress_denied");
  assert(err.message.includes("sign"), `expected message to name "sign", got: ${err.message}`);
});

Deno.test("a hook the auth doesn't declare is refused, naming the auth key and the hook", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const auth = app.auths[0];
  assert(!auth.hooks.has("revoke"), "fixture must not declare revoke for this case to hold");

  const err = await assertRejects(
    () => runAuthHook(app, auth, "revoke", { apiKey: "key-A" }),
    W6WError,
  );
  assertEquals(err.code, "hook_not_declared");
  assert(err.message.includes(auth.auth.key), `expected message to name "${auth.auth.key}"`);
  assert(err.message.includes("revoke"), `expected message to name "revoke"`);
});
