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
| `target` | [`Callable`](#callable) | ⬜ | The Function or Workflow this Endpoint dispatches to. Optional — an absent `target` is a **draft**; whether a draft is invocable is governed by the host-maintained `status` field, not by `target`'s presence alone — see [Amendment — 2026-08-14b](#amendment--2026-08-14b-explicit-completion-status-and-a-draft-answers-404). |
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

## Amendment — 2026-07-27: the `action` target arm

> This section is **additive**. It leaves the [Callable](#callable) union **unchanged** — a Callable
> is still one hop, to a Function or a Workflow ([Open-Q#3](#open-questions)), and `@w6w/call` is
> untouched. It widens only what an **Endpoint's `target`** may be.

An Endpoint may now dispatch directly to **one app Action**, without an intervening Function:

```ts
type ActionTarget = {
  kind: "action";
  uses: { app: string; action: string; connection?: string | null };
  with?: Record<string, unknown>;   // Endpoint input → the action's params
};

type EndpointTarget = Callable | ActionTarget;   // Endpoint.target
```

**Why.** The Function primitive exists to make an operation *vendor-abstractable* — a canonical
interface with a swappable `impl`. An operator who just wants "this named entry point runs this app
action" was forced to create a throwaway Function to carry the binding, which added a level of
indirection that abstracted nothing. The `action` arm removes that ceremony; promoting such an
Endpoint to a real Function or a Workflow later replaces only `target`, exactly like every other
target change, and `id`, `key`, and `input` are preserved so callers do not break.

**Shape and adapter.** `uses` is the same `{ app, action, connection? }` triple a workflow Step's app
arm and a Function's [`impl`](./function.md#adapter) use, and `with` is the same adapter mapping,
resolved by `resolveWith` against a scope carrying `{ inputs }` — so `{ "$": "inputs.to" }` reads the
Endpoint's declared `input`. **`with` omitted ⇒ the inbound payload is passed to the action as its
params unchanged**, matching the pass-through rule `input` already has.

**Dispatch.** The `action` arm is **synchronous**, like the Function arm, and routes through the same
single `invokeAction` choke point every other action path uses — which keeps ownership of connection
resolution, entitlement, tenantAuth, metering, and the sandbox. The result envelope gains a third arm:

| `target.kind` | Dispatch | Model | Result envelope | HTTP |
|---|---|---|---|---|
| `"action"` | `invokeAction(uses, resolveWith(with, { inputs }))` | **synchronous** — returns a value | `{ kind: "action", output }` | `200` |

Callers already branch on the `kind` discriminant; a caller that does not know the `action` tag sees
a new tag rather than a silently reshaped `function` result. `POST /run` maps this arm onto its
existing `{ kind: "action", value }` envelope, so that surface is unchanged.

**Unchanged by this amendment.** The Callable union, `@w6w/call` and `ctx.invokeCallable` (which
still take a Callable, not an `EndpointTarget`), the exposure fence (HITL-1), and the Function and
Workflow arms' behavior.

## Amendment — 2026-07-27: the universal invoke URL and inbound `security` (HITL-1, partial)

> This section **resolves the auth half of [Open-Q#1](#open-questions)** and leaves the *custom
> public path* half fenced. It does not change any dispatch semantics.

### One URL for everything runnable

Every runnable thing is reachable at a single path, keyed by URN:

```
POST <PUBLIC_BASE_URL>/invoke/<urn>          body: the payload, verbatim
POST <PUBLIC_BASE_URL>/invoke/conn_…?action=<key>
```

`urn` is a `conn_` / `fn_` / `wf_` / `ep_` id, and an internal router resolves the prefix to the
same runner the dedicated routes use — there is no new execution path, and no per-resource URL
vocabulary for a caller to learn. The body **is** the payload (no `{input}` envelope); `?action=`
names the app action, which only a connection URN needs. The pre-existing per-resource invoke routes
are unchanged.

A host MUST render an Endpoint's callable URL from its configured public base (the studio never
assembles a hostname), and this URL — not an internal path — is what an operator hands to a caller.

### Inbound `security`

`exposure` gains a **live** `security` block declaring how an inbound caller authenticates:

```jsonc
"exposure": {
  "security": { "auth": "header", "headerName": "X-API-Key", "headerValue": "…" }
}
```

| `auth` | Who may call | Runs as |
|---|---|---|
| `platform` (**default**, and the value assumed when `security` is absent) | a platform bearer token — a w6w token or a partner OIDC token, resolved to a Principal exactly as on every other route | the **caller** |
| `none` | anyone with the URL | the Endpoint's **owner** |
| `basic` | HTTP Basic matching `basicUser`/`basicPassword` | the Endpoint's **owner** |
| `header` | a request carrying `headerName: headerValue` | the Endpoint's **owner** |
| `jwt` | a Bearer JWT verified HS256 against `jwtSecret` | the Endpoint's **owner** |

The non-`platform` modes are exactly the modes the [`@w6w/webhook`](./trigger.md) trigger already
enforces on its public receive URL — deliberately the same set, verified by one shared implementation,
so an operator learns one inbound-security model for the whole platform.

**Conformance for an exposed Endpoint.** A host that implements `security` MUST:

- treat an absent `security` block as `platform`, so an Endpoint written before this amendment keeps
  its previous protection;
- run a **non-`platform`** invocation as the Endpoint's stored **owner** scope, never as a
  caller-supplied identity — a request that carries no platform identity cannot choose one;
- expose **only Endpoints** this way: a `conn_`/`fn_`/`wf_` URN always takes the platform path, so
  exposure is a deliberate per-Endpoint act rather than something a URN guess can reach;
- keep the configured secrets **write-only** — encrypted at rest, masked on read, and a save that
  echoes the mask preserves the stored value.

**Still fenced.** A custom public *path* (`exposure.http.path`) remains declarative-only: the callable
URL is always `/invoke/<urn>`. `exposure.http.method`/`auth` likewise stay legacy descriptors — the
live policy is `exposure.security`.

## Amendment — 2026-08-07: account-owned Endpoints and the `{account_slug}/{key}` address

> This section is **additive**. It does not change dispatch, the [Callable](#callable) union, the
> result envelope, the `action` target arm, or the inbound `security` model. It settles two things
> the model left implicit: **which owner** an Endpoint has, and **how many addresses** it has.
> Where it and the *Still fenced* clause of
> [Amendment — the universal invoke URL and inbound `security`](#amendment--2026-07-27-the-universal-invoke-url-and-inbound-security-hitl-1-partial)
> disagree about the number of system-defined callable URL forms, **this section governs**; every
> other clause of that amendment stands.

### An Endpoint belongs to the account

An Endpoint is owned by the **account** — the organization it lives in — not by the user who created
it. Its `key` is unique within that account: the uniqueness tuple is `(account, key)`. Every member
of the owning account sees, edits, and invokes the same Endpoint, and the second member to claim a
`key` is told it is taken rather than silently given a second Endpoint wearing the same name.

This follows from the address form below, not taste. `{account_slug}/{key}` names an account and
a key and nothing else. If a `key` were unique per **user**, that address would be under-determined:
two members of one account could each hold `notify-customer`, and the address would resolve
non-deterministically to one of them. Something that can resolve to more than one Endpoint is not an
address. A host MUST enforce `(account, key)` uniqueness at write time and refuse a colliding save
as a caller-visible conflict.

`project` is **not** part of Endpoint key uniqueness. An Endpoint may still record the project it
belongs to, but that field takes no part in the key and none in addressing. The reason is the same
one: the address form has **no project segment**, so leaving `project` in the uniqueness key is a
latent ambiguity with a fuse on it — it would fire the day projects start being written, turning a
well-defined address back into a non-deterministic one.

### `subject` survives as the *runs-as* identity

The *owning* axis moves to the account; the *executing* one does not move at all. `subject` stays on
the Endpoint, with unchanged values and a now-explicit meaning: it is the identity the Endpoint
**executes as** — its **runs-as** identity.

That distinction is load-bearing, not editorial. An invocation's execution scope is built from
`subject`, and connection resolution is per-subject: which stored credential an app action reaches
for follows from the runs-as identity and nothing else. An Endpoint with no runs-as identity has
nothing to execute as. The earlier amendment's rule that a non-`platform` invocation runs as the
Endpoint's **owner** scope is exactly this field, and is now stated precisely: it runs as the
Endpoint's `subject`.

**The corollary is the point: an account-owned Endpoint is not an account-owned credential.**
Ownership widens to the account; execution identity does not. A host MUST resolve connections
against the Endpoint's `subject` and MUST NOT synthesize an account-wide identity from the owner.

### `key` is immutable after first save

A host MUST treat `key` as **immutable** once the Endpoint has first been saved. `displayName` stays
freely editable — that is what a display name is for — and a genuine rename is create-new plus
delete-old, which is honest about what it does to callers.

The reasoning, because the rule is worth more than the rule: a URL built from a mutable name is not
an address. This RFC already attaches stability to `id` ("Stable across renames **and target
changes**", [field reference](#endpoint)), and [Conformance](#conformance) guarantees that `key`
survives a change of `target`, so callers bound to the Endpoint are never broken. Promoting `key`
to a public address without first making it stable would **invert** that guarantee: the friendly
address would become the fragile one and the opaque one the durable one — the exact inverse of
what a caller expects, and of what the id form exists to provide.

### Two address forms, and which of them is stable

The URN form remains canonical and is unchanged:

```
POST <PUBLIC_BASE_URL>/invoke/<urn>          body: the payload, verbatim
```

An Endpoint MAY **additionally** be reached by its owning account's slug and its key, on a host
configured as a tenant's domain:

```
POST <TENANT_DOMAIN>/invoke/{account_slug}/{key}
```

This is an **additional** addressing form, not a replacement. It relaxes exactly one earlier clause,
named here so the relaxation is not inferred: *"the callable URL is **always** `/invoke/<urn>`"*, in
the [universal invoke URL amendment](#amendment--2026-07-27-the-universal-invoke-url-and-inbound-security-hitl-1-partial).
There are now **two** system-defined forms rather than one. Nothing else in that clause moves: a
custom, per-Endpoint public *path* (`exposure.http.path`) remains declarative-only and still fenced.

**The URN form is the stable address.** `id` is host-issued and stable across renames and target
changes, so the URN is stable by construction. The key form is a **convenience address built over a
name**: it is stable only because of the immutability rule above, and only for as long as the
Endpoint and its account's slug both live. A host MUST keep an Endpoint reachable at its URN for as
long as the Endpoint exists — a key address never retires or rewrites the URN address — and MUST
render both forms from configured, host-side values rather than have a client assemble a hostname.

### The host may narrow, never widen

Where a tenant has a configured domain, a host MAY establish the **tenant** from the request host —
that is what a tenant domain is for. The trust rule is fixed:

**The credential is authoritative for authorization. The host may only narrow, never widen.**

- Credential and host agree → proceed.
- Credential and host disagree → **refuse**. A host MUST NOT let the request host select a tenant
  the credential does not carry. A host that did would let a caller pick whose data it reaches
  by picking a hostname.
- The host maps to no tenant — any unmapped host, including a default API origin → **no-op**: the
  credential's tenant stands. Host resolution may remove authority, never add it.

A refusal has two shapes, and they differ deliberately:

- **Unauthenticated caller → `404`**, generic, with **no echo** of the slug or the key, and
  indistinguishable from every other miss on this path (unknown slug, unknown key, wrong tenant, no
  entitlement). `{account_slug}/{key}` is short, human-chosen and guessable, where an opaque URN is
  not; a distinguishable refusal would turn the address into a directory of which organizations are
  customers and what their automations are called.
- **Already-authenticated caller → `403`** with a specific code. The caller has proved who it is, so
  there is no enumeration left to prevent, and a `404` answered to a valid credential is a support
  ticket that reads *"your API is broken"*.

Every failure on this path — a host/credential disagreement, an unknown slug, an unknown key, a
save colliding on `(account, key)` — MUST be reported as a 4xx with a machine-readable body. These
are caller-visible conditions, not host faults, and a host that reports one as a server fault denies
the caller the one thing that would let it correct the request.

**Unchanged by this amendment.** Dispatch and the result envelope; the [Callable](#callable) union
and the `action` target arm; `@w6w/call` and `ctx.invokeCallable`; the inbound `security` model and
its conformance rules; the fence on custom public paths; `id` as the caller's stable binding point
and the URN as the stable address; and the requirement that callable URLs be rendered host-side. No
field is removed, no field changes type, and no Endpoint that was valid before this section is
invalid after it.

## Amendment — 2026-08-14: an Endpoint with no target (the draft state)

> This section is **additive**, and it is the reconciling authority over four earlier passages that
> read as if `target` is always present: the field-reference `target` row ([`#endpoint`](#endpoint)),
> the Conformance bullet *"Dispatch on `target.kind`"* ([Conformance](#conformance)), the
> Summary/Concept phrasing that an Endpoint "dispatches to exactly one Callable" ([Summary](#summary))
> and "hold[s] one Callable reference" ([Concept](#concept)), and the Goals bullet that defines the
> Endpoint shape as carrying one Callable `target` without the `?` this document uses to mark an
> optional field ([Goals](#goals)). Where any of those and this section disagree about whether
> `target` must be present, **this section governs**. The field-reference row is the one pre-existing
> line this amendment rewrites (below); the Conformance, Summary/Concept, and Goals passages stand
> unedited and are read as describing an Endpoint that already has a `target` — this
> section is what now says a `target` need not be there yet. Nothing else moves: dispatch, the
> [Callable](#callable) union, the `action` target arm, the result envelope, the inbound `security`
> model, and the addressing rules of the preceding amendments are all unchanged, and every rule of
> theirs applies unmodified the moment an Endpoint's `target` is present.

### An Endpoint with no `target` is a draft

An Endpoint's `target` MAY be absent. A target-less Endpoint is not a placeholder or a client-side
form state — it is a **real, stored Endpoint**: it carries `id` and `key`, MAY carry `displayName`
and `description`, and MAY declare its `input` contract, exactly as a complete Endpoint does. What it
does not yet say is what it dispatches to. This is a **draft** — the state a host holds while an
operator names an entry point and shapes its inbound contract before wiring it to a Callable or an
`action`. Nothing about how a draft is stored, owned, or keyed differs from a complete Endpoint; only
`target` is missing.

### Presence of `target` is the whole distinction

There is no `status` field and no separate partial-create route. **Whether `target` is present is
the draft/ready distinction, in full** — a draft becomes ready the instant a valid `target` is saved
onto it, and nothing else about the Endpoint changes when it does. A `status` enum and a dedicated
partial-create endpoint were both weighed and rejected: either introduces a second place to record
the same fact, one that can drift from what `target` itself says and leave a host trusting the wrong
one.

**Optional is not unvalidated.** A `target` that is present but malformed is still rejected exactly
as [Conformance](#conformance) already requires. This amendment only adds one new valid state — total
absence — it does not relax validation of a `target` that is there.

### Conformance for a draft

A host that implements the draft state MUST:

- **Refuse to invoke a draft before dispatch**, at every address form this RFC defines —
  `POST /endpoints/:id/invoke` ([Exposure](#exposure)),
  `POST <PUBLIC_BASE_URL>/invoke/<urn>` ([the universal invoke URL](#one-url-for-everything-runnable)),
  and `POST <TENANT_DOMAIN>/invoke/{account_slug}/{key}` ([the account-key address](#two-address-forms-and-which-of-them-is-stable))
  — answering **422** with the machine-readable code **`endpoint_incomplete`**, never a 5xx. There is
  no `target.kind` to dispatch on, so reaching the dispatch table with a draft would be a host bug;
  refusing first, before any dispatch attempt, is what keeps that bug from ever surfacing as a
  caller-visible server fault. This is the same discipline the addressing rules already commit to —
  *"Every failure on this path… MUST be reported as a 4xx with a machine-readable body"*
  ([The host may narrow, never widen](#the-host-may-narrow-never-widen)) — applied to the one failure
  that can occur before any tenant or credential check runs at all.
- **Hold the draft's key.** `(account, key)` uniqueness
  ([An Endpoint belongs to the account](#an-endpoint-belongs-to-the-account)) applies to a draft
  exactly as it applies to a complete Endpoint: saving a draft under a `key` claims that name in the
  account, and a second member who tries to claim the same `key` is told it is taken. The alternative
  — a draft that does not yet hold its own name — would let a colleague finish theirs first and take
  the key out from under the operator who is still building the Endpoint. A draft is not less real
  for lacking a `target`; `(account, key)` uniqueness exists to make a `key` mean one Endpoint, and a
  draft is one.
- **Not advertise a draft on any derived, machine-facing surface it generates from Endpoints** — a
  generated tool list, a generated catalog, a generated API document, or any other surface a host
  builds by enumerating Endpoints for a consumer that is not a human operator. An entry that answers
  every call with `422 endpoint_incomplete` is worse than an absent one: it costs a machine caller a
  round trip a filtered list would have spared it for free. This is scoped to **derived,
  machine-facing** surfaces only — an operator-facing surface, such as the studio's own Endpoint list
  for a human still building the thing, is unaffected: a draft stays visible to the whole owning
  account and marked unfinished there, which is exactly what lets that operator find it again.

**Unchanged by this amendment.** Dispatch and the result envelope; the [Callable](#callable) union
and the `action` target arm; the inbound `security` model; `(account, key)` uniqueness and `key`
immutability for an Endpoint that already has a `target`; the URN and account-key address forms and
their stability; the exposure fence (HITL-1); and every rule governing an Endpoint that already has a
`target` — this amendment reaches only the state before one is saved. No field is removed, no field
retyped, and every Endpoint that was valid before this amendment is still valid after it: `target`
was already a permitted value and remains one, only no longer a required one.

## Amendment — 2026-08-14b: explicit completion `status`, and a draft answers 404

> This section is the reconciling authority over three passages of the
> [prior draft-state amendment](#amendment--2026-08-14-an-endpoint-with-no-target-the-draft-state)
> (dated 2026-08-14, no letter suffix):
> [`### Presence of \`target\` is the whole distinction`](#presence-of-target-is-the-whole-distinction) —
> **superseded on both of its claims**, that there is no `status` field and that presence of `target`
> is the draft/ready distinction in full — the first bullet of
> [`### Conformance for a draft`](#conformance-for-a-draft) — **superseded on the status code only**:
> `422` becomes `404`. That bullet's "never a 5xx", its list of address forms, and its reasoning for
> refusing before dispatch all stand unedited — and the third bullet of the same section (beginning
> "Not advertise a draft…") — **superseded on the status code only**: its illustrative sentence "An
> entry that answers every call with `422 endpoint_incomplete` is worse than an absent one" now reads
> under `404`, per [the refusal-status rule](#the-refusal-is-404-not-422-and-still-never-a-5xx) below;
> that bullet's scope to derived, machine-facing surfaces and its operator-facing exception stand
> unedited. Where any superseded passage and this section disagree, **this section governs**. The one
> pre-existing line this amendment rewrites is the field-reference `target` row under
> [Field reference](#field-reference) (`#### Endpoint`): it stands as read — an absent `target` still
> means a draft — and is only re-pointed at this section, because a *present* `target` is no longer
> sufficient on its own to make an Endpoint invocable. Every other amendment, and every other passage
> of the 2026-08-14 amendment besides the three named above, stands unedited — see *Unchanged by this
> amendment* below.

### `status` is host state, and the vocabulary is closed

An Endpoint carries a **`status`**, host-maintained, whose normative vocabulary is a **closed set of
exactly two values**:

| `status` | Meaning |
|---|---|
| `draft` | not invocable |
| `ready` | authorises dispatch |

There is no third value in v0. Completion is binary — the question `status` answers is "can this
run?", which has exactly two answers — and every additional value this section could have introduced
(`disabled`, `archived`, `published`, `error`, …) would be a new arm the invoke sink has to decide
refuse-or-run for, corresponding to no product concept that exists today. A value can be added later
without breaking a caller; none can be removed later, which is reason enough to keep the set to the
two the product actually needs. Consequently **`ready` is the only value that authorises dispatch**,
stated that way on purpose so the refusal predicate stays **total**: anything that is not exactly
`ready` refuses — including a value a future version of this spec introduces that a given host does
not yet recognize. A host MUST treat an unrecognized `status` as refuse, never as run.

`status` is **host state, not an authored manifest field**:

- it is **never accepted from a caller's request body** — a create or update payload that includes a
  `status` key has that key ignored, not honoured;
- a host **MUST derive it from the stored definition on every write**: `target` present ⇒ `ready`,
  `target` absent ⇒ `draft`;
- it does **not** appear as a row in the Endpoint shape in [Field reference](#field-reference) — the
  manifest a caller authors is unchanged by this amendment.

Two consequences follow directly. A caller cannot arm or brick an Endpoint by posting a `status`
value, because the host recomputes it from `target` on every write regardless of what was sent. And
the field-reference `#### Endpoint` table gains no new row for it: `status` lives beside the stored
Endpoint the host keeps, not inside the shape a caller writes.

### The disagreement rule — `status` and `target`, refusal wins

Two sources of truth now exist, by the same instruction that added `status`, so this section states
which wins:

> An Endpoint is invocable **iff** `status` is exactly `ready` **and** `target` is present. Where the
> two disagree — in either direction — the Endpoint is **not** invocable, and the host answers the
> same 404 it answers for any other draft.

This is the sentence that answers the objection the superseded section raised when it rejected a
`status` enum — that a second field is "a second place to record the same fact, one that can drift…
and leave a host trusting the wrong one." Under an AND, drift can only ever **withhold** a dispatch,
never **authorise** one: a `status` that wrongly reads `ready` while `target` is absent still cannot
make the Endpoint run, because there is still no `target.kind` to dispatch on; a `status` that
wrongly reads `draft` while a valid `target` is present costs a visible, correctable 404, never a
silent wrong dispatch. The failure mode is bounded on the safe side by construction — that is what
makes a second source of truth admissible at all.

### The refusal is `404`, not `422`, and still never a 5xx

Where the superseded [`### Conformance for a draft`](#conformance-for-a-draft) required **422**
`endpoint_incomplete`, a host MUST now answer **404** — at every address form that section already
enumerates: `POST /endpoints/:id/invoke` ([Exposure](#exposure)),
`POST <PUBLIC_BASE_URL>/invoke/<urn>` ([the universal invoke URL](#one-url-for-everything-runnable)),
and `POST <TENANT_DOMAIN>/invoke/{account_slug}/{key}`
([the account-key address](#two-address-forms-and-which-of-them-is-stable)) — with a machine-readable
body, and **never a 5xx on any door**. The reason to refuse before dispatch is unchanged from the
superseded section: there is no `target.kind` to dispatch on for a non-invocable Endpoint, so reaching
the dispatch table would be a host bug, and refusing first is what keeps that bug from ever surfacing
as a caller-visible server fault.

One clause is new, because 404 collides with a rule the superseded 422 never touched. On the
`{account_slug}/{key}` address, the refusal MUST be **the same generic body every other miss on that
address already returns** — [The host may narrow, never widen](#the-host-may-narrow-never-widen)
already requires one byte-identical body for every miss on that address (unknown slug, unknown key,
wrong tenant, no entitlement), precisely because the address is short and human-guessable. A
not-ready Endpoint joins that same undifferentiated set; it does not get a body of its own. On the
id/URN forms, which are opaque, the body MAY name the condition (e.g. `endpoint_incomplete`), exactly
as the superseded section allowed.

The consequence is stated once, because it is the human's call and not an oversight: **a caller
cannot distinguish "no such Endpoint" from "exists but unfinished."**

### What still governs, restated as this section's own rules

Three things the superseded section established are not merely left un-contradicted by this one —
they govern under this section exactly as they did under the last:

- A draft is a real stored Endpoint that **holds its `(account, key)`**:
  [`(account, key)` uniqueness](#an-endpoint-belongs-to-the-account) applies to it exactly as to a
  complete Endpoint, regardless of `status`.
- A draft is **not invocable** — `status: "draft"` is definitionally the non-invocable state under
  [the disagreement rule](#the-disagreement-rule--status-and-target-refusal-wins) above.
- A draft is **not advertised on any derived, machine-facing surface** a host generates by enumerating
  Endpoints — a generated tool list, a generated catalog, a generated API document, or any other
  surface built for a consumer that is not a human operator — while an **operator-facing** surface,
  such as the studio's own Endpoint list, still shows it, marked unfinished, to the whole owning
  account.

**Unchanged by this amendment.** Dispatch and the result envelope; the [Callable](#callable) union and
the `action` target arm; the inbound `security` model; `(account, key)` uniqueness and `key`
immutability for an Endpoint that already has a `target`; the URN and account-key address forms and
their stability; the exposure fence (HITL-1); the address forms and the "never a 5xx" and
machine-readable-body requirements the superseded [`### Conformance for a draft`](#conformance-for-a-draft)
bullet already established; and every rule governing an Endpoint whose `status` is `ready`. This
amendment reaches only the refusal status code (`422` → `404`) and the signal a host derives
completion from (`status`, computed from `target` on every write, in place of `target`'s presence
alone). No field is removed, no field retyped, and every Endpoint that was invocable before this
amendment is invocable after it, under an unchanged underlying condition now expressed through
`status` as well as `target`.

## Status ladder

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze.
- `Final` — frozen for the current `manifestVersion`. Breaking changes require a new RFC and a
  `manifestVersion` bump.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.

## Amendment — 2026-08-20: `retry`, `onError`, and `reroute`

> The [Field reference](#field-reference) `Endpoint` table above is **silent** on failure handling —
> no row states what a caller sees when `target` fails. This section fills that gap, additively:
> three new optional fields on `Endpoint`, none of them removing or retyping a row already in that
> table. The companion [Function RFC amendment of the same date](./function.md#amendment--2026-08-20b-retry-onerror-and-reroute)
> adds the identical shape to `Fn`, since an Endpoint has the same no-graph constraint on `reroute`
> a Function does.

`Endpoint` gains:

| Field | Type | Required | Description |
|---|---|---|---|
| `retry` | `RetryPolicy` | ⬜ | Attempt policy for this call. Absent ⇒ one attempt. Reuses the workflow [Step](./workflow.md#step)'s `RetryPolicy` verbatim (`maxAttempts`, `backoff?`, `delayMs?`). |
| `onError` | `"fail" \| "continue"` | ⬜ | Applied only after `retry` and `reroute` are exhausted. Absent ⇒ `"fail"`. Deliberately **narrower** than a workflow step's `OnError`: `continue-record` has no meaning without a run's `stepErrors` state. |
| `reroute` | `ErrorReroute` | ⬜ | Failure re-dispatch: `{ target: Callable, with? }`. Absent ⇒ none. `target` is a [`Callable`](#callable) reference — never an `Edge.when: "error"`, because an Endpoint has no graph to carry an edge on. |

**Execution order**, the sequence a conforming host implements — identical to the Function RFC's:

1. Attempt the call, up to `retry.maxAttempts` times (default `1` — no retry).
2. On final failure, if `reroute` is present: invoke `reroute.target` — mapping `{ inputs, error }`
   onto its inputs through `reroute.with` if given, or passing `inputs` through unchanged otherwise
   — and return **that** target's dispatch result as this Endpoint's own result. `retry` is not
   re-applied to the reroute target itself.
3. Otherwise, apply `onError`: `"fail"` (the default) propagates the error, exactly as today;
   `"continue"` resolves the invocation with a `null` output instead of throwing.

**Unchanged by this amendment.** `target`, the [Callable](#callable) union and the `action` target
arm, [Dispatch and the result envelope](#dispatch-and-the-result-envelope), the inbound `security`
model, and every other field in the [Field reference](#field-reference) table above. No field is
removed, no field retyped, and an Endpoint with no `retry`/`onError`/`reroute` behaves exactly as it
did before this amendment.

## Amendment — 2026-09-08: `enabled`, an independent, caller-settable invocability term

> This section is the reconciling authority over five passages, plus one closing paragraph of
> [Amendment — 2026-08-14b](#amendment--2026-08-14b-explicit-completion-status-and-a-draft-answers-404),
> that together read as if `status` and `target` are the whole invocability predicate. **`enabled`
> is a new, independent, caller-settable boolean**, ANDed alongside `status` and `target` — no
> existing field's vocabulary, derivation, or wire placement changes.
>
> - The [Field reference](#field-reference) `target` row (`:187`) is **extended, not superseded**:
>   an absent `target` still means a draft, and a present `target` is still not sufficient on its
>   own to make an Endpoint invocable — now for a second, independent reason.
> - The status table's [`draft` | not invocable](#status-is-host-state-and-the-vocabulary-is-closed)
>   row is **unchanged**: `status` still has exactly two values, still derived solely from `target`,
>   and `enabled` plays no part in its derivation.
> - [The disagreement rule](#the-disagreement-rule--status-and-target-refusal-wins) is **extended to
>   a third AND term** — see [The disagreement rule, extended to `enabled`](#the-disagreement-rule-extended-to-enabled)
>   below. This is the load-bearing change.
> - ["A draft is **not invocable**"](#what-still-governs-restated-as-this-sections-own-rules) is
>   **unchanged**: `target`'s absence still refuses regardless of `enabled`.
> - [Amendment — 2026-08-14b](#amendment--2026-08-14b-explicit-completion-status-and-a-draft-answers-404)'s
>   closing paragraph makes two claims. *"Every rule governing an Endpoint whose `status` is
>   `ready`"* is **narrowed by this section**: a `ready` Endpoint with a `target` present and
>   `enabled: false` is not invocable. *"Every Endpoint that was invocable before this amendment
>   [2026-08-14b] is invocable after it"* is a historical statement about that amendment's own
>   before/after, not about this one, and it **stands unedited** — this section reaches only
>   invocability from 2026-09-08 forward.
>
> Where any of the passages above and this section disagree, this section governs. Every other
> amendment, and every other passage of this RFC, stands unedited — see **Unchanged by this
> amendment** below.

### `enabled`: an independent, caller-settable third term

An Endpoint gains **`enabled`**, a boolean the caller sets directly, independent of `status` and
`target`. `status` is a structural fact the host computes from `target`; `enabled` is caller
**intent** — an operator's own decision to arm or disable an otherwise-complete Endpoint without
touching its `target` or losing its `(account, key)` binding. The two answer different questions
and can legitimately disagree: a `ready` Endpoint (valid `target`) can still be `enabled: false`,
and a `draft` Endpoint (no `target`) can still carry `enabled: true` with nothing yet to gate.

**Placement.** `enabled` is a **column beside the stored Endpoint** the host keeps, exactly where
[Field reference](#field-reference) already puts `status` — *"`status` lives beside the stored
Endpoint the host keeps, not inside the shape a caller writes"*
([Amendment — 2026-08-14b](#status-is-host-state-and-the-vocabulary-is-closed)). It is therefore
**not** a member of the wire shape this RFC's [Shape](#shape) illustrates, and the
[Field reference](#field-reference) `#### Endpoint` table gains no new row for it, for the identical
reason `status` gained none. Unlike `status`, `enabled` **is** caller-settable — but it is set
through that stored column, not through a key in the create/update payload.

**Default.** An Endpoint that has never been written with an explicit `enabled` is **`true`**. A
host MUST NOT silently withhold dispatch from an Endpoint whose owner never expressed an opinion:
every Endpoint that predates this amendment, and every Endpoint created without an explicit
`enabled`, keeps exactly the invocability it already had.

### `status` stays closed; `enabled` is a separate field

[Amendment — 2026-08-14b](#status-is-host-state-and-the-vocabulary-is-closed) already closed
`status` to exactly `draft` | `ready`, host-derived from `target` alone, and this amendment does not
reopen that set. `enabled` is **not** a third `status` value. `status` answers a structural
question — "does this Endpoint have a valid `target`?" — that the host alone computes and a caller
cannot influence; `enabled` answers an intent question — "does the owner want this Endpoint to run
right now?" — that only the caller can answer. Folding `enabled` into `status` would force one field
to carry two facts that change independently and can legitimately disagree, exactly the drift
[Amendment — 2026-08-14b](#status-is-host-state-and-the-vocabulary-is-closed) already reasoned about
for `status` and `target` themselves. Keeping `enabled` a separate field is what lets it vary on its
own axis without a write to one clobbering the other's fact.

### The disagreement rule, extended to `enabled`

[The disagreement rule](#the-disagreement-rule--status-and-target-refusal-wins) already established
that drift between `status` and `target` can only ever **withhold** a dispatch, never **authorise**
one. `enabled` joins as a third term under the identical argument, carried forward rather than
merely asserted to compose: a caller-set `enabled: false` withholds dispatch outright regardless of
`status`/`target`, and no combination of the three values can ever authorise a dispatch the other
two would refuse — an added AND term can only shrink the set of Endpoints that pass, never grow it.

> An Endpoint is invocable **iff** `status` is exactly `ready` **and** `target` is present **and**
> `enabled` is `true`. Where any of the three disagree — in any direction — the Endpoint is **not**
> invocable, and the host answers the same 404 it answers for any other non-invocable Endpoint.

### The refusal is `404`, consistent with the existing rule

A disabled Endpoint (`enabled: false`) refuses exactly as a `draft`, or a `status`/`target`
mismatch, already does: **404**, at every address form
[Amendment — 2026-08-14b](#the-refusal-is-404-not-422-and-still-never-a-5xx) already enumerates —
`POST /endpoints/:id/invoke` ([Exposure](#exposure)),
`POST <PUBLIC_BASE_URL>/invoke/<urn>` ([the universal invoke URL](#one-url-for-everything-runnable)),
and `POST <TENANT_DOMAIN>/invoke/{account_slug}/{key}`
([the account-key address](#two-address-forms-and-which-of-them-is-stable)) — never a 5xx. Both of
that section's body rules carry forward unedited: on the `{account_slug}/{key}` address, the
refusal MUST be **the same generic, byte-identical body every other miss on that address already
returns** ([The host may narrow, never widen](#the-host-may-narrow-never-widen)) — a disabled
Endpoint joins the same undifferentiated set as an unknown slug, an unknown key, or a draft; on the
opaque id/URN forms, the body MAY name the condition (e.g. `endpoint_disabled`).

**Unchanged by this amendment.** Dispatch and the result envelope; the [Callable](#callable) union
and the `action` target arm; `retry`/`onError`/`reroute`; the inbound `security` model;
`(account, key)` uniqueness and `key` immutability; the URN and account-key address forms and their
stability; the exposure fence (HITL-1); `status`'s closed two-value vocabulary and its derivation
from `target` alone — `enabled` plays no part in computing `status`; every rule governing a draft
Endpoint (`target` absent), which stays non-invocable regardless of `enabled`; and every Endpoint
written without an explicit `enabled`, which keeps its prior invocability under the default of
`true`. No field is removed, no field retyped, and the [Field reference](#field-reference) table
gains no new row.

## Amendment — 2026-09-08b: `status`, extended to a stored version under dispatch

> This section is the reconciling authority over five passages that together state the live
> invocability rule, extended here to define what `status` means when the definition under dispatch
> is a **stored past version** of an Endpoint rather than its live row:
>
> - The [Field reference](#field-reference) `target` row (`:187`) is **unchanged**: a version's own
>   `target` is read the identical way, and its presence or absence is what a draft/complete
>   distinction turns on for that version exactly as it does for the live row.
> - The status table's [`draft` \| not invocable](#status-is-host-state-and-the-vocabulary-is-closed)
>   row is **unchanged**: `status` still has exactly two values, and it is still derived from
>   `target` alone.
> - [Amendment — 2026-08-14b's disagreement
>   rule](#the-disagreement-rule--status-and-target-refusal-wins) is **extended**: for a stored
>   version under dispatch, the rule's `status` term is satisfied by that version's own
>   structurally-derived completeness rather than by the live parent row's stored `status` value.
>   This is the load-bearing change.
> - ["A draft is **not invocable**"](#what-still-governs-restated-as-this-sections-own-rules) is
>   **unchanged**: a version whose own `target` is absent is a draft under the identical rule, and
>   still refuses.
> - [Amendment — 2026-09-08's three-term
>   restatement](#the-disagreement-rule-extended-to-enabled) is **extended by the same clause**: its
>   `status` term reads the same way for a stored version as for the live row; its `enabled` term is
>   untouched, because `enabled` continues to be read from the live Endpoint, never from a version.
>
> Where any of the five and this section disagree, this section governs. Every other passage of this
> RFC stands unedited — see **Unchanged by this amendment** below.

### A stored version has no `status` of its own

[Amendment — 2026-08-14b](#status-is-host-state-and-the-vocabulary-is-closed) defines `status` as
host state, derived from the live Endpoint's own `target` on every write. A host MAY, at its own
discretion, keep a record of an Endpoint's **past** definitions, so that a caller can dispatch a
specific stored version rather than whatever the live row currently holds. Read literally, the
invocability rule stated so far is a predicate over the live row alone, and it says nothing about
what `status` means for a version that is not that row. This section closes that gap. It does not add
a new `status` value, and a stored version does not gain a `status` field of its own.

### The identical derivation, applied to the version's own `target`

When a host dispatches a **stored version** rather than the live definition, the `status` term of the
invocability rule is satisfied by applying the **identical derivation** `status` is itself computed
by — `target` present ⇒ complete, `target` absent ⇒ draft — to **that version's own stored `target`**,
never to the live row's `status` column. The live row's `status` describes the live row's own current
draft state; it has no bearing on a version that is not the live definition, and a host MUST NOT
substitute it for the version's own derived state.

> An Endpoint version is invocable **iff** that version's own `target` is present **and** the
> Endpoint's `enabled` is `true`. The `status` term of the live rule is satisfied by the same
> structural derivation `status` itself is computed by, applied to that version's own `target` —
> never by the live row's stored `status`, which describes the current draft and not the version
> under dispatch.

### Why the two cannot disagree

This is not a second rule that might drift from the first. The live `status` and a stored version's
derived completeness are two evaluations of the **same predicate** (`target` present ⇒ complete) over
the same field (`target`), read from two different rows. Neither value is ever written directly —
both are computed, on demand, from a `target` that already exists — so there is no independently
stored signal for either to drift against. This is a narrower case than
[Amendment — 2026-08-14b's disagreement
rule](#the-disagreement-rule--status-and-target-refusal-wins), which reasons about two genuinely
independent stored values (`status` and `target`) and shows their drift is safely bounded to
withhold-only; here there is a single predicate over a single field, so there is no second, drifting
value to bound in the first place — the same reasoning this RFC already relies on, carried one step
further rather than merely asserted.

### What this amendment does not define

Where and how a host stores a past version of an Endpoint's definition is host bookkeeping this RFC
leaves open, exactly as it already leaves open where `status` (`:700-701`) and `enabled`
(`:854-859`) themselves are stored.

**Unchanged by this amendment.** `status`'s closed two-value vocabulary and its derivation from
`target` alone; the live Endpoint's three-term invocability rule (`status` exactly `ready` **and**
`target` present **and** `enabled` `true`) and the fact that a draft — a definition whose `target` is
absent — remains not invocable; the 404 refusal and every address form it applies at; the
[Callable](#callable) union and its two arms; `(account, key)` uniqueness and `key` immutability; the
exposure fence (HITL-1); and the [Field reference](#field-reference) table, which gains no new row.
No field is removed, no field retyped, and every Endpoint whose live definition was invocable before
this amendment remains invocable after it, under an unchanged rule; this section only extends what
`status` means when the definition under dispatch is a stored version rather than the live row.

## Amendment — 2026-09-11: publish state, a fourth, independent invocability term

> This section is the reconciling authority over the three normative invocability sentences (each
> marked, in this RFC's own convention, with a bolded "iff") found by grepping for that mark, plus
> one closing paragraph that restates one of them:
>
> - [The disagreement rule — `status` and `target`, refusal
>   wins](#the-disagreement-rule--status-and-target-refusal-wins)'s own invocability sentence (`:706`)
>   is **already superseded** — by [Amendment — 2026-09-08](#amendment--2026-09-08-enabled-an-independent-caller-settable-invocability-term)'s
>   three-term restatement below, not by this section — and is named here only so the enumeration is
>   complete, per this section's own citation discipline.
> - [The disagreement rule, extended to
>   `enabled`](#the-disagreement-rule-extended-to-enabled)'s three-term invocability sentence (`:889`)
>   is **superseded on its own terms**: restated below with a FOURTH AND term. This is the
>   load-bearing change.
> - [A stored version's own invocability sentence](#the-identical-derivation-applied-to-the-versions-own-target)
>   (`:965`) is **unchanged**. A specific stored version, addressed by its own version number, is
>   dispatched by naming an exact snapshot directly — that is what pinning a version means — and its
>   invocability already turns solely on that version's own `target`, never on the live row's `status`
>   column ([Amendment — 2026-09-08b](#amendment--2026-09-08b-status-extended-to-a-stored-version-under-dispatch)).
>   Publish state is read from the live row exactly as `enabled` is (below), so a version-pinned
>   dispatch is exempt from it for the identical reason it is already exempt from the live `status`
>   column: it is not consulting the live row's derived facts at all.
> - [Amendment — 2026-09-08b](#amendment--2026-09-08b-status-extended-to-a-stored-version-under-dispatch)'s
>   own closing paragraph restates the **three**-term rule (`status` exactly `ready` **and** `target`
>   present **and** `enabled` `true`) as what "every Endpoint whose live definition was invocable
>   before this amendment" means. That is a historical statement about *that* amendment's own
>   before/after, exactly as [Amendment — 2026-09-08](#amendment--2026-09-08-enabled-an-independent-caller-settable-invocability-term)
>   already treated [Amendment — 2026-08-14b](#amendment--2026-08-14b-explicit-completion-status-and-a-draft-answers-404)'s
>   own closing paragraph — it **stands unedited**; this section reaches only invocability from
>   2026-09-11 forward.
>
> Where any of the passages above and this section disagree, this section governs. Every other
> amendment, and every other passage of this RFC, stands unedited — see **Unchanged by this
> amendment** below.

### Publish state: a fourth, independent invocability term

An Endpoint that has **never been published** is not invocable through the unversioned invoke path,
independent of `status`, `target`, and `enabled`. "Published" is not a field this RFC defines,
types, or reserves a storage slot for — it is **host state**, in the identical posture
[`function.md`](./function.md#fnimpl)'s own note takes for a Function's publish/enable gate: *"This
RFC deliberately defines no normative lifecycle or publish field… A host's own publish/enable gate…
is host state kept outside this manifest: this document does not name it, type it, or reserve a
storage slot for it."* This section departs from that posture in exactly one respect — it **names**
the state and states its invocability effect, because (unlike a Function or a Workflow) an
Endpoint's publish state is being given a normative invocability rule here, exactly as `status` and
`enabled` already are. It does **not** depart from it in the other two: publish state gains no row
in the [Field reference](#field-reference) table, is never accepted from a caller's create/update
payload, and this RFC reserves it no wire shape of its own — a host is free to keep it however it
already keeps `status` and `enabled` (a column, a side table, a computed view).

A concrete example of the state this section is about: a host that lets a caller build and iterate on
an Endpoint's `target` in draft, then explicitly **publish** a reviewed snapshot before it becomes
externally callable — exactly the same publish/version affordance
[Amendment — 2026-09-08b](#amendment--2026-09-08b-status-extended-to-a-stored-version-under-dispatch)
already assumes exists (it is what a "stored version" *is*). Before the first publish, no such
snapshot exists yet.

### The disagreement rule, extended to publish state

[The disagreement rule](#the-disagreement-rule--status-and-target-refusal-wins) and
[its extension to `enabled`](#the-disagreement-rule-extended-to-enabled) both already establish that
an added AND term can only **withhold** a dispatch, never **authorise** one. Publish state joins as a
FOURTH term under the identical argument, carried forward rather than merely asserted to compose: a
live Endpoint that has never been published withholds dispatch outright regardless of `status`,
`target`, or `enabled`, and no combination of the four values can ever authorise a dispatch the other
three would refuse.

> An Endpoint is invocable through the unversioned invoke path **iff** `status` is exactly `ready`
> **and** `target` is present **and** `enabled` is `true` **and** the Endpoint has been published at
> least once. Where any of the four disagree — in any direction — the Endpoint is **not** invocable,
> and the host answers the same 404 it answers for any other non-invocable Endpoint.

A host MAY offer a caller-declared bypass of this one term specifically (an explicit "run the live,
unpublished definition anyway" affordance) — this RFC neither requires nor forbids one, the same way
it is silent on whether a host offers any other operator override. Where a host does not offer one,
the rule above is unconditional.

### The refusal is `404`, consistent with the existing rule

A live Endpoint that has never been published refuses exactly as a `draft`, a `status`/`target`
mismatch, or `enabled: false` already do: **404**, at every address form
[Amendment — 2026-08-14b](#the-refusal-is-404-not-422-and-still-never-a-5xx) already enumerates —
`POST /endpoints/:id/invoke` ([Exposure](#exposure)),
`POST <PUBLIC_BASE_URL>/invoke/<urn>` ([the universal invoke URL](#one-url-for-everything-runnable)),
and `POST <TENANT_DOMAIN>/invoke/{account_slug}/{key}`
([the account-key address](#two-address-forms-and-which-of-them-is-stable)) — never a 5xx. Both of
that section's body rules carry forward unedited: on the `{account_slug}/{key}` address, the refusal
MUST be **the same generic, byte-identical body every other miss on that address already returns**
([The host may narrow, never widen](#the-host-may-narrow-never-widen)) — a never-published Endpoint
joins the same undifferentiated set as an unknown slug, an unknown key, a draft, or a disabled
Endpoint, for the identical reason: this address is short and human-guessable, and a distinguishable
body would disclose that a real Endpoint sits behind it. On the opaque id/URN forms, the body MAY
name the condition (e.g. `endpoint_not_published`).

**Unchanged by this amendment.** Dispatch and the result envelope; the [Callable](#callable) union and
the `action` target arm; `retry`/`onError`/`reroute`; the inbound `security` model; `(account, key)`
uniqueness and `key` immutability; the URN and account-key address forms and their stability; the
exposure fence (HITL-1); `status`'s closed two-value vocabulary and its derivation from `target`
alone; `enabled`'s default and independence from `status`; a stored version's own invocability rule
(`:965`, unchanged per the blockquote above) and everything
[Amendment — 2026-09-08b](#amendment--2026-09-08b-status-extended-to-a-stored-version-under-dispatch)
establishes about it; and every Endpoint written before this amendment existed, which keeps exactly
the invocability its `status`/`target`/`enabled` already gave it **if and only if** it has also been
published — a host introducing this gate for the first time is expected to treat "already published"
the same way it already treats any other pre-existing state, not to retroactively strand every
Endpoint that predates the concept. No field is removed, no field retyped, and the
[Field reference](#field-reference) table gains no new row.
