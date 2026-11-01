# RFC: Node Types & Routing

**Status:** Draft **Author:** w6w **Date:** 2026-07-09

## Summary

A workflow is a graph of **nodes** and **edges**. This RFC gives every node an explicit _kind_,
defines the _routing_ rule that maps a node to the processor that executes it, and reserves an
**internal pseudo-app** namespace (`@w6w/*`) for nodes the platform executes itself — flow control,
an inline-script runner, a data node, and triggers. It also promotes the **trigger** to a
first-class node kind and specifies the **per-node execution** contract: each node runs as an
individually addressable unit that records a **node-run** object.

It sits between [`action.md`](./action.md) (which owns the `type: "control"` action) and
[`workflow.md`](./workflow.md) / [`engine.md`](./engine.md) (which own the graph and its execution).

## Motivation

Today a step's kind is _implicit_: the engine decides "is this a control node?" by string-matching
`uses.app === "@w6w/control"`, and everything else is assumed to be a registered app. As the palette
grows — flow controls, a script runner, a data node, triggers — that single implicit branch does not
scale:

- There is no declared way to say _what a node is_ or _who executes it_.
- Internal behaviors (an `if`, a `loop`, "run this JS") have no home. They are neither registered
  apps nor, today, anything the host can dispatch.
- Triggers are modeled only as a `Workflow.trigger` field, not as nodes, even though the editor
  draws them on the canvas and users reason about them as the graph's entry point.
- A run executes as one opaque process. There is no per-node execution unit to start/stop, meter,
  retry, or scale independently.

## Goals

- A closed set of **node kinds** with a deterministic **routing** rule from a node to its processor.
- A reserved **internal pseudo-app** namespace so internal behaviors are dispatched through the
  _same_ invocation seam as apps (`ctx.invoke`), not a parallel code path.
- A first-class, required **trigger** node kind, with **manual** as the first system trigger.
- A **per-node execution** contract and a **node-run** record (start/end state, output, next-node
  refs, timing) so a node is an addressable, observable unit.

## Non-Goals

- The app manifest, action, param, and connection shapes — see their RFCs.
- App-declared triggers and subscription delivery — see [`trigger.md`](./trigger.md). This RFC adds
  only **system** triggers (manual).
- Re-architecting the reference engine's in-process run loop. The per-node execution contract is
  defined here and exposed as a host primitive; migrating the orchestrator to drive nodes
  _exclusively_ through it is a follow-up.
- Secure multi-tenant JS execution hardening beyond a deny-all sandbox.

## Concept

### Node kinds

Every node in a workflow has exactly one kind, **derived from `uses.app`**:

| Kind       | `uses.app`                 | Executed by                              | Examples                               |
| ---------- | -------------------------- | ---------------------------------------- | -------------------------------------- |
| `app`      | a registered app id        | app runtime (`registry.load` → `invoke`) | `io.w6w.sendgrid` · `send-email`       |
| `control`  | `@w6w/control`             | **host** (decision) + engine (traversal) | `if` · `foreach` · `parallel` · `wait` |
| `internal` | `@w6w/script`, `@w6w/data` | the **host's internal API**              | run JS · set typed vars                |
| `trigger`  | `@w6w/trigger`             | the host (entry node)                    | `manual`                               |

`control` and `internal` are both **internal pseudo-apps** — reserved ids in the `@w6w/*` namespace
with no registry entry. **Every node — apps and controls alike — routes through the one invoke
seam.** A control node is an app too: its _decision_ (did the `if` match? what are the `foreach`
items?) is computed by the host via `invokeAction`, exactly like an app action; the engine keeps
only the resulting _traversal_ (running the `then`/`else`/`body`/`branches` sub-blocks, skipping
downstream edges, suspending on `wait`). `internal` and `trigger` are leaf computations the host
runs with no traversal at all.

### Routing

Routing is a pure function of `uses.app`, applied uniformly to every node:

```
route(node):                                  // in the host's invokeAction
  if isInternalApp(node.uses.app)  -> host internal processor   (@w6w/control decision,
                                                                  @w6w/script, @w6w/data, @w6w/trigger)
  else                             -> app runtime (registry.load → invoke)

isInternalApp(app) = app starts with "@w6w/"    // reserved namespace
```

Every node's action reaches the host the same way: the engine (or the per-node endpoint) calls
`ctx.invoke` / `invokeAction`, which inspects the app id and dispatches to an internal handler when
it is reserved, else to the registry. This is the single routing choke point — there is no parallel
code path for controls.

### Reserved internal pseudo-apps

| Id             | Action(s)                           | Input (`with`)        | Output (decision/value)    | Processor                    |
| -------------- | ----------------------------------- | --------------------- | -------------------------- | ---------------------------- |
| `@w6w/control` | `if`, `foreach`, `parallel`, `wait` | control-specific      | `{matched}`/`{items}`/…    | host (engine does traversal) |
| `@w6w/script`  | `run`                               | `{ code, input? }`    | script return value        | host sandbox                 |
| `@w6w/data`    | `set`                               | `{ vars: DataVar[] }` | `{ <key>: <typed value> }` | host                         |
| `@w6w/trigger` | `manual`                            | `{}`                  | the start payload          | host (entry)                 |

`DataVar = { key: string; type: "string"|"number"|"boolean"|"json"; value: unknown }`.

The `@w6w/` prefix is reserved: no registered app id may begin with it.

## Shape

