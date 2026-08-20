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

| Field       | Type     | Required | Description                                                            |
| ----------- | -------- | -------- | --------------------------------------------------------------------- |
| `ports`     | object   | ⬜       | Declared port cardinality. Omitted ⇒ `{ in: 1, out: 1 }`.             |
| `ports.in`  | number   | ⬜       | Max incoming edges this node accepts. Defaults to `1`. `> 1` opts the node into accepting **multiple** inbound edges. |
| `ports.out` | number   | ⬜       | Number of outgoing ports this node exposes. Defaults to `1`.          |

Semantics:

- **Omitted ⇒ `{ in: 1, out: 1 }`.** The default reproduces today's single-in / single-out step
  exactly, so `ports` is purely opt-in.
- `in > 1` declares a **fan-in** node — one that accepts more than one incoming edge (e.g. a
  flow-control aggregator that joins several upstream branches; see [`@w6w/control` · `aggregate`](./action.md#w6wcontrol--aggregate)).
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
node with host capabilities — **not** a sandboxed `packages/apps` app. No registered app id may begin
with `@w6w/`, so `@w6w/call` can never collide with a catalog app.

### Kind & routing

`@w6w/call` slots into the existing tables as an **internal** kind that routes through the one invoke
seam — there is no parallel code path:

| Kind       | `uses.app`  | Executed by                       | Examples                    |
| ---------- | ----------- | --------------------------------- | --------------------------- |
| `internal` | `@w6w/call` | the **host's internal API**       | call a Function or Workflow |

Routing is unchanged: `isInternalApp("@w6w/call")` is `true` (reserved `@w6w/` prefix), so
`ctx.invoke` / `invokeAction` dispatches it to the host's internal processor rather than the
registry. That processor routes the node to a **new host capability**,
[`ctx.invokeCallable`](./invocation.md#amendment--2026-07-23-the-ctxinvokecallable-seam-f-3), exactly
as an app action routes to `ctx.invoke` and a function-step routes to `ctx.invokeFunction`.

### Reserved internal pseudo-app

| Id          | Action(s) | Input (`with`)                                   | Output                                                             | Processor                       |
| ----------- | --------- | ------------------------------------------------ | ----------------------------------------------------------------- | ------------------------------- |
| `@w6w/call` | `call`    | `{ target: Callable, input?, wait: boolean }`    | `wait` ⇒ the sub-run output · `no-wait` ⇒ a run handle `{ runId }` | host (`ctx.invokeCallable`)      |

- `target` is a **Callable** (`{ kind:"function"; function } | { kind:"workflow"; workflow }`),
  resolved within the **same project** as the calling workflow (HITL-D). It is independent of `wait`.
- `input` is the resolved payload passed to the target (the same shape a Function's `inputs` or a
  Workflow run's start payload expects). Expression bindings (`{ "$": "steps.x.output.y" }`) resolve
  against the run scope like any other node's `with`.
- `wait: boolean` is a **per-node** choice (HITL-5), independent of whether `target` is a Function or
  a Workflow:
  - **`wait: true`** — block until the sub-run (Function **or** Workflow) completes, then merge its
    output into the parent graph under `steps.<nodeId>.output`, readable by downstream
    `{ "$": "steps.<id>.output.…" }` expressions. This is the new **synchronous-await-subrun**
    semantic resolved in the [Endpoint RFC](./endpoint.md#amendment--2026-07-23-per-node-waitno-wait-f-3).
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
to **read one document, by key, from the run's own document store**. It is the in-graph way to pick a
document *at run time*: its `key` is an ordinary expression-capable `with` value, so it can come from
a trigger input or an upstream step's output — which the static `documents.<key>` path in the run
scope (see the [Workflow RFC](./workflow.md#run-scope-roots)) cannot express. Like `@w6w/control`,
`@w6w/script`, `@w6w/data`, `@w6w/trigger` and `@w6w/call`, it is a **host** node with host
capabilities — **not** a sandboxed `packages/apps` app. No registered app id may begin with `@w6w/`,
so `@w6w/document` can never collide with a catalog app.

Its output is data like any other step's, and its usual companion is a `render` part in a downstream
step's `with` pointing at `steps.<id>.output.content` — the document's `{{ }}` placeholders are
rendered by the engine's expression pass, not by this node (see [Workflow RFC — the multipart
expression envelope and the `render` part
kind](./workflow.md#amendment--2026-08-11-the-multipart-expression-envelope-exprvalue-and-the-render-part-kind-f-3)).
`@w6w/document` is **read-only in v1**: `get` is its only action, and there is no `set` or `upsert`.

### Kind & routing

`@w6w/document` slots into the existing tables as an **internal** kind that routes through the one
invoke seam — there is no parallel code path:

| Kind       | `uses.app`      | Executed by                 | Examples              |
| ---------- | --------------- | --------------------------- | --------------------- |
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
  any other `with` value, so `{ "$": "steps.start.output.template" }` and a multipart `ExprValue` are
  both valid and a literal string is the degenerate case. The resolved string names the document's
  `key` — not its id.
- **There is no `project` param.** The document is resolved under the run's own
  `(tenant, subject, project)` — the workflow's own project — never a caller-supplied one. A run-time
  string naming a project would arrive at the store as data and let one run read another project of
  the same tenant; the run's own project is the only scope this node needs.
- The output is `{ key, format, content }`: `key` echoes the resolved key, `format` is the stored
  document's format, and `content` is the document's body — the **parsed JSON** when `format` is
  `"json"`, the raw string otherwise. Downstream reads it as
  `{ "$": "steps.<id>.output.content.body" }`, or `{ "$": "steps.<id>.output.content" }` for a
  non-JSON document. The parsed content is deliberately **not** spread at the top level: a document
  whose own JSON carries a `key` or a `format` field would collide with the envelope if it were.

### Open/closed seam

`@w6w/document` sits on the same open/closed boundary as `@w6w/call` and `ctx.invoke`
(STRATEGY §5.1). The **contract** — the `@w6w/document` node kind and its reserved id constant — is
declared in the open `@w6w/workflow-types` and surfaced by `@w6w/ui`; the **implementation**
(document-store access, project scoping, entitlement) is provided by the **closed server host**. No
capability implementation crosses the seam: the engine holds only the reserved id and routes to the
host, so the OSS engine stays host-free while the private host owns how a document is actually found
— the identical split already used for `ctx.invoke`, `ctx.invokeFunction` and
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

> This section is **additive** to the [`@w6w/call` amendment](#amendment--2026-07-23-the-w6wcall-host-node-f-3)
> above; it introduces no breaking change and reserves no new id. It narrows one thing that
> amendment left open: nothing in it bounds how deep a `@w6w/call` chain — or a Function-arm
> step, which shares the same `ctx.invokeFunction` seam — may go. Grepping this file
> (`grep -n "@w6w/call\|invokeCallable\|sub-run" core/rfcs/node-types.md | awk -F: '$1>=276 &&
> $1<=340'`) surfaces every line of that section touching the mechanism; of those, the following
> state or imply an unbounded chain because they describe a hop being dispatched without ever
> naming a limit on how many may compose:
> - `:286` — "the in-graph caller for **one workflow calling another workflow**" describes
>   composition with no stated bound on how many hops may chain.
> - `:310` — the request-shape row (`{ target: Callable, input?, wait: boolean }`) carries no
>   depth or fuel field of any kind.
> - `:319` — `wait: true` "**block[s] until the sub-run … completes**" with no stated ceiling on
>   how many nested `wait: true` hops that block may stack.
> - `:323-324` — `wait: false` "**return[s] a run handle … immediately**" and the parent
>   "**continue[s] … without blocking**" — the exact shape that lets a self-referencing no-wait
>   chain flood the run queue silently, unbounded, rather than blow a stack.
> - `:332-339` — the full conformance MUST list obligates routing, project-scoping, and the
>   `wait` contract, but states no obligation to bound composition depth at all.
>
> The remaining grep hits (`:276`, `:283-285`, `:289`, `:293`, `:298`, `:300`, `:303`, `:312`,
> `:327`) are structural — a title, a table header, a routing statement, or the boundary-owner
> paragraph — and neither state nor imply a bound one way or the other; they are listed here for
> completeness of the grep, not because they assert anything about depth.

A host that implements `@w6w/call` — and, identically, a Function-arm step (`ctx.invokeFunction`,
the same seam a plain `{ uses: { function } }` step and a `@w6w/call` function target both
dispatch through) — MUST bound the **composition depth** of a chain:

- Every hop increments a `callDepth` counter by exactly one: a `@w6w/call` step dispatching to
  either a Workflow or a Function target, and a Function-arm step, are each one hop. The counter is
  **not** part of the node's own `with`/`input` — it travels with the dispatch, not with
  author-supplied, forgeable data.
- A hop whose depth would exceed the bound is **refused before dispatch** — no Function runs, no
  run is enqueued, no sub-run executes — with a distinct, recognisable error (host-side:
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
bounds how DEEP a chain nests; it does not bound how WIDE a shallow chain fans out — sixteen
sibling `wait: false` calls at depth 1, each fanning out sixteen more at depth 2, is still only
depth 2 and produces 256+ enqueued runs. Closing that residue needs a shared budget threaded
across the whole call tree (e.g. a `root_run_id` and a per-root counter), which is a materially
larger change (a new identity column, a shared/atomic counter, and a decision about where that
counter lives and how it is charged) than the in-process, per-hop counter this amendment
specifies. It is deliberately deferred rather than built speculatively alongside this bound.

The rest of this RFC — including every line the blockquote above enumerates — stands unedited:
this amendment adds a bound: it does not withdraw, contradict, or need any prior line to be
rewritten, because none of them claimed a chain was unbounded; they simply predated the question.
