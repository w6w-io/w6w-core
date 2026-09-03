import type { AuthDefinition } from "@w6w/types";

/**
 * Signs a NON-`Authorization` header, mirroring the real shape at
 * `packages/apps/apps/figma/auth/personal-access-token.ts` (`x-figma-token`).
 * Fetch strips `Authorization` cross-origin unaided, which is exactly why
 * F-2's leak needs a header Fetch does NOT strip to be provable at all.
 */
const apiKeyHeader: AuthDefinition = {
  key: "api-key-header",
  type: "apiKey",
  displayName: "API Key (header)",
  apiKey: { in: "header", name: "x-api-key" },
  fields: [
    { key: "apiKey", label: "API Key", type: "secret", required: true },
  ],

  sign({ request, credential }) {
    const { apiKey } = credential as { apiKey: string };
    request.headers["x-api-key"] = apiKey;
    return request;
  },

  test() {
    return { ok: true };
  },
};

export default apiKeyHeader;
