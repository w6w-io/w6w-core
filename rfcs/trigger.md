# RFC: Trigger

**Status:** Draft
**Author:** Segev Shmueli
**Date:** 2026-07-03

## Summary

A **Trigger** is an app-declared surface that emits **events** which the host delivers to subscribed [Workflows](./workflow.md). Alongside [Actions](./action.md) (which workflows *call*), triggers are how workflows *start*. This RFC defines the app-facing declaration (`TriggerDefinition`), the subscription lifecycle, the host-side `TriggerManager` contract, and the persist-then-dispatch delivery semantics. The mechanism is **transport-agnostic**: the same trigger contract works over HTTPS webhooks, message queues (Kafka, SQS), cron, or polled feeds — each is a host-side **adapter** above the manager. v1 ships one adapter (HTTPS) and one subscriber class (workflows).

## Motivation

Today, workflows only run when someone explicitly presses a button or a schedule fires. Real automations react to **events** — a message arrived in Slack, an invoice was paid in Stripe, a row was added in Airtable, a repo received a push. The industry has converged on a shape:

- Users **subscribe** a workflow to an app's event source with some configuration.
- The event source (webhook, queue, poll) delivers events to the host.
- The host **runs the workflow** with the event as input.

Zapier and n8n both implement this pattern with per-transport coupling and per-connector custom code. We want a **single spec** apps implement to expose events, and a **single manager** hosts implement to receive, persist, and dispatch them — independent of transport.

## Goals

- **App-facing declaration** analogous to [Action](./action.md): `TriggerDefinition` with `key`, typed `params`, typed `output`, and lifecycle hooks.
- **Transport-agnostic contract.** A trigger doesn't know whether it was called by an HTTPS endpoint, a Kafka consumer, a cron tick, or a poller. Transports are host-side adapters.
- **Subscription model** that binds a trigger + connection + params to a subscriber — v1: workflow-only.
- **Persist-then-dispatch** semantics: every accepted event is durably stored before it is dispatched. Loss requires storage failure, not process failure.
- **Reliable delivery**: at-least-once with subscriber-side idempotency; bounded retries with backoff; dead-letter visibility.
- **Pluggable dispatch**: hosts can use polling, LISTEN/NOTIFY, or any other pattern without changing the contract.

## Non-Goals

- **Filter DSL.** Per-subscription filtering is a workflow concern — users add a filter step at the top of the graph. If pre-filter perf becomes an issue, extend `Subscription` with an optional `predicate?` field later (additive).
- **Non-workflow subscribers.** v1 delivers only to workflows. Partner HTTP callbacks, arbitrary consumers, and event-store fan-out are deferred.
- **Transport specifics.** HTTPS request framing, Kafka consumer-group semantics, cron scheduler internals — all host implementation. This RFC pins only the app + manager contracts.
- **Ordering across subscriptions.** Within a subscription: FIFO by `receivedAt`. Across subscriptions: unordered.
- **Exactly-once semantics.** Achieving exactly-once at the platform level adds cost without user value; every event carries an `event.id` and subscribers dedupe if they need to.
- **The workflow engine's execution.** How the host resolves a delivered event into a run is specified in the [Workflow RFC](./workflow.md).

## Concept

An app declares one or more triggers alongside its actions. Each trigger has:

- **`params`** — configuration collected when a subscription is created (channel to watch, filter tag, poll interval, etc.).
- **`output`** — the shape of one normalized event (drives editor autocomplete for downstream workflow steps).
- **`onSubscribe`** — called when a subscription is created. Sets up the third-party subscription (register a webhook, seed a cursor). Returns opaque **state** the host persists on the subscription.
- **`onUnsubscribe`** — called when a subscription is deleted. Tears down (unregister webhook, release resources).
- **`handleIngest`** — called by whichever transport adapter received an inbound thing. Converts raw input into zero or more normalized events. This is also where the app **verifies signatures**, **dedupes**, and applies its own logic.

A **Subscription** is `(trigger) → (workflow)`. It carries the resolved `params`, a `connectionId` (when the trigger requires auth), and the opaque `state` returned by `onSubscribe`.

Delivery is **persist-then-dispatch**:

