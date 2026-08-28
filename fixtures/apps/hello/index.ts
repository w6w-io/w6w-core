import type { AppDefinition } from "@w6w/types";
import getGreeting from "./actions/get-greeting.ts";
import escapeAttempt from "./actions/escape-attempt.ts";
import echoContext from "./actions/echo-context.ts";

export default {
  actions: [getGreeting, escapeAttempt, echoContext],
  interfaces: [{
    interfaceId: "fixture-greeter@1",
    methods: {
      greet: {
        uses: { action: "get-greeting" },
        with: { name: { "$": "inputs.name" } },
        outputMap: { greeting: { "$": "output.greeting" } },
      },
    },
  }],
} satisfies AppDefinition;
