import type { AppDefinition } from "@w6w/types";
import getGreeting from "./actions/get-greeting.ts";
import escapeAttempt from "./actions/escape-attempt.ts";

export default {
  actions: [getGreeting, escapeAttempt],
} satisfies AppDefinition;