1. A transport adapter (v1: HTTPS endpoint at `POST /triggers/webhooks/:subscriptionId`) receives raw input.
2. The adapter calls `manager.ingest(subscriptionId, raw)`.
3. `ingest` calls the trigger's `handleIngest`, which returns 0..N normalized events.
4. Each normalized event is written to `trigger_events` with `status: "received"` in a single transaction.
5. `ingest` returns. The HTTP endpoint returns 200 only after commit.
6. A **dispatcher** — polling, LISTEN/NOTIFY, or partner-supplied — reads pending events, resolves the subscription's subscriber (the workflow id), and starts a run.
7. On successful start, the dispatcher marks the event `dispatched`. On failure, retry with backoff up to a bounded number of attempts; then dead-letter.

This decoupling means: the adapter can return 200 fast (bounded work), the dispatcher runs at its own pace, and events survive crashes.

## Shape

### TriggerDefinition

```json
{
  "manifestVersion": "1",
  "key": "new-message",
  "title": "New Message in Channel",
  "description": "Fires when a new message is posted to the selected Slack channel.",
  "requiresAuth": true,
  "params": [
    {
      "key": "channelId",
      "label": "Channel",
      "type": "select",
      "options": { "source": "./hooks/list-channels.ts" },
      "required": true
    },
    {
      "key": "ignoreBots",
      "label": "Ignore bot messages",
      "type": "boolean",
      "default": true
    }
  ],
  "output": [
    { "key": "id",        "type": "string", "label": "Message ID" },
    { "key": "text",      "type": "string", "label": "Message Text" },
    { "key": "user.id",   "type": "string", "label": "Author ID" },
    { "key": "user.name", "type": "string", "label": "Author Name" },
    { "key": "postedAt",  "type": "string", "label": "Posted At (ISO-8601)" }
  ],
  "sample": {
    "id": "1699999999.0001",
    "text": "hello team",
    "user": { "id": "U0123", "name": "alex" },
    "postedAt": "2026-07-03T09:00:00Z"
  },
  "onSubscribe":    "./triggers/new-message/onSubscribe.ts",
  "onUnsubscribe":  "./triggers/new-message/onUnsubscribe.ts",
  "handleIngest":   "./triggers/new-message/handleIngest.ts"
}
```

### Field reference

#### Trigger (declaration, without behavior)

