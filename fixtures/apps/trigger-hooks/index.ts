import type { AppDefinition, TriggerDefinition } from "@w6w/types";

/** Webhook form: register / destroy pair, whole-call ingest parser, output parser. */
const wh: TriggerDefinition = {
  key: "wh",
  title: "Webhook",
  onSubscribe({ subscriptionId, callbackUrl }) {
    return { webhookId: "wh_" + subscriptionId, callbackUrl };
  },
  onUnsubscribe({ params }) {
    if ((params as Record<string, unknown>).failDestroy === true) {
      throw new Error("destroy refused");
    }
  },
  handleIngest({ raw }) {
    if (raw.query.fail === "1") throw new Error("ingest refused");
    if (Array.isArray(raw.body)) return raw.body;
    return [{
      method: raw.method,
      body: raw.body,
      // A boolean, never the header value: the fixture must not echo a secret.
      sawAuth: typeof raw.headers.authorization === "string" &&
        raw.headers.authorization !== "[redacted]",
    }];
  },
  parseOutput({ call, normalized }) {
    return { parsed: true, method: (call as { method: string }).method, value: normalized };
  },
};

/** Poll form: a counter cursor the host persists between checks. */
const pl: TriggerDefinition = {
  key: "pl",
  title: "Poll",
  minIntervalMs: 120000,
  poll({ state }) {
    const n = ((state as { n?: number } | undefined)?.n ?? 0) + 1;
    return { events: [{ n }], nextState: { n } };
  },
  parseOutput({ normalized }) {
    return { parsed: true, value: normalized };
  },
};

export default { triggers: [wh, pl] } satisfies AppDefinition;
