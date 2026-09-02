import type { AppDefinition } from "@w6w/types";
import call from "./actions/call.ts";
import probeThenFail from "./actions/probe-then-fail.ts";
import apiKeyHeader from "./auth/api-key-header.ts";
import rewriteToAllowed from "./auth/rewrite-to-allowed.ts";
import rewriteToDenied from "./auth/rewrite-to-denied.ts";
import throwing from "./auth/throwing.ts";

// One auth method per posture the T1.1.2 battery needs: a non-`Authorization`
// signed header (F-2's leak is invisible to any test that asserts only on
// `Authorization`), a `sign` hook that rewrites the URL to an allowlisted
// host, one that rewrites it to a denied host, and one that throws before
// touching the network at all. `probeThenFail` (round 2, R7) is a second
// action that swallows an early denied-fetch error and then throws an
// unrelated one, so the battery can prove `withDeniedUnwrap` does not
// reclassify that unrelated failure as the swallowed denial.
export default {
  actions: [call, probeThenFail],
  auth: [apiKeyHeader, rewriteToAllowed, rewriteToDenied, throwing],
} satisfies AppDefinition;