| Field | Type | Required | Description |
|---|---|---|---|
| `manifestVersion` | string | ✅ | Core spec version. |
| `key` | string | ✅ | Machine name. Unique within the App. Lowercase, kebab-case. |
| `title` | string | ✅ | Human-facing name (e.g. "New Message in Channel"). |
| `description` | string | ⬜ | One-line summary. |
| `params` | [Param](./param.md)[] | ⬜ | Configuration collected when a subscription is created. Reuses the full Param RFC — dynamic `options`, `dependsOn`, validation. |
| `output` | [OutputField](./action.md#outputfield)[] \| `{ source }` | ⬜ | Shape of one normalized event. Reuses Action's Output shape — static or dynamic. Drives editor autocomplete for downstream `steps.<id>.output` references. |
| `sample` | object | ⬜ | Example event matching `output`. Used by the editor to preview downstream mapping without waiting for a live event. |
| `requiresAuth` | boolean | ⬜ | When the enclosing App declares Auth methods, set `false` to opt this trigger out of requiring a Connection. Defaults to `true` when the App has auth, `false` when it doesn't. |

#### TriggerDefinition (declaration + behavior)

Adds the lifecycle hooks:

| Field | Type | Required | Description |
|---|---|---|---|
| `onSubscribe` | string (path) \| function | ⬜ | Called when a subscription is created. See [Hooks](#hooks). Optional — omit for triggers with no third-party setup (a generic "HTTPS receiver" that just needs a URL). |
| `onUnsubscribe` | string (path) \| function | ⬜ | Called when a subscription is deleted. Optional; MUST be provided when `onSubscribe` allocates external resources. |
| `handleIngest` | string (path) \| function | ✅ | Called by the transport adapter with raw input. Returns normalized events. |

### AppDefinition update

Apps grow one new optional field:

```ts
export interface AppDefinition {
  actions:  AnyActionDefinition[];
  auth?:    AuthDefinition[];
  triggers?: AnyTriggerDefinition[];       // new
}
```

The registry stores triggers alongside actions (`app_triggers` table, mirroring `app_actions`).

### WorkflowTrigger update

Today's `WorkflowTrigger` is `{ type: "manual" | "schedule" | "webhook", cron? }` — a leaf enum. This RFC replaces it with a reference to a subscription:

```ts
export type WorkflowTrigger =
  | { type: "manual" }
  | { type: "schedule"; cron: string }
  | { type: "event"; subscriptionId: string };
```

- `manual` — the workflow can be started only by explicit API/editor invocation.
- `schedule` — the host's built-in scheduler fires it on the cron. (Semantically a special "schedule" trigger; kept as a first-class variant because it doesn't require an app.)
- `event` — starts when the referenced subscription dispatches an event. This is the app-declared-trigger case; the host resolves `subscriptionId` to the subscription's `(app, triggerKey)` and passes the event's normalized payload into the run.

The workflow-side reference is intentionally thin — the subscription itself carries the trigger identity, connection, and params. Multiple workflows subscribing to the same "trigger declaration + connection + params" still create separate `Subscription` rows.

## Subscription

A `Subscription` is the durable "I want events from trigger X, filtered by params Y, on connection Z, delivered to workflow W" record.

```json
{
  "id": "sub_9f4c...",
  "appId": "slack",
  "triggerKey": "new-message",
  "connectionId": "conn_ab12",
  "workflowId": "wf_daily_report",
  "params": { "channelId": "C01", "ignoreBots": true },
  "state": { "webhookId": "wh_88…" },
  "enabled": true,
  "createdAt": "2026-07-03T09:00:00Z",
  "updatedAt": "2026-07-03T09:00:00Z"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✅ | Host-issued. This id is the **shared secret** in the HTTPS adapter URL (`/triggers/webhooks/:subscriptionId`). |
| `appId` | string | ✅ | The app that declared the trigger. |
| `triggerKey` | string | ✅ | The trigger's `key` within the app. |
| `connectionId` | string | ⬜ | Required when the trigger's `requiresAuth` resolves to true. |
| `workflowId` | string | ✅ | The workflow that runs when this subscription dispatches an event. v1: exactly one. |
| `params` | object | ✅ | Resolved param values (subject to the trigger's Param resolution — dynamic options, `dependsOn`, validation). |
| `state` | object | ⬜ | Opaque state returned by `onSubscribe`. Never introspected by the host. |
| `enabled` | boolean | ✅ | When `false`, `ingest` still persists the event (audit) but the dispatcher skips it. Defaults to `true`. |
| `createdAt`, `updatedAt` | ISO-8601 | ✅ | Timestamps. |

## Hooks

Each hook receives a `HookContext` per the [Hook Runtime RFC](./hook-runtime.md). Extra fields specific to trigger hooks:

### `onSubscribe`

```ts
type OnSubscribe<Params, State> = (input: {
  params:         Params;               // resolved subscription params
  connection?:    Connection;           // absent when requiresAuth === false
  subscriptionId: string;               // stable, host-issued
  hostContext: {
    /** URL the transport adapter serves for this subscription. Apps embed this
     *  in webhook registrations with the third-party. HTTPS adapter default:
     *  https://<host>/triggers/webhooks/<subscriptionId>.
     *  Apps MUST NOT construct URLs themselves — the host tells them what to use. */
    callbackUrl: string;
    /** Absolute host URL (no trigger path), for apps that need a canonical origin. */
    hostUrl: string;
  };
  ctx: HookContext;
}) => Promise<State>;
```

Returns opaque **state** (webhook id, cursor, whatever the app needs to remember). Persisted verbatim on the subscription.

### `onUnsubscribe`

```ts
type OnUnsubscribe<Params, State> = (input: {
  params:      Params;
  connection?: Connection;
  state:       State;
  ctx:         HookContext;
}) => Promise<void>;
```

Idempotent. May be called on an already-torn-down subscription (e.g. after connection revocation). Errors are logged; the subscription is deleted regardless.

### `handleIngest`

```ts
type HandleIngest<Params, State, Event> = (input: {
  raw:            unknown;               // whatever the transport adapter received
  params:         Params;
  state:          State;
  subscriptionId: string;
  ctx:            HookContext;
}) => Promise<Event[]>;                  // 0..N normalized events
```

Returning `[]` means "acknowledged but nothing to dispatch" — the correct choice for callback pings, uninteresting webhooks, or duplicate deliveries the app dedupes internally. Signature verification lives here: throw before returning to reject the payload; the transport adapter propagates the error (HTTPS: 400 + error body).

## Host contract — `TriggerManager`

```ts
interface TriggerManager {
  // Ownership
  subscribe(input: {
    appId:        string;
    triggerKey:   string;
    connectionId?: string;
    workflowId:   string;
    params:       Record<string, unknown>;
  }): Promise<Subscription>;

  unsubscribe(subscriptionId: string): Promise<void>;

  getSubscription(id: string): Promise<Subscription | null>;
  listSubscriptionsForWorkflow(workflowId: string): Promise<Subscription[]>;

  // Intake — called by transport adapters
  ingest(subscriptionId: string, raw: unknown): Promise<{ eventIds: string[] }>;

  // Dispatch — called by whichever dispatcher pattern the host runs
  drainPending(limit: number): Promise<PendingEvent[]>;
  markDispatched(eventId: string, outcome: "ok" | { error: StepError }): Promise<void>;
}

interface PendingEvent {
  id:             string;
  subscriptionId: string;
  normalized:     unknown;                // one event as returned by handleIngest
  receivedAt:     string;
  attempts:       number;
}
```

| Method | Required | Notes |
|---|---|---|
| `subscribe` | ✅ | Validates `params` against the trigger's declared Params. Calls `onSubscribe`. Persists the returned state. On failure, no subscription row is created. |
| `unsubscribe` | ✅ | Calls `onUnsubscribe`. Persists deletion even if the hook fails (logs the error). Cascade-safe — dependent `trigger_events` may be preserved for audit or deleted per host policy. |
| `getSubscription`, `listSubscriptionsForWorkflow` | ✅ | Read-only reflection for editors and dispatchers. |
| `ingest` | ✅ | Calls `handleIngest`. Persists each returned event with `status: "received"` in one transaction with the "raw payload received" audit record. Returns after commit. |
| `drainPending` | ✅ | Atomically claims up to `limit` `received` events, marks them `dispatching`, and returns them. Multiple dispatchers running concurrently MUST NOT return the same event twice. |
| `markDispatched` | ✅ | Terminal state transition. On `"ok"`, moves to `dispatched`. On error, increments `attempts`; if under the retry budget, returns to `received` with a delay (backoff); otherwise moves to `failed`. |

## Delivery semantics

### At-least-once with subscriber idempotency

Every normalized event carries an `event.id` (host-issued, stable per event across retries). Workflows receive this id in `trigger.event.id` and MUST treat it as an idempotency key if the workflow's downstream steps are non-idempotent.

The host does not attempt exactly-once. The engineering cost of true exactly-once (distributed consensus, XA transactions across app + host + subscriber) has no user-facing value that a subscriber-side dedupe can't provide.

### Persist-first

`ingest` MUST NOT return control to the transport adapter until every event returned by `handleIngest` is durably persisted with `status: "received"`. The HTTPS adapter returns 200 only after commit; if commit fails, the third-party retries per their contract.

### Retry backoff

The dispatcher retries `dispatching → received` transitions with delays: **1s, 5s, 30s, 5m, 30m**. After 5 failed attempts, the event moves to `failed` (dead-letter). Dead-lettered events are visible in the UI and can be manually requeued (transition `failed → received`, reset `attempts = 0`).

Errors from the workflow engine (e.g. `plan_error`, `invalid_variables`) are **non-retryable** and skip straight to `failed`. Errors classified as transient (network, timeout, host-side back-pressure) follow the backoff.

### Ordering

- **Within one subscription:** FIFO by `receivedAt`. The dispatcher processes older events before newer ones; concurrent dispatchers share the queue via the `drainPending` atomic claim.
- **Across subscriptions:** no ordering guarantee.

### Backpressure

`drainPending` bounds the dispatcher's per-loop batch. If the backlog grows beyond a host-configured threshold, the host SHOULD emit an alert. Automatic shedding is not part of this RFC.

## Transport adapters

Adapters are host-side, above the manager. v1 ships one; the rest are sketched to show the contract holds.

### HTTPS (v1)

```
POST /triggers/webhooks/:subscriptionId
```

- **No auth header**: the `subscriptionId` is the shared secret (long, unguessable). Apps that need HMAC verification implement it inside `handleIngest` and throw on mismatch.
- **Request body**: passed to `handleIngest(raw: <parsed JSON or text>)`.
- **Response**: 200 on successful commit, 400 if `handleIngest` throws (body carries the error), 404 if the subscription is unknown, 429 on host back-pressure.
- **Idempotency**: third-party retries land as fresh `ingest` calls; the app dedupes via its own `event.id` in `handleIngest`.

### Kafka (future)

- Adapter: one consumer per `(subscription, topic)` or one shared consumer with per-message subscription resolution (implementation choice).
- `raw`: the raw message record.
- `handleIngest` returns 0..N events; the adapter commits the offset only after `ingest` commits.

### Cron (future)

- Adapter: a scheduler that fires `ingest(subscriptionId, { firedAt })` at the cron cadence declared in the subscription's `params`.
- No third-party call; the trigger's `handleIngest` typically returns `[{ firedAt }]` unchanged.

### Poller (future)

- Adapter: a per-subscription timer that calls a **poll hook** on the trigger definition (`poll?(state, ctx) → { events, nextState }`), passes the resulting `events` through `ingest`, and persists the returned `nextState` on the subscription.
- `poll` is not part of `handleIngest`; it is an additional lifecycle hook orthogonal to inbound-driven triggers. Adding it is a future extension — this RFC pins only the inbound-driven shape.

## API endpoints (host, HTTPS adapter)

Host implementations SHOULD expose:

```
POST   /apps/:id/triggers/:key/subscriptions   — create a subscription
GET    /workflows/:id/subscriptions            — list a workflow's subscriptions
GET    /subscriptions/:id                       — read (metadata + params + state summary)
DELETE /subscriptions/:id                       — unsubscribe

POST   /triggers/webhooks/:subscriptionId       — public inbound webhook (no auth header; id is the secret)

GET    /subscriptions/:id/events                — dispatch history (for UI + debugging)
POST   /trigger-events/:eventId/requeue         — manual dead-letter requeue
```

Auth: all except the public webhook endpoint sit behind the host's usual bearer auth.

## Conformance

A host conforms to this RFC when:

- **Registry** — `app_triggers` (or equivalent) mirrors `app_actions`; a registered app exposes its declared triggers via `GET /apps/:id`.
- **Subscribe lifecycle** — `subscribe()` calls `onSubscribe`; if it throws, no subscription is persisted. `unsubscribe()` calls `onUnsubscribe` before deleting; hook failures are logged but do not block deletion.
- **Persist-first ingest** — a `POST /triggers/webhooks/:subscriptionId` that returns 200 has produced at least one row in `trigger_events` with `status ∈ { received, dispatching, dispatched, failed }`.
- **At-least-once dispatch** — for every persisted event with `status: received | dispatching`, the dispatcher eventually calls the subscriber (workflow start) or moves the event to `failed` after ≥ 5 attempts.
- **Retry classification** — engine-level errors classified as non-retryable skip retries.
- **Concurrency safety** — two dispatchers running against the same event store return disjoint pending sets from `drainPending`.
- **Workflow integration** — a workflow whose `trigger` is `{ type: "event", subscriptionId }` is started by the dispatcher with `run.trigger === "webhook"` (or a future-added tag) and the event's normalized payload accessible as `trigger.event` in the run scope.

The reference test fixtures for the manager + HTTPS adapter constitute the executable version of this contract.

## Open questions

1. **Multiple workflows per subscription.** v1 restricts `subscriptionId → single workflowId`. Do we (a) keep this and require duplicate subscriptions for multi-workflow fan-out, or (b) allow N workflows per subscription with independent retry state each? (b) matches Zapier's shape but complicates `markDispatched` (needs per-subscriber state).
2. **Poll trigger lifecycle.** Add `poll(state, ctx)` and a poller adapter to this RFC now, or split to `trigger-polling.md`? Poll triggers introduce cursor state, per-subscription timers, and a different failure mode (transient poll failure vs. permanent).
3. **Idempotency at the manager level.** Should `ingest` accept an optional `dedupeKey` and drop duplicates before calling `handleIngest`? Convenient for the HTTPS adapter (some providers include a delivery id), but conflicts with app-level dedupe.
4. **Event schema evolution.** When a trigger's `output` shape changes across app versions, do stored events carry the app version they were normalized against?
5. **Subscription-level enable/disable vs. workflow-level.** Pausing a workflow disables all its subscriptions; pausing a subscription disables events into that workflow. Which is authoritative when both toggle?
6. **HMAC / signing convention.** Should the RFC standardize a signing hook (`verifySignature?(headers, rawBody) → boolean`) instead of leaving it to `handleIngest`? Standardization means the adapter can reject before `handleIngest`, saving compute; the cost is a second hook per trigger.

## Status ladder

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze.
- `Final` — frozen for `manifestVersion: "1"`. Breaking changes require a new RFC and a `manifestVersion` bump.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.
