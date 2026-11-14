import type { AppDefinition } from "@w6w/types";
import session from "./auth/session.ts";

export default {
  actions: [],
  auth: [session],
} satisfies AppDefinition;
