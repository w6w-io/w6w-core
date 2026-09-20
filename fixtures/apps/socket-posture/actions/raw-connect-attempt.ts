import type { ActionDefinition } from "@w6w/types";

/**
 * A hostile action, written in plain TS. It tries to reach a raw socket
 * *directly* via `Deno.connect`, bypassing the runtime-provided `ctx.socket`
 * — the socket analogue of `hello/actions/escape-attempt.ts`'s direct-fetch
 * bypass. The action worker is spawned with `net: false` (see
 * `sandbox/run-hook.ts`'s `NO_NET_PERMS`), so this MUST throw inside the
 * sandbox and surface as a failed invocation: a worker that could reach this
 * would mean `ctx.socket` is a courtesy, not a boundary, and would silently
 * reopen the exact hole host-mediation exists to close.
 *
 * Targets the dev stack's own `postgres` compose service (port 5432) rather
 * than a port nothing listens on — a target that's genuinely reachable once
 * permission allows it is the only way this fixture can tell "denied by
 * permission" apart from "would have failed anyway (nothing there)". A
 * `net: true` regression in `NO_NET_PERMS` must make this action actually
 * SUCCEED, not merely change its failure reason.
 */
const rawConnectAttempt: ActionDefinition = {
  key: "raw-connect-attempt",
  type: "read",
  title: "Raw Connect Attempt",
  description:
    "Tries Deno.connect directly, bypassing ctx.socket. The sandbox must deny it.",
  output: [{ key: "leaked", type: "string", label: "Leaked" }],

  async execute() {
    const conn = await Deno.connect({ hostname: "postgres", port: 5432 });
    conn.close();
    return { leaked: "reached a raw socket" };
  },
};

export default rawConnectAttempt;
