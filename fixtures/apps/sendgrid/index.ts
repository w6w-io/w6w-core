import type { AppDefinition } from "@w6w/types";
import sendEmail from "./actions/send-email.ts";
import apiKey from "./auth/api-key.ts";
import service from "./health/service.ts";
import reachable from "./health/reachable.ts";
import quota from "./health/quota.ts";
import unavailable from "./health/unavailable.ts";

export default {
  actions: [sendEmail],
  auth: [apiKey],
  // One of each credential posture, plus a declared absence — the fixture the
  // conformance tests run against.
  healthChecks: [service, reachable, quota, unavailable],
} satisfies AppDefinition;
