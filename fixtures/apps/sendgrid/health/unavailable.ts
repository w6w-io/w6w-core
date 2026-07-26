import type { HealthCheckDefinition } from "@w6w/types";

/** Declares that nothing exists to probe — a positive fact, not an omission. */
const unavailable: HealthCheckDefinition = {
  key: "webhooks",
  title: "Webhook delivery",
  kind: "dependency",
  covers: ["component:webhooks"],
  unavailable: { reason: "the vendor publishes no webhook health signal" },
};

export default unavailable;
