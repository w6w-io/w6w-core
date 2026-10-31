import type { AppDefinition, AuthDefinition, TriggerDefinition } from "@w6w/types";

/** Non-interactive credential: the registration client signs with it in the background. */
const token: AuthDefinition = {
  key: "token",
  type: "apiKey",
  displayName: "Partner token",
  apiKey: { in: "header", name: "Authorization" },
  fields: [{ key: "token", label: "Token", type: "secret", required: true }],
  sign({ request, credential }) {
    const { token } = credential as { token: string };
    request.headers["Authorization"] = `Bearer ${token}`;
    return request;
  },
  test() {
    return { ok: true };
  },
};

/** One event; one plain param plus one SECRET param (never sent to the partner). */
const orderPlaced: TriggerDefinition = {
  key: "order-placed",
  title: "Order placed",
  delivery: "w6w-protocol",
  protocol: { events: ["order.placed"], filters: { versions: [1] } },
  requiresAuth: true,
  params: [
    { key: "storeId", label: "Store", type: "string" },
    { key: "signingNote", label: "Signing note", type: "secret" },
  ],
};

/** Two events: the `eventType` select picks the one a subscription registers. */
const guestEvent: TriggerDefinition = {
  key: "guest-event",
  title: "Guest event",
  delivery: "w6w-protocol",
  protocol: { events: ["guest.checked_in", "guest.checked_out"] },
  requiresAuth: true,
  params: [
    {
      key: "eventType",
      label: "Event",
      type: "select",
      required: true,
      options: [
        { value: "guest.checked_in", label: "Checked in" },
        { value: "guest.checked_out", label: "Checked out" },
      ],
    },
  ],
};

export default { auth: [token], triggers: [orderPlaced, guestEvent] } satisfies AppDefinition;
