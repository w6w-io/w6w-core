import type { AppDefinition } from "@w6w/types";
import call from "./actions/call.ts";
import apiKeyHeader from "./auth/api-key-header.ts";
import rewriteToAllowed from "./auth/rewrite-to-allowed.ts";
import rewriteToDenied from "./auth/rewrite-to-denied.ts";
import throwing from "./auth/throwing.ts";

// One auth method per posture the T1.1.2 battery needs: a non-`Authorization`
// signed header (F-2's leak is invisible to any test that asserts only on
// `Authorization`), a `sign` hook that rewrites the URL to an allowlisted
// host, one that rewrites it to a denied host, and one that throws before
// touching the network at all.
export default {
  actions: [call],
  auth: [apiKeyHeader, rewriteToAllowed, rewriteToDenied, throwing],
} satisfies AppDefinition;
