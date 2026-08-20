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
   * Display metadata for the connection label. Its shape is picked by the
   * credential it's given (never a constant), so one hook can exercise all
   * three of `runAuthHook`'s egress cases, plus a regression case:
   *   - no `probeUrl`/`throwMessage` -> pure, label derived straight from the
   *     credential;
   *   - `probeUrl` set -> calls it via `ctx.fetch`, letting the caller choose
   *     an allowed host (the request succeeds and the response is used) or a
   *     denied one (the request is rejected before it leaves the host);
   *   - `throwMessage` set -> throws a plain business-logic error and NEVER
   *     calls `ctx.fetch` at all — even when that message happens to end in
   *     the exact wording `hostFetch` uses for a real denial, this must not
   *     be mistaken for one (round-2 regression: see `runAuthHook`).
   */
  async afterConnect({ credential }, ctx) {
    const { apiKey, probeUrl, throwMessage } = credential as {
      apiKey: string;
      probeUrl?: string;
      throwMessage?: string;
    };
    if (throwMessage) {
      throw new Error(throwMessage);
    }
    if (!probeUrl) {
      return { label: `SendGrid (${apiKey})` };
    }
    const res = await ctx.fetch(probeUrl);
    return { label: `SendGrid (${apiKey})`, probeStatus: res.status };
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
