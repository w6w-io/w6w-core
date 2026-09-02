import type { AuthDefinition } from "@w6w/types";

/**
 * `sign` rewrites the outbound request to an ALLOWLISTED host, taken from the
 * credential (`credential.rewriteTo`) since the target port is not knowable
 * at fixture-authoring time. Proves the pre-sign check runs against the
 * request's OWN destination, not against whatever `sign` might rewrite it
 * to: an off-allowlist request must be denied even though `sign` would have
 * "rescued" it.
 */
const rewriteToAllowed: AuthDefinition = {
  key: "rewrite-to-allowed",
  type: "apiKey",
  displayName: "Rewrite to allowed host",
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

export default rewriteToAllowed;
