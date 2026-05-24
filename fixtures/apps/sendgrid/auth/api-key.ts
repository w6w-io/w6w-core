import type { AuthDefinition } from "@w6w/types";

const apiKey: AuthDefinition = {
  key: "api-key",
  type: "apiKey",
  displayName: "API Key",
  apiKey: { in: "header", name: "Authorization", prefix: "Bearer " },
  fields: [
    { key: "apiKey", label: "API Key", type: "secret", required: true },
  ],

  /**
   * The only hook given the credential. Runs in a network-less worker, so even
   * if this code were hostile it could not exfiltrate the key. It just stamps
   * the Authorization header onto the outbound request.
   */
  sign({ request, credential }) {
    const { apiKey } = credential as { apiKey: string };
    request.headers["authorization"] = `Bearer ${apiKey}`;
    return request;
  },

  /** Connect-time credential check. Required; not exercised by invoke() yet. */
  test() {
    return { ok: true };
  },

  /**
   * Exercises the runtime's `needs_refresh` gate. A real OAuth refresh would
   * `ctx.fetch` the token endpoint; here it just derives a new credential so
   * the lifecycle path is testable without a token server.
   */
  refresh({ credential }) {
    const { apiKey } = credential as { apiKey: string };
    return { apiKey: `${apiKey}-refreshed` };
  },
};

export default apiKey;
