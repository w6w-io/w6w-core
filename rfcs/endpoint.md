# RFC: Endpoint

**Status:** Draft
**Author:** Segev Shmueli
**Date:** 2026-07-19

## Summary

An **Endpoint** is a named, stable **callable entry point** that dispatches to exactly one
**Callable** — a *reference* to either a [Function](./function.md) or a [Workflow](./workflow.md).
The Callable is a two-arm discriminated union (`{ kind:"function" }` | `{ kind:"workflow" }`) that
unifies *what you call*, not *how it runs*: a Function target resolves synchronously to a value, a
Workflow target enqueues an asynchronous run and hands back a run handle to poll. An Endpoint
declares an optional inbound `input` contract and an optional, **declarative-only** `exposure`
descriptor. It sits one level above both primitives — the single reference a caller binds to so that
the thing behind it (a Function today, a Workflow tomorrow, a swapped implementation of either) can
change without breaking the caller. Endpoints target `manifestVersion: "2"`.

## Motivation

The platform has two distinct things a caller can invoke, with two different execution models:

1. A [Function](./function.md) — a vendor-abstracted single operation that returns a **value
   synchronously** through the `invokeFunction` choke point.
2. A [Workflow](./workflow.md) — a DAG of steps that runs **asynchronously** as a checkpointed
   [Run](./workflow.md#run-state), enqueued via `enqueueRun` and polled through `GET /runs/:id`.

A caller that wants to name "the thing that notifies a customer" should not have to know, or care,
whether that thing is currently a one-shot Function or a multi-step Workflow — nor rewire itself the
day it is promoted from one to the other. There is no stable, model-level reference that fronts both.
That is the gap an **Endpoint** fills:

- An operator names an entry point **once**, points its `target` at a Function or a Workflow, and
  every caller binds to the Endpoint id.
- When the implementation behind it changes — a Function is promoted to a Workflow, or a Function's
  `impl` is swapped (see the [Function vendor-swap invariant](./function.md#the-vendor-swap-invariant))
  — the Endpoint id, `key`, and `input` contract are unchanged and callers keep working.
- The **Callable** union makes the execution-model difference explicit in the *result*, rather than
  hiding it: a Function target answers with an inline `output`; a Workflow target answers with a
  `runId` the caller polls. The abstraction unifies the reference; the envelope is honest about the
  model.

## Goals

- Define the **Callable** contract — a discriminated union
  `{ kind:"function"; function } | { kind:"workflow"; workflow }` — as the shared, stable *reference*
  to a Function or a Workflow.
- Define the **Endpoint** shape — `id`/`key`/`target`/`input?`/`exposure?` — as the named entry point
  that carries one Callable `target`.
- Pin the **dispatch table and result envelope**: a `function` target dispatches synchronously to
  [`invokeFunction`](./function.md#invocation) and returns `{ kind:"function", output }`; a `workflow`
  target enqueues an asynchronous run and returns `{ kind:"workflow", runId }`.
- Reuse the platform's existing input primitive: `input` is a core [`Param`](./param.md)`[]`, the same
  shape a Function's `inputs` and an Action's params use.
- Record the **exposure model** as a *declarative* field and **fence** it: v0 reaches every Endpoint
  only at the internal `POST /endpoints/:id/invoke`; custom public paths and per-Endpoint auth are
  escalated across the open/closed seam, not baked.
- Be **serialization-agnostic** — JSON renderings are illustrative, not the format.

## Non-Goals

The following are explicit v0 boundaries. Each is modeled so it can grow later without a breaking
change.

- **Custom public exposure paths and per-Endpoint auth policy.** `exposure.http` (a custom path plus
  an `auth` policy) is a **declarative descriptor that no v0 route reads**. The only reachable surface
  is the internal `POST /endpoints/:id/invoke`, behind the same auth the existing API routes use. This
  is an outward-facing, tenancy-sensitive decision that crosses the STRATEGY §5.1
  open/closed seam and is **escalated, not baked** — see [Exposure](#exposure) and
  [Open questions](#open-questions).
- **Unifying the execution model.** v0 keeps the honest sync/async split (Function → value,
  Workflow → run handle). Making Function invokes optionally async, or awaiting a Workflow to
  completion for a uniform always-sync envelope, is deferred (see [Open questions](#open-questions)).
- **Nesting beyond one hop.** A Callable references a Function **or** a Workflow, never another
  Endpoint. Chained indirection (Endpoint → Endpoint) is out of scope.
- **The Function and Workflow primitives themselves.** The canonical interface / `impl` adapter /
  vendor-swap semantics live in the [Function RFC](./function.md); the graph, run state, and
  `WorkflowContext` live in the [Workflow RFC](./workflow.md). This RFC only *references* them.
- **Execution runtime, credentials, and the sandbox.** Dispatch funnels into the existing
  `invokeFunction` / `enqueueRun` paths, which own connection resolution, entitlement, credential
  injection, metering, and the runtime sandbox. An Endpoint never sees raw credentials.
- **A dedicated `endpoint_runs` record.** A Function-target invocation is already metered by the
  underlying Action; a Workflow-target invocation is recorded as a normal [Run](./workflow.md#run-state).
  Endpoint-level history parity is deferred.

## Concept

An Endpoint is a **named entry point holding one Callable reference**. Two halves:

1. **The reference** — `target`, a **Callable**: `{ kind:"function"; function: "fn_…" }` or
   `{ kind:"workflow"; workflow: "wf_…" }`. This is the stable indirection a caller binds to. The
   discriminant `kind` is what a host switches on to pick a dispatch path.

2. **The entry contract** — an optional `input` ([`Param`](./param.md)`[]`) describing the inbound
   payload, and an optional `exposure` descriptor. `input` omitted ⇒ the raw request body is passed
   through to the target unchanged.

```
caller ── binds to ──►  Endpoint (id / key / input)     (STABLE — survives a target change)
                              │
                          target: Callable  (kind: "function" | "workflow")
                              │
          ┌───────────────────┴───────────────────┐
   kind "function"                          kind "workflow"
   invokeFunction(fn, inputs)  (SYNC)       enqueueRun(wf, inputs)  (ASYNC)
          │                                        │
   { kind:"function", output }              { kind:"workflow", runId }
```

The Callable unifies the **reference**, not the **execution model**. A Function returns a value now;
a Workflow returns a run handle to poll. The result envelope carries the `kind` discriminant so a
caller can branch on the same tag it declared, rather than guessing whether it received a value or a
handle.

### Invocation

Invoking an Endpoint loads its definition, validates the inbound payload against `input` (when
declared), and dispatches on `target.kind`:

```
invokeEndpoint(endpointId, payload):
  ep      = load(endpointId)
  inputs  = ep.input ? validate(payload, ep.input) : payload      // omitted input ⇒ pass-through
  switch ep.target.kind:
    case "function":                                               // SYNC
      output = invokeFunction(ep.target.function, inputs)          // the Function choke point
      return { kind: "function", output }                          // 200
    case "workflow":                                               // ASYNC
      runId  = enqueueRun(ep.target.workflow, inputs)              // enqueue a checkpointed Run
      return { kind: "workflow", runId }                           // 202
```

The engine and choke points stay **host-free and unchanged** — an Endpoint is dispatch and a
reference, not a new engine. The `function` arm reuses the [Function invoke path](./function.md#invocation)
verbatim (which itself reuses the single-Action invoke path); the `workflow` arm reuses the existing
run-enqueue path. No credentials, source refs, or sandbox are touched at the Endpoint layer.

## Shape

```jsonc
{
  "manifestVersion": "2",
  "id": "ep_notify-customer",
  "key": "notify-customer",
  "displayName": "Notify Customer",
  "description": "Notify a customer through the configured operation.",

  // ── The Callable reference. Callers bind to the Endpoint; the target can change beneath them. ──
  "target": { "kind": "function", "function": "fn_send-email" },

  // ── The declared inbound contract. Reuses core Param[]. Omitted ⇒ pass-through to the target. ──
  "input": [
    { "key": "to",      "label": "To",      "type": "string", "required": true },
    { "key": "subject", "label": "Subject", "type": "string", "required": true },
    { "key": "body",    "label": "Body",    "type": "text",   "required": true }
  ],

  // ── DECLARATIVE ONLY in v0. No route reads this; the internal invoke path ignores it. ──
  "exposure": {
    "http": { "method": "POST", "path": "/hooks/notify-customer", "auth": "token" }
  }
}
```

**Promoting the target to a Workflow** replaces only `target`; `id`, `key`, and `input` stay:

```jsonc
"target": { "kind": "workflow", "workflow": "wf_notify-customer" }
```

Every caller that binds to `ep_notify-customer` is untouched — but the result envelope now returns
`{ kind:"workflow", runId }` (202) instead of `{ kind:"function", output }` (200), which is the honest
consequence of a synchronous op becoming an asynchronous run. Callers branch on the `kind` discriminant
to handle both.

### Field reference

#### Endpoint

| Field | Type | Required | Description |
|---|---|---|---|
| `manifestVersion` | string | ✅ | Core spec version. `"2"`, aligned with the [Workflow](./workflow.md) and [Function](./function.md) RFCs. |
| `id` | string | ✅ | Host-issued opaque id (`ep_…`). Stable across renames **and target changes**. |
| `key` | string | ✅ | Machine name. Unique per project/tenant. Lowercase, kebab-case. |
| `displayName` | string | ⬜ | Human-facing name. Falls back to `key`. |
| `description` | string | ⬜ | One-line summary. |
| `target` | [`Callable`](#callable) | ✅ | The Function or Workflow this Endpoint dispatches to. |
| `input` | [`Param`](./param.md)`[]` | ⬜ | The declared inbound contract. Reuses the Param RFC verbatim. Omitted ⇒ the raw payload is passed through to the target unchanged. |
| `exposure` | [`Exposure`](#exposure-descriptor) | ⬜ | **Declarative only in v0.** Describes an intended outward HTTP surface; no v0 route reads it (see [Exposure](#exposure)). |

#### Callable

The Callable is a discriminated union on `kind` — the shared, stable reference over a Function or a
Workflow:

```ts
type Callable =
  | { kind: "function"; function: string }     // → fn_…
  | { kind: "workflow"; workflow: string };    // → wf_…
```

| Arm | Discriminant | Ref field | Points at | Dispatch |
|---|---|---|---|---|
| Function | `kind: "function"` | `function` (`fn_…`) | a [Function](./function.md) | **synchronous** `invokeFunction` |
| Workflow | `kind: "workflow"` | `workflow` (`wf_…`) | a [Workflow](./workflow.md) | **asynchronous** `enqueueRun` |

#### Exposure descriptor

| Field | Type | Required | Description |
|---|---|---|---|
| `http.method` | `"POST"` \| `"GET"` | ⬜ | Intended HTTP method for a public surface. **Declarative only — not read by any v0 route.** |
| `http.path` | string | ⬜ | Intended custom public path (e.g. `/hooks/notify-customer`). **Declarative only.** |
| `http.auth` | `"none"` \| `"token"` \| `"tenant"` | ⬜ | Intended per-Endpoint auth policy. **Declarative only** — v0 applies the existing route auth, not this field. |

## Dispatch and the result envelope

Dispatch is a table keyed on `target.kind`. Each arm reuses an existing invoke path and returns a
`kind`-tagged envelope so the caller branches on the discriminant it declared:

| `target.kind` | Dispatch | Model | Result envelope | HTTP |
|---|---|---|---|---|
| `"function"` | `invokeFunction(target.function, inputs)` | **synchronous** — returns a value | `{ kind: "function", output }` | `200` |
| `"workflow"` | `enqueueRun(target.workflow, inputs)` | **asynchronous** — enqueues a [Run](./workflow.md#run-state) | `{ kind: "workflow", runId }` | `202` |

- **`output`** is the Function's canonical output — the value produced by the underlying
  [Function invocation](./function.md#invocation), already vendor-abstracted.
- **`runId`** is the id of the enqueued [Run](./workflow.md#run-state); the caller polls
  `GET /runs/:id` for progress and the terminal result. The Endpoint does **not** wait for the run.

The envelope's `kind` mirrors the `target.kind` that produced it, so a caller can dispatch on one tag
across both models — the whole reason the Callable discriminant is surfaced in the result rather than
flattened away.

## Exposure

**v0 fences exposure to a single internal route.** Every Endpoint is reachable **only** at
`POST /endpoints/:id/invoke`, behind the same authentication the existing API routes already enforce.
There are no custom public paths and no per-Endpoint auth policy in v0.

The `exposure.http` descriptor (custom `path`, `method`, and `auth`) is captured in the model as a
**declarative field that no v0 route reads**. It records *intent* — the shape a future outward-facing
surface would take — without any host behavior binding to it. A host that renders or stores an
Endpoint MUST NOT treat `exposure.http` as a live routing or authorization instruction in v0.

**Why it is fenced, not baked.** A publicly reachable entry point that runs a Function or a Workflow
is outward-facing and tenancy-sensitive: *who* may call an exposed Endpoint, and as *which
tenant/subject* it runs, sits squarely on the open/closed seam described in
the STRATEGY §5.1 — the boundary between the OSS spec/engine
and the private host that owns per-tenant auth, entitlements, and authorizers. Baking custom paths and
an `auth` policy into the contract ad hoc would push a host-owned, business-critical decision into the
open spec surface. This is registered as **HITL-1** (Endpoint exposure), whose **pinned default** is
exactly the fence above: v0 = internal `POST /endpoints/:id/invoke` under existing route auth. Dynamic
paths and per-Endpoint auth are promoted only when that decision is adjudicated — see
[Open questions](#open-questions).

## Conformance

A host that implements Endpoints MUST:

- Reach every Endpoint at the internal `POST /endpoints/:id/invoke` route, behind the same auth the
  existing API routes use, and **not** derive any routing or authorization behavior from
  `exposure.http` in v0.
- Validate the inbound payload against `input` when it is declared, and pass the raw payload through
  unchanged when `input` is omitted.
- Dispatch on `target.kind`: a `"function"` target through the synchronous
  [`invokeFunction`](./function.md#invocation) choke point returning `{ kind:"function", output }`; a
  `"workflow"` target by enqueuing a [Run](./workflow.md#run-state) and returning
  `{ kind:"workflow", runId }`, without awaiting the run.
- Preserve `id`, `key`, and the `input` contract across a change of `target`, so callers bound to the
  Endpoint id are never broken by a Function↔Workflow promotion or a Function `impl` swap beneath it.
- Route all dispatch through the same `invokeFunction` / `enqueueRun` paths used elsewhere — no
  parallel credential, source, or sandbox path at the Endpoint layer.

## Open questions

1. **Dynamic exposure (HITL-1).** Should an exposed Endpoint be reachable at a custom public path
   (e.g. `POST /hooks/notify-customer`) with a per-Endpoint `auth` policy (`none` / `token` /
   `tenant`), or is the single internal, already-authenticated route enough? v0 fences this to the
   internal route and treats `exposure.http` as declarative-only; the decision crosses the
   the STRATEGY §5.1 seam and is escalated as **HITL-1**, not
   baked here.
2. **Uniform envelope.** Should Function invokes be optionally async (returning a `runId`), and/or
   Workflows optionally awaited to completion (returning an inline `output`), to give Endpoints one
   uniform result contract? The **top-level Endpoint invoke** (`POST /endpoints/:id/invoke`) keeps
   the honest sync/async split keyed on `target.kind`. The **await-a-Workflow-to-completion** half of
   this question is now **resolved for the in-graph caller**: a `@w6w/call` node can await a Workflow
   (or a Function) sub-run and inject its `output` synchronously via the per-node `wait` flag — see
   [Amendment — per-node wait/no-wait](#amendment--2026-07-23-per-node-waitno-wait-f-3). Making the
   top-level Endpoint envelope itself uniform remains deferred.
3. **Callable nesting.** Should a Callable ever target another Endpoint (chained indirection) rather
   than only a Function or a Workflow? v0 says no — one hop, to a Function or a Workflow.
4. **Endpoint observability.** Rely on the underlying Action metering (function target) and
   [Run](./workflow.md#run-state) record (workflow target), or add a dedicated `endpoint_runs` record
   for Endpoint-level history? v0 relies on the existing records.

## Amendment — 2026-07-23: per-node wait/no-wait (F-3)

> This section is **additive**. It does **not** change the top-level `POST /endpoints/:id/invoke`
> dispatch table above (which keeps its honest sync/async split). It defines a second, in-graph way to
> reach a Callable — the [`@w6w/call`](./node-types.md#amendment--2026-07-23-the-w6wcall-host-node-f-3)
> host node — and resolves the **await-a-Workflow-to-completion** half of [Open-Q#2](#open-questions).

A Callable (a Function **or** a Workflow) can be invoked two ways:

1. **As a top-level Endpoint** — `POST /endpoints/:id/invoke`, dispatched on `target.kind`: a Function
   answers synchronously with `{ kind:"function", output }`, a Workflow answers with a run handle
   `{ kind:"workflow", runId }`. **Unchanged by this amendment.**
2. **As a step inside a parent workflow** — a `@w6w/call` node routed to the host capability
   [`ctx.invokeCallable`](./invocation.md#amendment--2026-07-23-the-ctxinvokecallable-seam-f-3). Here
   the caller chooses the model **per node** with a `wait: boolean` flag, **independent** of whether
   the target is a Function or a Workflow (HITL-5):

| `wait` | Behavior | Result injected into the parent graph |
|---|---|---|
| `true` | **Block** until the sub-run (Function **or** Workflow) completes. | The sub-run's `output`, merged under `steps.<nodeId>.output` — the **synchronous-await-subrun** semantic. |
| `false` | **Do not block** — return a run handle immediately and continue. | A run handle `{ runId }`; the caller polls `GET /runs/:id` for the terminal result. |

**Resolution of Open-Q#2 (partial).** Open-Q#2 asked whether a Workflow could be *awaited to
completion so it returns an inline `output`*. For the **in-graph caller** this RFC now **resolves it:
yes** — `wait: true` on a `@w6w/call` node awaits the sub-run (Function or Workflow alike) and injects
its `output` into the parent graph synchronously, so a parent step can read
`{ "$": "steps.<callNodeId>.output.…" }`. `wait: false` preserves the fire-and-continue run-handle
model. This makes `wait`/`no-wait` a per-node choice orthogonal to `target.kind`. The **top-level
Endpoint invoke envelope** is *not* changed — making it uniform stays deferred (see
[Open-Q#2](#open-questions)).

Because the in-graph caller reuses the same `invokeFunction` / `enqueueRun` paths as the Endpoint
dispatch table, no new engine, credential, source, or sandbox path is introduced — the wait vs
no-wait choice is a host concern owned by `ctx.invokeCallable`, not the engine.

## Status ladder

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze.
- `Final` — frozen for the current `manifestVersion`. Breaking changes require a new RFC and a
  `manifestVersion` bump.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.
</content>
</invoke>
