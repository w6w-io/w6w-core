import type { AuthDefinition } from "@w6w/types";

/**
 * A `serviceAccount` auth. `sign` receives the host-derived token ONLY, and
 * echoes exactly what it was handed into `x-sign-input` so a test can assert,
 * at the wire, that nothing else (no key material) ever reached it.
 * `test` and `afterConnect` run credential-less: their `ctx.fetch` is signed
 * by the host, and `test` echoes its own input so a test can pin that too.
 */
const serviceAccount: AuthDefinition = {
  key: "service-account",
  type: "serviceAccount",
  displayName: "Service account",
  serviceAccount: {
    accepts: ["google-service-account.v1"],
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    impersonation: "none",
  },

  sign({ request, credential }) {
    const token = credential as { accessToken: string };
    request.headers["authorization"] = `Bearer ${token.accessToken}`;
    request.headers["x-sign-input"] = JSON.stringify(credential);
    return request;
  },

  async test(input, ctx) {
    const res = await ctx.fetch("https://probe.w6w.test/whoami");
    // `keys` pins that absent members are omitted, not undefined-valued.
    return { ok: res.ok, message: JSON.stringify(input), keys: Object.keys(input) };
  },

  async afterConnect(_input, ctx) {
    await ctx.fetch("https://denied.w6w.test/");
    return {};
  },
};

export default serviceAccount;