A node is a `Step` (the graph's vertex) plus the kind derived from its `uses.app`. No new field is
added to the wire model — the kind is _computed_, keeping `manifestVersion: "2"` workflows valid.

```json
{
  "manifestVersion": "2",
  "id": "wf_demo",
  "name": "demo",
  "trigger": { "type": "manual" },
  "steps": [
    { "id": "start", "uses": { "app": "@w6w/trigger", "action": "manual" } },
    {
      "id": "shape",
      "uses": { "app": "@w6w/script", "action": "run" },
      "with": { "code": "return { ok: true, at: input };" }
    },
    {
      "id": "vars",
      "uses": { "app": "@w6w/data", "action": "set" },
      "with": { "vars": [{ "key": "env", "type": "string", "value": "prod" }] }
    },
    {
      "id": "notify",
      "uses": { "app": "io.w6w.sendgrid", "action": "send-email", "connection": "conn_123" },
      "with": { "to": { "$": "steps.vars.output.env" } }
    }
  ],
  "edges": [
    { "from": "start", "to": "shape" },
    { "from": "shape", "to": "vars" },
    { "from": "vars", "to": "notify" }
  ]
}
```

### Field reference (derived, not stored)

| Field  | Type                                      | Required     | Description                                      |
| ------ | ----------------------------------------- | ------------ | ------------------------------------------------ |
| `kind` | `"app"｜"control"｜"internal"｜"trigger"` | ✅ (derived) | Computed from `uses.app`; selects the processor. |

## Ports & cardinality

By default a node has **one** input port and **one** output port: it accepts a single incoming edge
and exposes a single outgoing port. A node MAY declare a different **cardinality** through an
**optional** `ports` object on its `Step`:

```json
{
  "id": "join",
  "uses": { "app": "@w6w/control", "action": "aggregate" },
  "ports": { "in": 3, "out": 1 },
  "with": { "mode": "array" }
}
```

### Field reference (stored)

| Field       | Type   | Required | Description                                                                                                           |
| ----------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `ports`     | object | ⬜       | Declared port cardinality. Omitted ⇒ `{ in: 1, out: 1 }`.                                                             |
| `ports.in`  | number | ⬜       | Max incoming edges this node accepts. Defaults to `1`. `> 1` opts the node into accepting **multiple** inbound edges. |
| `ports.out` | number | ⬜       | Number of outgoing ports this node exposes. Defaults to `1`.                                                          |

Semantics:

- **Omitted ⇒ `{ in: 1, out: 1 }`.** The default reproduces today's single-in / single-out step
  exactly, so `ports` is purely opt-in.
- `in > 1` declares a **fan-in** node — one that accepts more than one incoming edge (e.g. a
  flow-control aggregator that joins several upstream branches; see
  [`@w6w/control` · `aggregate`](./action.md#w6wcontrol--aggregate)).
- `out` defaults to `1`; a node exposes one outgoing port unless it declares otherwise. (Branching
  controls like `if`/`foreach`/`parallel` route through their sub-block semantics rather than raw
  out-ports; `out` describes the node's static port count, not its dynamic fan-out.)
- Authoring tools render the declared number of ports on the node — one input handle when `in: 1`, a
  multi-input handle when `in > 1`, and likewise for outputs.

**Additive & backward-compatible.** `ports` is a new **optional** field; workflow definitions are
JSON, so existing `manifestVersion: "2"` workflows — every one of which is implicitly single-in /
single-out — remain valid and unchanged with **no migration**. A host that does not understand
`ports` reads a step as `{ in: 1, out: 1 }`, which is exactly the pre-existing behavior.

## Triggers as nodes

Every workflow **must** have a trigger. A workflow with no declared `trigger` is treated as
**manual** (`{ type: "manual" }`) — the host defaults it at registration so the invariant always
holds.

A trigger is also drawn as a node (`uses.app === "@w6w/trigger"`) — the graph's entry point.
Executing a trigger node yields the run's start payload (for `manual`, an empty object or
caller-supplied input), which downstream nodes read as `steps.<triggerId>.output`. The
`Workflow.trigger` field and the trigger node are two views of the same fact; the field is
authoritative for _how a run is launched_ (see [`trigger.md`](./trigger.md)), the node is its
position in the DAG.

Only **manual** is defined here. `schedule` and `event` remain as in [`trigger.md`](./trigger.md);
app-declared triggers are out of scope.

## Per-node execution & node-run objects

A node is an individually addressable unit of execution. The host exposes a primitive to execute
**one** node against a supplied **start state** and record the result — enabling start/stop, tight
quality control, metering, and independent scaling.

### Contract

```
executeNode(workflow, nodeId, startState) -> NodeRun
```

1. Resolve the node and its `with` against `startState` (expression bindings like
   `{ "$": "steps.x.output.y" }` read from the state; literals pass through).
2. Route by `uses.app` and run the node's operation with the resolved input.
3. Merge the node's output into the state under `steps.<nodeId>.output`, yielding the **end state**.
4. Compute **next** — the node ids to run next. For most nodes this is the node's outgoing edges; a
   flow-control node may narrow or reorder it (e.g. `if` picks the matched branch). `next` is an
   **array** so `foreach`/`parallel` fan-out and multi-target routing are expressible.

### NodeRun

| Field                      | Type                      | Description                                 |
| -------------------------- | ------------------------- | ------------------------------------------- |
| `id`                       | string                    | Synthetic node-run id.                      |
| `workflowId`               | string                    | Owning workflow.                            |
| `nodeId`                   | string                    | The node executed.                          |
| `runId`                    | string｜null              | Enclosing workflow run, when part of one.   |
| `status`                   | `"succeeded"｜"failed"`   | Terminal outcome.                           |
| `startState`               | object                    | The incoming state.                         |
| `endState`                 | object                    | The state after merging this node's output. |
| `output`                   | unknown                   | The node's operation result.                |
| `error`                    | `{ code, message }`｜null | Set on failure.                             |
| `next`                     | string[]                  | Node ids to execute next.                   |
| `startedAt` / `finishedAt` | timestamp                 | Timing.                                     |

A node-run is the atomic execution record. It complements `node_executions` (per-step checkpoints
inside an orchestrated run): the orchestrator's long-term direction is to drive a run _as_ a
sequence of node-runs.

## Conformance

A host claiming this RFC MUST:

- Reject registration of an app whose id begins with `@w6w/`.
- Route **every** node by `uses.app` per **Routing** through one invoke seam — controls included: a
  `@w6w/control` node's decision is computed by the host, not a separate engine path.
- Default a trigger to `{ type: "manual" }` when a registered workflow declares none.
- Execute `@w6w/script`·`run` with no ambient authority (no network, filesystem, or environment
  access).
- Record a NodeRun for each per-node execution with start/end state and `next`.

## Resolved questions

| Question                                                                             | Decision                                                                                                                                |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Should `@w6w/control` route through the host seam rather than staying engine-native? | **Yes.** A control node's _decision_ is computed by the host via `invokeAction` (uniform routing); the engine keeps only the traversal. |

## Open questions

1. Does `@w6w/script` need a declared output schema for downstream `{ "$": … }` binding, or is it
   always dynamic?
2. Should `next` carry edge labels (e.g. `then`/`else`) rather than bare ids?
3. Should the orchestrator drive a run _as_ a sequence of per-node HTTP executions (start/stop,
   independent scaling) rather than one in-process loop calling `invokeAction`? The routing is
   already uniform; this is a deployment-topology change.

## Status ladder

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze.
- `Final` — frozen for the current `manifestVersion`.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.

## Amendment — 2026-07-23: the `@w6w/call` host node (F-3)

> This section is **additive** to the node kinds, routing, and reserved-pseudo-app tables above; it
> introduces no breaking change. It reserves one more id in the `@w6w/*` namespace and routes it
> through the existing single invoke seam. It is a self-contained addition alongside
> [Ports & cardinality](#ports--cardinality) — the two amend independent parts of this RFC.

`@w6w/call` is a new **internal host node**: an `@w6w/*` pseudo-app the platform executes itself to
**invoke a `Callable`** — a reference to either a [Function](./function.md) or a
[Workflow](./workflow.md) (see the [Endpoint RFC · Callable](./endpoint.md#callable)). It is the
in-graph caller for one workflow calling another workflow, or a workflow calling a Function, as a
single step. Like `@w6w/control`, `@w6w/script`, `@w6w/data`, and `@w6w/trigger`, it is a **host**
node with host capabilities — **not** a sandboxed `packages/apps` app. No registered app id may
begin with `@w6w/`, so `@w6w/call` can never collide with a catalog app.

### Kind & routing

`@w6w/call` slots into the existing tables as an **internal** kind that routes through the one
invoke seam — there is no parallel code path:

| Kind       | `uses.app`  | Executed by                 | Examples                    |
| ---------- | ----------- | --------------------------- | --------------------------- |
| `internal` | `@w6w/call` | the **host's internal API** | call a Function or Workflow |

Routing is unchanged: `isInternalApp("@w6w/call")` is `true` (reserved `@w6w/` prefix), so
`ctx.invoke` / `invokeAction` dispatches it to the host's internal processor rather than the
registry. That processor routes the node to a **new host capability**,
[`ctx.invokeCallable`](./invocation.md#amendment--2026-07-23-the-ctxinvokecallable-seam-f-3),
exactly as an app action routes to `ctx.invoke` and a function-step routes to `ctx.invokeFunction`.

### Reserved internal pseudo-app

| Id          | Action(s) | Input (`with`)                                | Output                                                             | Processor                   |
| ----------- | --------- | --------------------------------------------- | ------------------------------------------------------------------ | --------------------------- |
| `@w6w/call` | `call`    | `{ target: Callable, input?, wait: boolean }` | `wait` ⇒ the sub-run output · `no-wait` ⇒ a run handle `{ runId }` | host (`ctx.invokeCallable`) |

- `target` is a **Callable** (`{ kind:"function"; function } | { kind:"workflow"; workflow }`),
  resolved within the **same project** as the calling workflow (HITL-D). It is independent of
  `wait`.
- `input` is the resolved payload passed to the target (the same shape a Function's `inputs` or a
  Workflow run's start payload expects). Expression bindings (`{ "$": "steps.x.output.y" }`) resolve
  against the run scope like any other node's `with`.
- `wait: boolean` is a **per-node** choice (HITL-5), independent of whether `target` is a Function
  or a Workflow:
  - **`wait: true`** — block until the sub-run (Function **or** Workflow) completes, then merge its
    output into the parent graph under `steps.<nodeId>.output`, readable by downstream
    `{ "$": "steps.<id>.output.…" }` expressions. This is the new **synchronous-await-subrun**
    semantic resolved in the
    [Endpoint RFC](./endpoint.md#amendment--2026-07-23-per-node-waitno-wait-f-3).
  - **`wait: false`** — return a **run handle** (`{ runId }`) immediately and continue the parent
    graph without blocking; the caller polls `GET /runs/:id` for progress and the terminal result.

The host stays the boundary owner: the engine never loads a Function or Workflow, resolves a
connection, or touches the sandbox — it asks `ctx.invokeCallable`. This mirrors how a normal step
never sees credentials and asks `ctx.invoke`.

### Conformance (additive)

A host that implements `@w6w/call` MUST:

- Classify a node whose `uses.app === "@w6w/call"` as an **internal** kind and route it through the
  one invoke seam to `ctx.invokeCallable` — never by loading the target inside the engine.
- Resolve `target` to a Callable in the **same project** as the calling workflow and reject a
  cross-project target (HITL-D).
- Honor the per-node `wait` flag: on `wait: true`, await the sub-run and expose its output as the
  node's `output`; on `wait: false`, return `{ runId }` without awaiting.

## Amendment — 2026-08-11: the `@w6w/document` host node (F-3)

> This section is **additive** to the node kinds, routing, and reserved-pseudo-app tables above; it
> introduces no breaking change. It reserves one more id in the `@w6w/*` namespace and routes it
> through the existing single invoke seam — it adds **no** new host capability, so unlike the
> 2026-07-23 triple it has no companion amendment in [`invocation.md`](./invocation.md). It is a
> self-contained addition alongside
> [Amendment — 2026-07-23: the `@w6w/call` host node](#amendment--2026-07-23-the-w6wcall-host-node-f-3)
> — the two reserve independent ids and amend nothing of each other.

`@w6w/document` is a new **internal host node**: an `@w6w/*` pseudo-app the platform executes itself
to **read one document, by key, from the run's own document store**. It is the in-graph way to pick
a document _at run time_: its `key` is an ordinary expression-capable `with` value, so it can come
from a trigger input or an upstream step's output — which the static `documents.<key>` path in the
run scope (see the [Workflow RFC](./workflow.md#run-scope-roots)) cannot express. Like
`@w6w/control`, `@w6w/script`, `@w6w/data`, `@w6w/trigger` and `@w6w/call`, it is a **host** node
with host capabilities — **not** a sandboxed `packages/apps` app. No registered app id may begin
with `@w6w/`, so `@w6w/document` can never collide with a catalog app.

Its output is data like any other step's, and its usual companion is a `render` part in a downstream
step's `with` pointing at `steps.<id>.output.content` — the document's `{{ }}` placeholders are
rendered by the engine's expression pass, not by this node (see
[Workflow RFC — the multipart expression envelope and the `render` part
kind](./workflow.md#amendment--2026-08-11-the-multipart-expression-envelope-exprvalue-and-the-render-part-kind-f-3)).
`@w6w/document` is **read-only in v1**: `get` is its only action, and there is no `set` or `upsert`.

### Kind & routing

`@w6w/document` slots into the existing tables as an **internal** kind that routes through the one
invoke seam — there is no parallel code path:

| Kind       | `uses.app`      | Executed by                 | Examples               |
| ---------- | --------------- | --------------------------- | ---------------------- |
| `internal` | `@w6w/document` | the **host's internal API** | read a document by key |

Routing is unchanged: `isInternalApp("@w6w/document")` is `true` (the reserved `@w6w/` prefix), so
`ctx.invoke` / `invokeAction` dispatches it to the **host's internal node processor** — the same
processor that runs `@w6w/script` and `@w6w/data` — rather than to the registry. The engine never
reads the document store itself; it asks the host through the seam it already uses for every node.

### Reserved internal pseudo-app

| Id              | Action(s) | Input (`with`) | Output                     | Processor |
| --------------- | --------- | -------------- | -------------------------- | --------- |
| `@w6w/document` | `get`     | `{ key }`      | `{ key, format, content }` | host      |

- `key` is an ordinary **expression-capable** string: it resolves against the run scope exactly like
  any other `with` value, so `{ "$": "steps.start.output.template" }` and a multipart `ExprValue`
  are both valid and a literal string is the degenerate case. The resolved string names the
  document's `key` — not its id.
- **There is no `project` param.** The document is resolved under the run's own
  `(tenant, subject, project)` — the workflow's own project — never a caller-supplied one. A
  run-time string naming a project would arrive at the store as data and let one run read another
  project of the same tenant; the run's own project is the only scope this node needs.
- The output is `{ key, format, content }`: `key` echoes the resolved key, `format` is the stored
  document's format, and `content` is the document's body — the **parsed JSON** when `format` is
  `"json"`, the raw string otherwise. Downstream reads it as
  `{ "$": "steps.<id>.output.content.body" }`, or `{ "$": "steps.<id>.output.content" }` for a
  non-JSON document. The parsed content is deliberately **not** spread at the top level: a document
  whose own JSON carries a `key` or a `format` field would collide with the envelope if it were.

### Open/closed seam

`@w6w/document` sits on the same open/closed boundary as `@w6w/call` and `ctx.invoke` (STRATEGY
§5.1). The **contract** — the `@w6w/document` node kind and its reserved id constant — is declared
in the open `@w6w/workflow-types` and surfaced by `@w6w/ui`; the **implementation** (document-store
access, project scoping, entitlement) is provided by the **closed server host**. No capability
implementation crosses the seam: the engine holds only the reserved id and routes to the host, so
the OSS engine stays host-free while the private host owns how a document is actually found — the
identical split already used for `ctx.invoke`, `ctx.invokeFunction` and
[`ctx.invokeCallable`](./invocation.md#amendment--2026-07-23-the-ctxinvokecallable-seam-f-3).

### Conformance (additive)

A host that implements `@w6w/document` MUST:

- Classify a node whose `uses.app === "@w6w/document"` as an **internal** kind and route it through
  the one invoke seam to the host's internal node processor — never by reading the document store
  inside the engine.
- Resolve `with.key` against the run scope before the node runs, exactly as it resolves any other
  `with` value, and treat the resolved string as the document's `key`.
- Resolve the document under the **run's own** `(tenant, subject, project)`, and accept no
  caller-supplied project.
- Return `{ key, format, content }` on success, with `content` the parsed JSON when `format` is
  `"json"` and the raw string otherwise.
- **Fail the step** when no document matches the resolved key, with an error whose message
  **contains that key** — never a success carrying an empty or null output.
- Reject a `@w6w/document` node naming any action other than `get`. The node is read-only in v1; a
  host MUST NOT add a `set` or `upsert` action under this id.

## Amendment — 2026-08-20: the call-depth bound on `@w6w/call` (F-3)

> This section is **additive** to the
> [`@w6w/call` amendment](#amendment--2026-07-23-the-w6wcall-host-node-f-3) above; it introduces no
> breaking change and reserves no new id. It narrows one thing that amendment left open: nothing in
> it bounds how deep a `@w6w/call` chain — or a Function-arm step, which shares the same
> `ctx.invokeFunction` seam — may go. Grepping this file
> (`grep -n "@w6w/call\|invokeCallable\|sub-run" core/rfcs/node-types.md | awk -F: '$1>=276 &&
> $1<=340'`)
> surfaces every line of that section touching the mechanism; of those, the following state or imply
> an unbounded chain because they describe a hop being dispatched without ever naming a limit on how
> many may compose:
>
> - `:286` — "the in-graph caller for **one workflow calling another workflow**" describes
>   composition with no stated bound on how many hops may chain.
> - `:310` — the request-shape row (`{ target: Callable, input?, wait: boolean }`) carries no depth
>   or fuel field of any kind.
> - `:319` — `wait: true` "**block[s] until the sub-run … completes**" with no stated ceiling on how
>   many nested `wait: true` hops that block may stack.
> - `:323-324` — `wait: false` "**return[s] a run handle … immediately**" and the parent
>   "**continue[s] … without blocking**" — the exact shape that lets a self-referencing no-wait
>   chain flood the run queue silently, unbounded, rather than blow a stack.
> - `:332-339` — the full conformance MUST list obligates routing, project-scoping, and the `wait`
>   contract, but states no obligation to bound composition depth at all.
>
> The remaining grep hits (`:276`, `:283-285`, `:289`, `:293`, `:298`, `:300`, `:303`, `:312`,
> `:327`) are structural — a title, a table header, a routing statement, or the boundary-owner
> paragraph — and neither state nor imply a bound one way or the other; they are listed here for
> completeness of the grep, not because they assert anything about depth.

A host that implements `@w6w/call` — and, identically, a Function-arm step (`ctx.invokeFunction`,
the same seam a plain `{ uses: { function } }` step and a `@w6w/call` function target both dispatch
through) — MUST bound the **composition depth** of a chain:

- Every hop increments a `callDepth` counter by exactly one: a `@w6w/call` step dispatching to
  either a Workflow or a Function target, and a Function-arm step, are each one hop. The counter is
  **not** part of the node's own `with`/`input` — it travels with the dispatch, not with
  author-supplied, forgeable data.
- A hop whose depth would exceed the bound is **refused before dispatch** — no Function runs, no run
  is enqueued, no sub-run executes — with a distinct, recognisable error (host-side:
  `call_depth_exceeded`). The refusal MUST map to a 4xx status, never 5xx: an intermediary that
  replaces an origin 5xx with an opaque error page (e.g. Cloudflare's CORS-less HTML substitution)
  would otherwise turn a deliberate, bounded refusal into an unexplained "failed to fetch".
- The bound is **host-configurable** with a default of **16** (the reference implementation reads
  `W6W_MAX_CALL_DEPTH`, falling back to 16 when absent, unparseable, or less than 1).
- The bound MUST be enforced identically whether the hop that reaches the limit is a `wait: true`
  (synchronous, in-process) or `wait: false` (enqueue-and-return) `@w6w/call` dispatch — the depth
  MUST survive an enqueue hop, not just an in-process call stack. Without that, a self-referencing
  `wait: false` chain never blows a stack; it floods the run queue silently until resources are
  exhausted, which is the dangerous shape this bound exists to catch.
- This bound is orthogonal to, and does not replace, a host's own static cycle detection over a
  **single** workflow's own graph (e.g. a topological-sort check over one workflow's declared node
  edges): that check cannot see a `@w6w/call` target named as a string inside a node's `with`
  payload, so it catches a different class of mistake than this bound does.

**Deliberately out of scope for this amendment — a per-root-run fuel budget.** A depth counter
bounds how DEEP a chain nests; it does not bound how WIDE a shallow chain fans out — sixteen sibling
`wait: false` calls at depth 1, each fanning out sixteen more at depth 2, is still only depth 2 and
produces 256+ enqueued runs. Closing that residue needs a shared budget threaded across the whole
call tree (e.g. a `root_run_id` and a per-root counter), which is a materially larger change (a new
identity column, a shared/atomic counter, and a decision about where that counter lives and how it
is charged) than the in-process, per-hop counter this amendment specifies. It is deliberately
deferred rather than built speculatively alongside this bound.

The rest of this RFC — including every line the blockquote above enumerates — stands unedited: this
amendment adds a bound: it does not withdraw, contradict, or need any prior line to be rewritten,
because none of them claimed a chain was unbounded; they simply predated the question.

## Amendment — 2026-08-29: `yaml` documents parse into a document node's `content` (F-3)

> This section is **additive** to the
> [`@w6w/document` host node amendment](#amendment--2026-08-11-the-w6wdocument-host-node-f-3) above;
> it introduces no breaking change and reserves no new id. Unlike the 2026-08-20 amendment above, it
> **does** supersede a claim made twice in that section's own text — found by grep, not memory:
> `/usr/bin/grep -n 'parsed JSON' rfcs/node-types.md` returns exactly two hits at authoring time,
> `:396-397` ("the **parsed JSON** when `format` is `"json"`, the raw string otherwise") and
> `:424-425` ("Return `{ key, format, content }` on success, with `content` the parsed JSON when
> `format` is `"json"` and the raw string otherwise"). Both said `content` is the raw string for
> every format other than `json`; that is no longer true for `format: "yaml"`. The rest of the RFC
> is unaffected, but it does **not** stand unedited in exactly those two places.

A `format: "yaml"` document's `content` is now **parsed YAML** (`@std/yaml`, `{ schema: "core" }`),
of the identical shape as the pre-existing `json` rule beside it: a successful parse replaces
`content`; a parse failure falls back to the raw string rather than failing the step.
`text`/`markdown`/`html` still land verbatim, unconditionally — this amendment narrows only the
`json`-or-raw-string claim, for the one additional format.

**The empty-document consequence.** `parse("")`, `parse("# comment only")` and `parse("\n")` all
return `null` under `@std/yaml` (`{ schema: "core" }`), so a blank or comment-only `format: "yaml"`
document's `content` is now `null` — not the raw (empty or whitespace) string a `text`/`markdown`
document with the same bytes would still produce. This is a deliberate, fail-loud consequence of
giving `yaml` the _identical_ shape as `json` (an empty or malformed `json` document's degenerate
cases were never special-cased either): a host MUST NOT add a `null`-guard that falls back to the
raw string for `yaml` alone, since that would make the two parsed formats disagree on how they
handle their own degenerate input — precisely the class of silent format-branch drift this amendment
exists to close off.

### Conformance (additive)

A host that implements `@w6w/document` MUST additionally:

- Return `{ key, format, content }` with `content` the parsed **YAML** when `format` is `"yaml"` and
  it parses, the raw string on a parse failure — the identical shape as the pre-existing `json`
  rule, independently implemented rather than through a shared parser module (the host's
  document-node code and its run-scope seed code sit on either side of the `api`/`bll` layering
  boundary, ADR-0001).
- Parse a `format: "yaml"` document under a schema equivalent to `@std/yaml`'s `"core"` schema — one
  that keeps a top-level YAML merge key (`<<`) literal rather than folding it — so that a host's
  parsed `content` and any client-side field picker mirroring this gate agree on which keys a `yaml`
  document declares.
- Treat a parse that succeeds with the value `null` (a blank or comment-only `format: "yaml"`
  document) as a successful parse, not a parse failure: `content` is `null`, never the raw string,
  in that case.

## Amendment — 2026-08-29: the `@w6w/template` host node (F-3)

> This section is **additive** to the node kinds, routing, and reserved-pseudo-app tables above; it
> introduces no breaking change. It reserves one more id in the `@w6w/*` namespace and routes it
> through the existing single invoke seam — it adds no new host capability beyond that one node, and
> amends nothing any prior amendment in this file states.

`@w6w/template` is a new **internal host node**: an `@w6w/*` pseudo-app the platform executes itself
to compile a Handlebars `template` string against a bound `values` object and return the rendered
string. Its purpose is portability: a workflow author writes one template with workflow-agnostic
placeholder names (`{{customer_name}}`, `{{order_id}}`), then binds each placeholder's _value_ per
use — a trigger's payload in one workflow, an upstream step's output in another — without touching
the template text itself. Like `@w6w/control`, `@w6w/script`, `@w6w/data`, `@w6w/trigger`,
`@w6w/call` and `@w6w/document`, it is a **host** node with host capabilities — not a sandboxed
`packages/apps` app. No registered app id may begin with `@w6w/`, so `@w6w/template` can never
collide with a catalog app.

### Kind & routing

| Kind       | `uses.app`      | Executed by                 | Examples                     |
| ---------- | --------------- | --------------------------- | ---------------------------- |
| `internal` | `@w6w/template` | the **host's internal API** | render a Handlebars template |

Routing is unchanged: `isInternalApp("@w6w/template")` is `true` (the reserved `@w6w/` prefix), so
`ctx.invoke` / `invokeAction` dispatches it to the **host's internal node processor** — the same
processor that runs `@w6w/script`, `@w6w/data` and `@w6w/document` — rather than to the registry.
`classifyNode` needs no new arm to recognise it: it already classifies every `@w6w/*`-prefixed id as
`internal` through `isInternalApp`, and `@w6w/template` is one more id under that same prefix, not a
new branch in that function.

### Reserved internal pseudo-app

| Id              | Action(s) | Input (`with`)         | Output       | Processor |
| --------------- | --------- | ---------------------- | ------------ | --------- |
| `@w6w/template` | `render`  | `{ template, values }` | `{ result }` | host      |

- `template` is a Handlebars template string. Placeholder names are workflow-agnostic — a template
  is written once and reused across workflows whose upstream shapes differ, which is the property
  this node exists to give an author.
- `values` is an ordinary object, resolved against the run scope before the node runs exactly like
  any other `with` value — a whole upstream step's output, or a trigger's payload, may be bound to
  it directly. Each top-level key of `values` becomes a top-level placeholder root the template may
  reference (`{{data.to}}` reads `values.data.to`).
- The output is `{ result }`, where `result` is the rendered string. Downstream reads it as
  `{ "$": "steps.<id>.output.result" }`.

### Open/closed seam

`@w6w/template`'s seam argument is `@w6w/script`'s, not `@w6w/document`'s. It needs **no**
privileged host resource — no database, no tenant/project scope — the `render` action is a pure
function of its two inputs. It sits on the closed side of STRATEGY §5.1 for a different reason:
compiling a caller-authored `template` string means compiling a caller-authored **function**
(Handlebars' `compile()` does `new Function` under the hood), and `values` can carry
attacker-influenced run data (a webhook payload, bound through the picker). That is a **sandboxing**
question, not a data-access one — the same risk shape `@w6w/script` already carries, and the reason
`@w6w/template` needs its own dedicated sandbox rather than running in-process the way
`@w6w/data`/`@w6w/http` do. The **contract** — the `@w6w/template` node kind and its reserved id
constant — is declared in the open `@w6w/workflow-types` and surfaced by `@w6w/ui`; the
**implementation** (the sandboxed compile/render mechanism) is provided by the **closed server
host**. No capability implementation crosses the seam: the engine holds only the reserved id and
routes to the host.

### Conformance (additive)

A host that implements `@w6w/template` MUST:

- Classify a node whose `uses.app === "@w6w/template"` as an **internal** kind and route it through
  the one invoke seam to the host's internal node processor — never by rendering inside the engine.
- Resolve `with.values` against the run scope before the node runs, exactly as it resolves any other
  `with` value, and pass the resolved object as `values`.
- **Fail the step** when the template references a value that resolves to undefined — never return a
  success carrying a blank substitution. The error's message MUST contain the missing key's name, so
  a run's failure names what was missing rather than merely that something was.
- Render `{{ }}` placeholders **HTML-escaped** and `{{{ }}}` placeholders **raw**. A host MUST NOT
  ship the opposite default (escaping `{{{ }}}` or leaving `{{ }}` unescaped): a template author
  relies on `{{ }}` being safe to place inside HTML output without a second thought.
- Reject a `@w6w/template` node naming any action other than `render`.

This amendment does not specify **how** a host compiles or sandboxes the template — that mechanism
is host implementation detail, deliberately deferred, and stays out of the conformance list above. A
conforming host may choose any sandboxing approach, provided it never renders in-process alongside
live connections and decrypted secrets.

## Amendment — 2026-09-19: the `language` param on `@w6w/script`·`run` (F-1)

> This section is **additive** to the node kinds, reserved-pseudo-app, and Conformance material
> above; it introduces no breaking change and edits none of the following, which **stand unedited**,
> superseded in reading by this amendment — identified here by table/row/column rather than
> reproduced verbatim, so that a whole-file search for any of their exact wording still returns
> exactly the one hit each already has today, proving none of the three moved:
> - the [Node kinds](#node-kinds) table's `internal` row, in its **Examples** column — two items
>   separated by a middle dot: running JavaScript code, then setting typed workflow variables;
> - the [Reserved internal pseudo-apps](#reserved-internal-pseudo-apps) table's `@w6w/script` row, in
>   its **Input (`with`)** column — a two-key object: a required `code` string and an optional
>   `input`;
> - the [Conformance](#conformance) section's bullet requiring a host to run `@w6w/script`'s `run`
>   action with no ambient authority, whose parenthetical names network, filesystem, and environment
>   access as the denied capabilities.
>
> None of the three is renamed, split, or excluded from this amendment's scope, this amendment names
> no fourth location, and it does not claim any of the three was itself edited — it restates and
> narrows their meaning in one place, deliberately without repeating their literal text anywhere in
> this file.

`@w6w/script`·`run` gains an optional `language` param: an enum, v1 values `"javascript"` and
`"python"`, defaulting to `"javascript"` when omitted. Its `with` shape is unchanged in cardinality —
still exactly the required code string plus the existing optional input, per the table above —
`language` is a third, optional sibling key on that same object, not a replacement for either
existing one. **Omitting `language` leaves every existing
step's behaviour byte-identical to today**: the node still runs its `code` as JavaScript, with the
same input/output contract, the same sandbox posture, and the same failure shape as before this
amendment existed. A workflow authored before this amendment, with no `language` key at all, is a
valid `language: "javascript"` step under it.

### Conformance (additive)

A host that implements the `language` param on `@w6w/script`·`run` MUST:

- Run `@w6w/script`'s `run` action under no ambient authority — no network, filesystem, or
  environment access — **as a property of the node, not of the JavaScript language alone**: the
  existing Conformance section's bullet on this point (above) binds identically whatever `language`
  says, for every v1 value including `"python"`.
- **Never** satisfy a non-`"javascript"` `language` by shelling out: a host MUST NOT invoke a real
  interpreter as a **subprocess**, nor otherwise hand step code OS-level process authority, to run a
  non-JavaScript step. `language` selects an execution mode inside the same no-ambient-authority
  sandbox the node already runs in — not a different privilege boundary.
- **Refuse an unrecognised `language` value before executing any code** — the same synchronous,
  pre-execution rejection this RFC already requires for the node's other malformed params (see the
  `@w6w/document` and `@w6w/template` amendments above), carrying the same error shape a host uses
  for its other internal-node param errors (the `{ code, message }` shape recorded on
  [NodeRun](#noderun)`.error`). A host never starts running step code on an unrecognised `language`
  and then fails partway through.
- Deny network access to the Python execution path in v1. This is a **deliberate v1 scoping
  decision**, not an inherent property of the Python language or of this RFC's sandbox model — a
  future amendment may widen it, and a host reading only this file MUST NOT treat the denial as
  permanent simply because no `language`-specific egress mechanism is specified here.

This amendment does not specify **how** a host executes non-JavaScript code — that mechanism (e.g.
which in-sandbox interpreter runs a `"python"` step) is host implementation detail, deliberately
deferred to the host's own engine work, exactly as this RFC already defers `@w6w/template`'s
compile/render mechanism above.

**Out of scope (F-5): no per-item execution mode.** `language` is a single axis selecting which
language a step's `code` runs as; it gains no second axis for "run once per item of a collection." A
workflow author who needs that wraps the `@w6w/script` step in a `foreach` sub-block — ordinary
graph composition already available via `@w6w/control`, not a property this amendment adds to
`language` itself. No spec field is added for a per-item mode.

## Amendment — 2026-10-07: unbounded `out`, `PortCount`, and field-wise ports resolution (P-1)

> This section is **additive**. It **supersedes** the following base text in
> [Ports & cardinality](#ports--cardinality), each quoted exactly; the base is left in place:
>
> 1. "By default a node has **one** input port and **one** output port: it accepts a single incoming edge and exposes a single outgoing port."
> 2. Field-table row `ports`: "Omitted ⇒ `{ in: 1, out: 1 }`."
> 3. Field-table row `ports.in`: "Max incoming edges this node accepts. Defaults to `1`." (the `in` default of `1` is **kept**; the type is now `PortCount`).
> 4. Field-table row `ports.out`: "Number of outgoing ports this node exposes. Defaults to `1`."
> 5. Semantics bullet "**Omitted ⇒ `{ in: 1, out: 1 }`.** The default reproduces today's single-in / single-out step exactly".
> 6. Semantics bullet "`out` defaults to `1`; a node exposes one outgoing port unless it declares otherwise." and its parenthetical "`out` describes the node's static port count, not its dynamic fan-out."
> 7. "A host that does not understand `ports` reads a step as `{ in: 1, out: 1 }`, which is exactly the pre-existing behavior." (a host that ignores `ports` now reads `{ in: 1, out: "many" }`; since the engine never reads ports, runtime behavior is unchanged).
> 8. The field type `number` on `ports.in` / `ports.out` (now `PortCount`).
>
> Wherever the base text above asserts `out: 1`, read this amendment instead. Every other line of the
> base section, including the example and the "Additive & backward-compatible" paragraph, stands
> unedited, except as read through items 1–8.

### Types

```ts
type PortCount = number | "many";
interface Ports { in?: PortCount; out?: PortCount }
```

A `PortCount` is an integer ≥ 0 or the sentinel `"many"` (unbounded). The sentinel is the only
serialized spelling of "unbounded"; tools may use `Infinity` in memory but MUST NOT serialize it.

### Defaults and meaning

| Field | Absent ⇒ | Meaning |
| --- | --- | --- |
| `in` | `1` | Max inbound edges the node accepts. `0` = **no inbound edge** is accepted (a root/trigger-like node). `> 1` or `"many"` = fan-in. |
| `out` | `"many"` | Max outgoing edges **per lane** (the success lane and the error lane are counted separately). A finite `out` is a cap; `"many"` is unbounded. |

So an omitted `ports` now means `{ in: 1, out: "many" }`: a step may feed any number of successors
(how they run is governed by [`Step.fanOut`](./workflow.md)), but still accepts one inbound edge.

### Resolution

Resolution is **field-wise**, per field, first present wins:
`Step.ports.x → Action.ports.x → App.ports.x → default`. An Action or App MAY declare `ports`
([action.md](./action.md), [app.md](./app.md)); a step-level field overrides only that field.

### Enforcement

Port counts are enforced by the **editor** and by **import validation** only. The engine never reads
`ports`; an edge past a finite `out` cap is refused at authoring/import time with a reason, not
silently dropped.

## Amendment — 2026-10-22: `NodeRun` versus `NodeExecution` (cross-reference)

> **Additive; no earlier sentence is edited.** Cross-reference to [Engine RFC — Amendment — 2026-10-22: run-record terms](./engine.md#amendment--2026-10-22-run-record-terms-are-nodes--nodeexecutionnodeid) and [Workflow RFC — Amendment — 2026-10-22: workflow vertices are `nodes`](./workflow.md#amendment--2026-10-22-workflow-vertices-are-nodes).

- [`NodeRun`](#noderun) **remains the executeNode record**, unchanged, with its `nodeId` field. It is not renamed.
- The run-state record is **`NodeExecution{nodeId}`**, held in canonical **`RunState.nodes`**; the wire also emits the `steps`/`stepId` aliases on read, and persisted columns are not renamed. These terms are stated once, in the Engine RFC.
- Wherever this file says "step" for a workflow vertex it means a **node** (`Workflow.nodes`; `steps.<id>` remains a permanent alias of `nodes.<id>`).

## Amendment — 2026-10-24: the `@w6w/model` host node (F-3)

> This section is **additive** to the node kinds, routing, and reserved-pseudo-app tables above; it
> introduces no breaking change. It reserves one more id in the `@w6w/*` namespace and routes it
> through the existing single invoke seam — the host performs the provider call, so, like the
> [2026-08-11 `@w6w/document` amendment](#amendment--2026-08-11-the-w6wdocument-host-node-f-3) and
> unlike the 2026-07-23 triple, it has no companion amendment in
> [`invocation.md`](./invocation.md).

`@w6w/model` is a new **internal host node**: an `@w6w/*` pseudo-app the platform executes itself to
talk to a **model provider** on the run's own account — one completion, a listing of a provider
connection's models, or a connection's remaining allowance. It is the in-graph way to call a model
_at run time_: its params are ordinary expression-capable `with` values, so the prompt can come from
a trigger input or an upstream step's output. Like `@w6w/control`, `@w6w/script`, `@w6w/data`,
`@w6w/trigger`, `@w6w/call`, `@w6w/document` and `@w6w/template`, it is a **host** node with host
capabilities — **not** a sandboxed `packages/apps` app. No registered app id may begin with `@w6w/`,
so `@w6w/model` can never collide with a catalog app.

Its output is data like any other step's: a downstream step reads
`{ "$": "steps.<id>.output.output" }` for the dialect-shaped result, or
`{ "$": "steps.<id>.output.usage" }` for the token accounting.

### Kind & routing

`@w6w/model` slots into the existing tables as an **internal** kind that routes through the one
invoke seam — there is no parallel code path:

| Kind       | `uses.app`   | Executed by                 | Examples                          |
| ---------- | ------------ | --------------------------- | --------------------------------- |
| `internal` | `@w6w/model` | the **host's internal API** | complete a prompt through a route |

Routing is unchanged: `isInternalApp("@w6w/model")` is `true` (the reserved `@w6w/` prefix), so
`ctx.invoke` / `invokeAction` dispatches it to the **host's internal node processor** — the same
processor that runs `@w6w/script`, `@w6w/data` and `@w6w/document` — rather than to the registry. The
engine never holds a provider credential and never performs the call itself; it asks the host through
the seam it already uses for every node.

### Reserved internal pseudo-app

| Id           | Action(s)                  | Input (`with`)                                      | Output                       | Processor |
| ------------ | -------------------------- | --------------------------------------------------- | ---------------------------- | --------- |
| `@w6w/model` | `complete`                 | `{ route }` **or** `{ model, connection }`, `input` | the completion envelope      | host      |
| `@w6w/model` | `list-models`, `allowance` | `{ connection }`                                    | `{ models }` / the allowance | host      |

- `route` names a **model route** on the run's own account. It is exactly one of the two ways to
  address a model: a `@w6w/model` step MUST carry **either** `route` **or** the `model` + `connection`
  pair, and a step carrying neither, or both, fails.
- `input` is the request body handed to the provider (e.g.
  `{ "messages": [{ "role": "user", "content": "…" }] }`, or the provider's native payload). It is
  expression-capable.
- `dialect` (`openai` | `anthropic` | `ollama`) rewrites the result into that wire dialect;
  `response` (`output` | `raw`) selects the envelope's payload field. Both are optional: unset, the
  result keeps the provider's own shape and the envelope carries both fields.
- `list-models` and `allowance` take a `connection` and nothing else — the connection must exist **on
  the caller's own account**, checked exactly as the completion path checks it.
- **There is no `project`, `tenant` or `scope` param.** The call is resolved and billed under the
  run's own `(tenant, subject, project)` — the workflow's own project — never a caller-supplied one.
  A run-time string naming a project would let one run spend, and read, another project's allowance;
  the run's own project is the only scope this node needs, and a host MUST NOT fall back to a default
  project when the run's scope is unavailable.
- The output of `complete` is the provider **envelope**: `{ provider, key, model, dialect, usage,
  meta }` plus `output` (the dialect-shaped result) and/or `raw` (the provider's own response),
  narrowed by `response`. It is deliberately **not** spread at the top level, so a provider response
  carrying its own `model` or `usage` field cannot collide with the envelope.

### Non-echo classification

`@w6w/model` **does not copy its parameters into the step output** — the output is the provider
envelope alone — so it is a **non-echo** app. It is therefore classified with the host's
`NON_ECHO_INTERNAL_APPS` and is **absent** from the engine's `SECRET_ECHO_APPS`
([Engine RFC](./engine.md)). The consequence is the point: because nothing of the step's `with`
reaches the stored run output, a **vault secret may be bound to `input`** (a per-run API key
interpolated into a prompt, say) without tripping the secret-echo refusal that `@w6w/data`,
`@w6w/template` and `@w6w/trigger` are subject to. Provider credentials themselves never appear in
`with` at all: they live on the connection, host-side.

### Spoke refusal

A model call needs the host's provider credentials, egress guard and budget ledger — none of which a
**spoke** holds. So `@w6w/model` is a **host-only** node:

- A host MUST classify the id in `HOST_INTERNAL_APPS` and refuse it on a spoke. With no provider
  binding available, a `@w6w/model` step executed on a spoke **fails the step** with an error whose
  message starts `model_unavailable:` — never a success carrying an empty or `null` output, and never
  a silent fallback to another project or another connection.
- A workflow containing a `@w6w/model` step is **not spoke-eligible**: the host's eligibility report
  names the reason `model_step`, so the workflow is not shipped to a spoke in the first place and the
  refusal above is the defence in depth, not the normal path.

### Open/closed seam

`@w6w/model` sits on the same open/closed boundary as `@w6w/call`, `@w6w/document` and `ctx.invoke`
(STRATEGY §5.1). The **contract** — the `@w6w/model` node kind and its reserved id constant — is
declared in the open `@w6w/workflow-types` and surfaced by `@w6w/ui`; the **implementation**
(connection resolution, egress guard, pricing, budget reservation and the `model_usage` ledger) is
provided by the **closed server host**. No capability implementation crosses the seam: the engine
holds only the reserved id and routes to the host, so the OSS engine stays host-free while the private
host owns how a model is actually called.

### Conformance (additive)

A host that implements `@w6w/model` MUST:

- Classify a node whose `uses.app === "@w6w/model"` as an **internal** kind, route it through the one
  invoke seam to the host's internal node processor, and accept no other execution path.
- Support exactly three actions — `complete`, `list-models`, `allowance` — and **reject any other**
  action under this id.
- For `complete`, require exactly one of `route` or `model` + `connection`, failing the step
  otherwise.
- Resolve `with` against the run scope first, then resolve the route, model and connection under the
  **run's own** `(tenant, subject, project)`, accepting no caller-supplied project, tenant or scope.
- Return the provider envelope on success, with `output`/`raw` narrowed by the `response` param.
- Classify the id as **non-echo** (`NON_ECHO_INTERNAL_APPS`, absent from `SECRET_ECHO_APPS`) and as
  **host-only** (`HOST_INTERNAL_APPS`), refusing it on a spoke with an error whose message starts
  `model_unavailable:`, and refusing to ship a workflow containing it to a spoke (`model_step`).

## Amendment — 2026-10-30: the `@w6w/store` host node (F-2)

> This section is **additive** to the node kinds, routing, and reserved-pseudo-app tables above; it
> introduces no breaking change and edits none of the following, which **stand unedited**,
> superseded in reading by this amendment — identified by link and location rather than reproduced:
> - the [Reserved internal pseudo-apps](#reserved-internal-pseudo-apps) table, which this amendment
>   extends with one more id;
> - the [Node kinds](#node-kinds) table's `internal` row, whose examples this amendment extends;
> - the paragraph under [Non-echo classification](#non-echo-classification) in the 2026-10-24
>   `@w6w/model` amendment, whose list of apps subject to the secret-echo refusal now also includes
>   `@w6w/store`.
>
> Like the [2026-10-24 `@w6w/model` amendment](#amendment--2026-10-24-the-w6wmodel-host-node-f-3),
> it has no companion amendment in [`invocation.md`](./invocation.md): the host performs the work.

`@w6w/store` is a new **internal host node**: an `@w6w/*` pseudo-app the platform executes itself to
read and write **persistent data stores** that outlive a run — key/value entries, documents and table
rows. Its params are ordinary expression-capable `with` values. Like `@w6w/control`, `@w6w/script`,
`@w6w/data`, `@w6w/trigger`, `@w6w/call`, `@w6w/document`, `@w6w/template` and `@w6w/model`, it is a
**host** node with host capabilities — **not** a sandboxed `packages/apps` app. No registered app id
may begin with `@w6w/`, so `@w6w/store` can never collide with a catalog app.

### Kind & routing

`@w6w/store` slots into the existing tables as an **internal** kind that routes through the one invoke
seam — there is no parallel code path:

| Kind       | `uses.app`   | Executed by                 | Examples                          |
| ---------- | ------------ | --------------------------- | --------------------------------- |
| `internal` | `@w6w/store` | the **host's internal API** | read or write a persistent entry  |

Routing is unchanged: `isInternalApp("@w6w/store")` is `true` (the reserved `@w6w/` prefix), so the
invoke seam dispatches it to the **host's internal node processor** rather than to the registry.

### Reserved internal pseudo-app

`store` = store NAME in the run's account+project (never an id, never another scope). Ignored if
present: `scope`, `account`, `project`, `tenant`, `subject`, `input`. Class: **secret-echo** (R-1) — a
step whose raw `with` reads a vault secret is refused before invoke.

| action | type | params | output |
|---|---|---|---|
| `get` | read | `store`*, `key`*, `required` (boolean, default false) | `{ found: true, key, value, version, expiresAt }` · miss: `{ found: false, key }`; miss + `required` ⇒ node error |
| `set` | perform | `store`*, `key`*, `value`* (json), `ifVersion`, `ttlSeconds` | `{ key, value, version, expiresAt }` (echoes `value`) |
| `delete` | perform | `store`*, `key`* | `{ key, deleted: boolean }` |
| `increment` | perform | `store`*, `key`*, `by` (number, default 1) | `{ key, value, version }` |
| `list` | read | `store`*, `prefix`, `cursor`, `limit` (≤200, default 50) | `{ items: Entry[], nextCursor? }` |
| `query` | read | `store`*, `where` (json object), `order` (`col`/`-col`), `limit` | `{ items: Entry[] }` |
| `insert` | perform | `store`*, `row`* (json), `ttlSeconds` | `{ key, value, version }` |

A `*` marks a required param. `Entry` = `{ key, value, version, sizeBytes, expiresAt, createdAt,
updatedAt }`. `query` and `insert` address **table** stores; `increment` addresses a **kv** store whose
value type is `number` or `integer`. Node errors are `InternalNodeError` whose message starts with the
store error code (`data_store_not_found: …`).

### Scope, archive and expiry

- **Scope.** A store belongs to the run's own **account and project**, and is shared by every member
  and service account of that account — there is no per-subject or per-creator privacy. The host
  binds the scope; no param moves it, and a host MUST NOT fall back to a default project when the
  run's project is unavailable.
- **Archive.** Deleting a store archives it. Its name is free again, and an archived store is not
  found: a step naming it fails with `data_store_not_found:`. Because a step names a store by NAME,
  archiving a store and creating a new one under the same name rebinds the step to the new store.
  Deleting an **entry** (`delete`) is a real delete.
- **Expiry.** `ttlSeconds` sets an entry's expiry. An entry that has expired is absent to `get`,
  `list` and `query`, and a write to it restarts at version 1. Expired entries are reclaimed lazily
  on later writes; there is no background sweep.

### Echo classification

Unlike `@w6w/model`, `@w6w/store` **does copy its parameters into data a run can read back**:
`set` and `insert` persist their params where every account member can read them, and `get` returns
them into later step outputs. It is therefore a **secret-echo** app: it is listed in the engine's
`SECRET_ECHO_APPS` ([Engine RFC](./engine.md)) and is **absent** from the host's
`NON_ECHO_INTERNAL_APPS`. A step whose raw `with` reads a vault secret is refused before invoke
(code `param_invalid`, phase `resolution`), exactly as for `@w6w/data`, `@w6w/template` and
`@w6w/trigger`.

### Spoke refusal

A store needs the host's database, which a **spoke** does not hold. So `@w6w/store` is a **host-only**
node:

- A host MUST classify the id in `HOST_INTERNAL_APPS` and refuse it on a spoke: a `@w6w/store` step
  executed on a spoke **fails the step** — never a success carrying an empty or `null` output.
- A workflow containing a `@w6w/store` step is **not spoke-eligible**: the eligibility report names
  the reason `store_step`, so the refusal above is the defence in depth, not the normal path.

### Open/closed seam

`@w6w/store` sits on the same open/closed boundary as `@w6w/model`, `@w6w/document` and
`ctx.invoke` (STRATEGY §5.1). The **contract** — the `@w6w/store` node kind and its reserved id
constant `STORE_APP` — is declared in the open `@w6w/workflow-types`; the **implementation** (store
resolution, scope binding, limits and persistence) is provided by the **closed server host**. The
engine holds only the reserved id and routes to the host.

### Conformance (additive)

A host that implements `@w6w/store` MUST:

- Classify a node whose `uses.app === "@w6w/store"` as an **internal** kind, route it through the one
  invoke seam to the host's internal node processor, and accept no other execution path.
- Support exactly the seven actions `get`, `set`, `delete`, `increment`, `list`, `query`,
  `insert`, and **reject any other** action under this id.
- Resolve `store` by name within the **run's own account and project**, ignoring any caller-supplied
  `scope`, `account`, `project`, `tenant`, `subject` or `input`.
- Treat an archived store as not found (`data_store_not_found:`), and apply expiry as above.
- Classify the id as **secret-echo** (`SECRET_ECHO_APPS`, absent from `NON_ECHO_INTERNAL_APPS`) and as
  **host-only** (`HOST_INTERNAL_APPS`), failing the step on a spoke and refusing to ship a workflow
  containing it to a spoke (`store_step`).

## Amendment — 2026-10-30: app trigger nodes (B-1)

> **Governs where it disagrees.** This amendment supersedes three statements above, and where
> they disagree this amendment governs; nothing else in this document is edited.
>
> 1. Non-Goals, "App-declared triggers and subscription delivery — see `trigger.md`. This RFC adds
>    only **system** triggers (manual)." — an _app_ trigger is now also expressible as a node
>    (below). Subscription delivery itself stays in `trigger.md`.
> 2. "Triggers as nodes", "`Workflow.trigger` field and the trigger node are two views of the same
>    fact; the field is authoritative for _how a run is launched_ …, the node is its position in
>    the DAG." — for an **app** trigger node there is no `Workflow.trigger` field to be a second
>    view: the node IS the trigger, and a workflow may hold several.
> 3. "Only **manual** is defined here. `schedule` and `event` remain as in `trigger.md`;
>    app-declared triggers are out of scope." — app-declared triggers are in scope as nodes, per
>    this amendment.

### Grammar (D-5)

An **app trigger node** is an ordinary app-Action node with one additive marker:

```json
{ "id": "updated", "uses": { "app": "eventbrite", "action": "event-updated",
                             "connection": "conn_1", "trigger": true },
  "with": { "event_id": "123" } }
```

- `uses.trigger: true` (absent means a plain app Action node). `uses.action` is the **trigger key**
  the app declares; `with` carries the trigger's params; `uses.connection` is the connection the
  trigger authenticates with. The `{ function }` arm has no such marker.
- `classifyNode` yields `"trigger"` for it (before the reserved-`@w6w/` arm), in addition to
  `@w6w/trigger`. `isTriggerNode` is true for `@w6w/trigger`, `@w6w/webhook`, `@w6w/scheduler`
  and any `uses.trigger: true` node.
- Executing it is a **pass-through of the fired event payload** (like `@w6w/webhook`); the host
  does not invoke the vendor action.
- **Multiple triggers.** A workflow may hold several trigger nodes of any of these grammars.
- The **poll interval is not part of the node in v1** (planner ruling P-1): the host's polling
  cadence is its own concern, not a param of the definition.

### Run start (D-6)

A fire starts the run at the trigger node that fired (`RunSeed.entry`). With `entry` set, only the
entry node and the nodes reachable from it via edges execute; every other root — trigger-class or
not — is recorded skipped, and so is every node reachable only from skipped roots; a join reachable
from the entry still runs. With `entry` absent, every root starts. See the [Engine RFC amendment](./engine.md#amendment--2026-10-30-trigger-entry-run-start-b-1).

**Alternate entries (2026-11-01).** Any step with an entry port may be the target of edges from
several triggers or several upstream paths — two triggers into one step, or a second path joining
the first part-way. This qualifies [`ports.in`](#field-reference-stored): only `in: 0` (no entry
port) binds; `in > 1` is a rendering hint, and an authoring tool must add an inbound edge, never
replace one. Per run, such a step runs **once**, after its predecessors on the fired path settle;
predecessors skipped `not_on_path` neither block it nor run it again.
Subscriptions for app trigger nodes are derived from the saved definition on publish; see the
[Trigger RFC amendment](./trigger.md#amendment--2026-10-30-trigger-nodes-bind-subscriptions-b-1).

## Amendment — 2026-10-30: run data in `@w6w/script` — `input` bindings, literal `code`, `digest`

> **Additive.** Qualifies the [Reserved internal pseudo-apps](#reserved-internal-pseudo-apps) table's
> `@w6w/script` row and the [Workflow RFC](./workflow.md)'s root-anchored template strings
> ([amendment 2026-08-14](./workflow.md#amendment--2026-08-14-root-anchored-template-strings-in-with-values))
> and template-strings-as-authored-form ([amendment 2026-10-29](./workflow.md#amendment--2026-10-29-template-strings-are-the-authored-form))
> for exactly one `with` key. It adds no scope root and no marker form, and edits no sentence above.

**`code` is source text, never a template.** A host resolves no `{{ }}` marker, `$` marker or
`ExprValue` inside `@w6w/script`'s `code`: the string reaches the sandbox byte-identical, and the
step record carries it unchanged. Splicing a value into a program is string concatenation into
syntax: an object becomes its string form, and a quote in the data ends (or rewrites) the program.
Because `code` is not resolved, it is also not read for references: it adds no dependency, trips no
own-control refusal and names no vault secret to any oracle a host walks over a `with` block. The
rule is per app and per key; a `code` param of any other app resolves as before.

**Run data enters through `input`.** The optional `input` key is an ordinary `with` value, so its
markers resolve type-preserved under the existing rules: `"{{ nodes.fetch.output }}"` delivers the
upstream object itself, and an object of bindings — `{ "order": "{{ nodes.fetch.output }}",
"region": "{{ var.region }}" }` — delivers an object of typed values. The script reads it as `input`
in both languages. An editor declares `input` as a `json` param with the `whole` flag
([Param RFC, amendment 2026-10-30](./param.md#amendment--2026-10-30-hidden-and-whole-param-flags)).

**`digest(value, algorithm?)`.** Both v1 languages expose a `digest` function to step code. It
returns the lowercase hex digest of `value` under `algorithm` — `"sha256"` when omitted, else one of
`"sha1"`, `"sha256"`, `"sha384"`, `"sha512"`, case-insensitive, `-` ignored. A string is hashed as its
UTF-8 text and bytes as themselves; any other value is hashed as the UTF-8 of its JSON text with
object keys sorted and no insignificant whitespace. In JavaScript it returns a promise; in Python it
returns the string.

### Conformance (additive)

A host that implements `@w6w/script`·`run` MUST:

- pass `code` through every `with` resolution it performs — a workflow run, a sub-block, a
  single-node test, an ad-hoc invoke, a Function or Endpoint adapter pass — byte-identical.
  Testably: a step whose `code` is `return "{{ var.x }}";` returns the text `{{ var.x }}`;
- exclude `code` from every reference or secret-name walk over the step's `with` block;
- resolve `input` exactly as any other `with` value;
- give `digest` the same result for the same value in both languages. Testably:
  `digest("abc")` is `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`, and
  `digest({ "b": 1, "a": [true, null] })` equals `digest({ "a": [true, null], "b": 1 })` and the
  Python twin's result for the same dict;
- refuse an algorithm outside the four names, failing the step with a message naming it.

A host MAY expose further helpers; `digest` is the only one this amendment requires.

## Amendment — 2026-10-30: the `"typescript"` value of `@w6w/script`'s `language`

> **Additive.** Adds a third value to the `language` enum of the
> [2026-09-19 amendment](#amendment--2026-09-19-the-language-param-on-w6wscriptrun-f-1). It edits
> no sentence above; that amendment's Conformance bullets bind `"typescript"` as they bind every
> other value.

`language: "typescript"` runs `code` as JavaScript after its TypeScript syntax is erased.
Type-only syntax (annotations, interfaces, type aliases, generics, `as` casts) is removed, and
emitting syntax (`enum`, parameter properties) compiles to its JavaScript form. **Types are not
checked**: a step that a type checker would reject still runs, so the dialect is a way to write
types, not a gate. Everything else is the JavaScript path's: the same function-body contract, the
same `input`, `digest` and `fetch`, the same sandbox, timeout and failure shape. Every
JavaScript body is a valid TypeScript body.

### Conformance (additive)

A host that implements `language: "typescript"` MUST:

- erase types inside the same no-ambient-authority sandbox, never by downloading a compiler or
  shelling out;
- run the erased body exactly as a `"javascript"` step would run it;
- report a syntax error naming the line the author wrote, before running any of the code.

## Amendment — 2026-10-31: `vars`, `consts` and `state` in `@w6w/script`

> **Additive.** Extends the [2026-10-30 run-data amendment](#amendment--2026-10-30-run-data-in-w6wscript--input-bindings-literal-code-digest):
> `input` stays the bound contract; this adds three read-only names the code sees beside it. No
> `with` key, scope root or marker form is added.

Step code in every language reads, besides `input` and `digest`:

| Name | Holds | Same value as |
|---|---|---|
| `vars` | the run's variables, by name | `{{ var.<name> }}` |
| `consts` | the account's constants, by name (always `account_id`) | `{{ const.<name> }}` |
| `state` | `{ nodes, trigger, foreach? }` — upstream step records, the trigger, a For each iteration | `{{ nodes.<id>.output }}`, `{{ trigger.event }}`, `{{ foreach.item }}` |

They are a snapshot taken when the step starts, resolved by the host and handed to the sandbox
with `input`; the sandbox has no path back to the host, a database or a vault for them. Writing to
them changes nothing outside the step (JavaScript and TypeScript receive them frozen). A script
whose code declares a name of its own (`const state = …`) shadows the global and still compiles.
The engine passes the snapshot on the step's invoke request (`InvokeStepRequest.script`); a host
running a script outside a run (a single-node test, an ad-hoc invoke, a Function adapter pass)
builds it from the same values its `{{ }}` resolution reads there.

**An empty Input means `input` is `state`.** When a `run` step's Input binding is empty (no `with.input`,
or an empty one), the code's `input` is the same `state` snapshot, so a script with no binding still
reads the upstream records and the trigger. A non-empty binding is unchanged: `input` is exactly what
it resolves to.

**Secrets never reach these names.** The snapshot is built from an allowlist of roots: `secrets`,
`documents`, a Function's `inputs`/`output` and credentials are never in it. A host MUST also keep
sealed secret envelopes out: a var or constant whose value holds one is omitted, and run state that
holds one fails the step with `sealed_secret_in_state` (phase `resolution`, not retried) before the
code runs. A script that needs a secret still receives it only through an explicit `input` binding.

### Conformance (additive)

A host that implements `@w6w/script`·`run` MUST give step code `vars`, `consts` and `state` as
above, in every language it offers, as empty objects (`state.nodes` empty) where no scope exists,
and MUST apply the sealed-envelope rule. Testably: a step whose code is `return consts.account_id;`
returns the account id, and a step run with a var whose value is a sealed envelope sees no such key.

## Amendment — 2026-10-31: `disabled` and editor-only `ui` on a node

Additive; existing definitions are unchanged.

- **`disabled?: boolean`** is engine semantics, stored in the definition: `true` means the node never
  executes in any run (published, triggered, manual or partial). It is recorded `skipped` and its
  outgoing edges are skipped, so what depends only on it does not run (Engine RFC, 2026-10-31).
  Absent or `false` runs as before. An editor writes the key only when it is `true`.
- **`ui?: { paused?: boolean }`** is authoring presentation, like `position`: the engine never reads
  it. `paused` marks where the editor's ▶ "run from here" stops; the editor sends paused ids as
  `RunSeed.startFrom.stopAt`. A published or triggered run ignores it.
