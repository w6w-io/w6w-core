import type { AppDefinition } from "@w6w/types";
import whoami from "./actions/whoami.ts";
import serviceAccount from "./auth/service-account.ts";

export default {
  actions: [whoami],
  auth: [serviceAccount],
} satisfies AppDefinition;
