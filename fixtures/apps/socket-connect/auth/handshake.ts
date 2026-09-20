import type { AuthDefinition, HandshakeStep } from "@w6w/types";

interface Credential {
  /** Echoed into the first auth frame the real 2-step handshake sends. */
  token: string;
  /**
   * Test-only behavior selector, read only by this fixture's own suite
   * (`socket-connect.test.ts`) so the handshake loop's failure modes can be
   * exercised without a second Auth method:
   *   - `"fetch"` — calls `ctx.fetch` on the first step. DC-1 keeps the
   *     handshake hook network-less (no `onFetch` is ever passed to its
   *     `runHook` call), so this must throw and surface the whole invocation
   *     as `connection_broken`.
   *   - `"never-done"` — always returns `{ done: false }`, ignoring the
   *     reply, so the loop must hit its step cap rather than spin forever.
   *   - `"leftover"` — same 2-step shape as the real handshake, but the
   *     listener's step-2 reply batches the "OK\n" auth-confirmation AND a
   *     trailing protocol message in one write; this mode recognizes only
   *     the "OK\n" prefix as its own and returns everything after it as
   *     `HandshakeStep.leftover`, for `socket-connect.test.ts`'s FU-6 case.
   * Absent (or any other value) runs the real handshake below.
   */
  mode?: "fetch" | "never-done" | "leftover";
}

/**
 * A toy but genuinely ITERATIVE handshake: step 1 sends the credential's
 * token as an auth frame and waits for the listener's reply; step 2 — now
 * holding that reply as `received` — completes. Two round trips is the
 * smallest shape that actually exercises `runHandshake`'s loop; a one-step
 * implementation would still satisfy a test written against a `sign`-shaped
 * single call.
 */
const handshakeAuth: AuthDefinition = {
  key: "handshake-auth",
  type: "custom",
  displayName: "Handshake Auth",

  test() {
    return { ok: true };
  },

  async handshake({ credential, received, target }, ctx): Promise<HandshakeStep> {
    const { token, mode } = credential as Credential;

    if (mode === "fetch") {
      // Rejects immediately — see the `mode` doc comment above.
      await ctx.fetch(`https://${target.host}/unreachable`);
      return { done: true };
    }
    if (mode === "never-done") {
      return { done: false, send: new TextEncoder().encode("PING\n") };
    }
    if (mode === "leftover") {
      if (received === undefined) {
        return { done: false, send: new TextEncoder().encode(`AUTH ${token}\n`) };
      }
      // Only "OK\n" belongs to the handshake; anything the server batched
      // after it in the same read is the connection's, not the auth
      // exchange's — hand it back as `leftover`.
      const idx = received.indexOf(0x0a); // "\n"
      const leftover = received.subarray(idx + 1);
      return { done: true, leftover: leftover.byteLength > 0 ? leftover : undefined };
    }

    if (received === undefined) {
      return { done: false, send: new TextEncoder().encode(`AUTH ${token}\n`) };
    }
    return { done: true };
  },
};

export default handshakeAuth;
