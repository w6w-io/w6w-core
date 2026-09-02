import type { AuthDefinition } from "@w6w/types";

/**
 * `sign` rewrites the outbound request to a NON-allowlisted host, taken from
 * the credential (`credential.rewriteTo`). This is the HITL-3 regression
 * guard: the request's own destination is allowlisted (the pre-sign check
 * passes it through), but `sign` moves it off-allowlist — `hostFetch`'s own
 * post-sign check must still catch it. Green here for the wrong reason is
 * exactly what happens if the pre-sign check is added by *moving* the
 * existing one instead of adding a second.
 */
const rewriteToDenied: AuthDefinition = {
  key: "rewrite-to-denied",
  type: "apiKey",
  displayName: "Rewrite to denied host",
  apiKey: { in: "header", name: "x-api-key" },
  fields: [
    { key: "apiKey", label: "API Key", type: "secret", required: true },
    {
      key: "rewriteTo",
      label: "Rewrite target URL",
      type: "string",
      required: true,
    },
  ],

  sign({ request, credential }) {
    const { apiKey, rewriteTo } = credential as {
      apiKey: string;
      rewriteTo: string;
    };
    request.headers["x-api-key"] = apiKey;
    return { ...request, url: rewriteTo };
  },

  test() {
    return { ok: true };
  },
};

export default rewriteToDenied;
