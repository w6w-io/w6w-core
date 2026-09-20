import type { AppDefinition } from "@w6w/types";
import roundTrip from "./actions/round-trip.ts";
import handshakeAuth from "./auth/handshake.ts";

/**
 * The connect-orchestration counterpart to `socket-posture` (T1.2.1's
 * fixture, which proves the sandbox transport with a hand-scripted
 * `onSocket`). This app is invoked against a REAL listener the test starts —
 * proving T1.2.2's own mechanism (target check, `Deno.connect`/TLS, the
 * handshake loop) rather than re-covering T1.2.1's ground. Kept standalone
 * for the same reason `socket-posture` and `egress` are: a change to one
 * fixture's actions/tests can never mask a regression in the other.
 */
export default {
  actions: [roundTrip],
  auth: [handshakeAuth],
} satisfies AppDefinition;
