import type { ActionDefinition } from "@w6w/types";

interface Input {
  message: string;
  /**
   * Test-only: throw AFTER the write/read round trip has already happened,
   * so `socket-connect.test.ts` can observe the `finally`'s close on the
   * REJECT path too (the happy path alone can't tell "closes on success"
   * apart from "never closes at all").
   */
  failAfter?: boolean;
}

interface Output {
  echoed: string | null;
}

/**
 * Writes `input.message` to the Connection's real socket and reads back
 * whatever the listener replies with — by the time `execute` runs, the host
 * has already resolved+checked the target, opened the real connection, and
 * driven the handshake to completion (T1.2.2's whole mechanism), so this
 * action only ever sees an already-live `ctx.socket`.
 */
const roundTrip: ActionDefinition<Input, Output> = {
  key: "round-trip",
  type: "perform",
  title: "Round Trip",
  description: "Writes a message through the real ctx.socket and reads back the reply.",
  params: [
    { key: "message", label: "Message", type: "string", required: true },
    { key: "failAfter", label: "Fail after round trip", type: "boolean" },
  ],
  output: [{ key: "echoed", type: "string", label: "Echoed" }],

  async execute(input, ctx) {
    if (!ctx.socket) throw new Error("ctx.socket is not present.");
    await ctx.socket.write(new TextEncoder().encode(input.message));
    const bytes = await ctx.socket.read();
    const echoed = bytes ? new TextDecoder().decode(bytes) : null;
    if (input.failAfter) throw new Error("forced failure after the round trip");
    return { echoed };
  },
};

export default roundTrip;
