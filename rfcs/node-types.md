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
| `control`  | `@w6w/control`             | the **engine**, in-process               | `if` · `foreach` · `parallel` · `wait` |
| `internal` | `@w6w/script`, `@w6w/data` | the **host's internal API**              | run JS · set typed vars                |
| `trigger`  | `@w6w/trigger`             | the host (entry node)                    | `manual`                               |

`control` and `internal` are both **internal pseudo-apps** — reserved ids in the `@w6w/*` namespace
with no registry entry. They differ only in _who_ runs them: `control` alters the graph and so must
be interpreted by the engine; `internal` and `trigger` are leaf computations the host runs behind
the invocation seam, exactly like an app action.

### Routing

Routing is a pure function of `uses.app`:

```
route(node):
  if node.uses.app == "@w6w/control"      -> engine control interpreter
  else if isInternalApp(node.uses.app)    -> host internal processor
  else                                    -> app runtime (registry.load → invoke)

isInternalApp(app) = app starts with "@w6w/"    // reserved namespace
```

Because internal (non-control) nodes route through the ordinary invocation seam (`ctx.invoke` → host
`invokeAction`), the engine needs **no** special case for them: to the engine they are invoke steps
like any app. The host's `invokeAction` inspects the app id first and dispatches to an internal
handler instead of the registry when the id is reserved. This is the single routing choke point.

### Reserved internal pseudo-apps

| Id             | Action(s)                           | Input (`with`)        | Output                     | Processor    |
| -------------- | ----------------------------------- | --------------------- | -------------------------- | ------------ |
| `@w6w/control` | `if`, `foreach`, `parallel`, `wait` | control-specific      | control result             | engine       |
| `@w6w/script`  | `run`                               | `{ code, input? }`    | script return value        | host sandbox |
| `@w6w/data`    | `set`                               | `{ vars: DataVar[] }` | `{ <key>: <typed value> }` | host         |
| `@w6w/trigger` | `manual`                            | `{}`                  | the start payload          | host (entry) |

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
- Route a node by `uses.app` per **Routing**; internal (non-control) and trigger nodes dispatch
  through the same invocation seam as apps.
- Default a trigger to `{ type: "manual" }` when a registered workflow declares none.
- Execute `@w6w/script`·`run` with no ambient authority (no network, filesystem, or environment
  access).
- Record a NodeRun for each per-node execution with start/end state and `next`.

## Open questions

1. Should `@w6w/control` also be routable through the host seam (uniform routing) rather than
   staying engine-native, once the orchestrator drives node-runs?
2. Does `@w6w/script` need a declared output schema for downstream `{ "$": … }` binding, or is it
   always dynamic?
3. Should `next` carry edge labels (e.g. `then`/`else`) rather than bare ids?

## Status ladder

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze.
- `Final` — frozen for the current `manifestVersion`.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.
