import type { AuthDefinition } from "@w6w/types";

/**
 * Always throws before doing anything else. The literal marker
 * `"SIGN HOOK RAN"` is what the redirect battery asserts is ABSENT from a
 * rejection: if the rejection is `egress_denied` and the message does not
 * contain it, the pre-sign check ran and the `sign` worker was never
 * spawned at all.
 */
const throwing: AuthDefinition = {
  key: "throwing",
  type: "apiKey",
  displayName: "Throwing sign hook",
  apiKey: { in: "header", name: "x-api-key" },
  fields: [
    { key: "apiKey", label: "API Key", type: "secret", required: true },
  ],

  sign() {
    throw new Error("SIGN HOOK RAN");
  },

  test() {
    return { ok: true };
  },
};

export default throwing;
