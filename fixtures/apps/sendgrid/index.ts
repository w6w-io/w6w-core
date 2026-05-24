import type { AppDefinition } from "@w6w/types";
import sendEmail from "./actions/send-email.ts";
import apiKey from "./auth/api-key.ts";

export default {
  actions: [sendEmail],
  auth: [apiKey],
} satisfies AppDefinition;
