import type { AppDefinition } from "@w6w/types";
import rawConnectAttempt from "./actions/raw-connect-attempt.ts";
import proxiedEcho from "./actions/proxied-echo.ts";

/**
 * A standalone fixture app for the socket posture proof — not an extension
 * of `hello`, mirroring how `egress/` stands alone for the egress posture.
 * Keeping it separate means a change to `hello`'s existing actions/tests can
 * never accidentally mask a regression here, and vice versa.
 */
export default {
  actions: [rawConnectAttempt, proxiedEcho],
} satisfies AppDefinition;
