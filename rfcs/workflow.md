# RFC: Workflow

**Status:** Draft
**Author:** Segev Shmueli
**Date:** 2026-07-03

## Summary

A **Workflow** is a directed acyclic graph of steps that runs as a single unit to accomplish a business outcome. Each step is an [Invocation](./invocation.md) — a call into a cataloged App's [Action](./action.md) — wired to other steps by expressions that resolve at execution time. This RFC defines the workflow logical model (the definition), the run model (the checkpointed execution state), and the `WorkflowContext` host contract the engine executes against. Workflows target `manifestVersion: "2"`.

## Motivation

Actions are individual operations; Workflows are how users compose them into automations. Standardizing the workflow shape means:

- Publishers of authoring tools (studios, IDE extensions, partner UIs) render, edit, and validate workflows uniformly.
- Hosts implement one engine that runs every workflow — no per-workflow custom code.
- Runs are portable: a run started on host A can, in principle, be resumed on host B because its state is fully described by the model.
- Third-party tooling (analyzers, linters, static importers from n8n / Zapier) targets a single spec.

Absent this RFC, the definition and run shapes live only in the `@w6w/workflow-types` package. That package is the source of code truth; this RFC is the source of contract truth.

## Goals

- Declare a workflow as a **graph of steps** with explicit or implicit edges.
- Each step is a single [Invocation](./invocation.md) — no bespoke step contract.
- Wire data between steps with expressions over a shared **run scope** (`vars`, `steps`, `trigger`).
- Define **retry** and **on-error** behavior per step.
- Specify a **checkpointed run state** so failed runs can resume and completed runs can be replayed.
- Define the **host contract** (`WorkflowContext`) an engine executes against — invocation, logging, state, scheduling, queuing.

## Non-Goals

- **How** the engine executes the graph. Deferred to the workflow engine's implementation (`@w6w/workflow-engine`). Concurrent scheduling of independent branches, suspend/resume machinery, and back-pressure are engine concerns.
- **How workflows are triggered.** The `trigger` field on a workflow is a *reference*; the trigger surface itself is specified in the [Trigger RFC](./trigger.md).
- **Scheduling.** A cron reference is one flavor of trigger; the scheduling primitive lives in the [Trigger RFC](./trigger.md).
- **The expression language.** The `{ "$": ... }` and `{ "$expr": ... }` markers used in `with` refer to `@w6w/expr`, which has its own spec (JSONLogic-based). This RFC only pins the marker convention.
- **Workflow-level auth or visibility.** Individual [Connections](./connection.md) live on steps; workflow-level access control is a host concern.

## Concept

A workflow is a **directed acyclic graph** of steps. Every step names an App and Action; when the step runs, the host packages `{ app, action, connection, params }` into an [Invocation](./invocation.md) and calls the core runtime. Whatever the action returns becomes the step's `output`, which downstream steps can reference through expressions in their own `params`.

Control flow — branching, looping, waiting, running steps in parallel — is expressed the same way: as an Invocation of a **control-type action** (`type: "control"` in the [Action RFC](./action.md#control)). Control actions are declared like any action so the editor renders them uniformly, but they are **interpreted by the engine** rather than called via the runtime. The [Engine RFC](./engine.md#canonical-controls) pins the four canonical control identities (`if`, `foreach`, `parallel`, `wait`, all under the first-party `@w6w/control` app) that every conforming engine natively supports — a workflow using only actions + canonical controls is portable across every engine.

The graph is either **explicit** (via `edges`) or **implicit** (when no edges are declared, the engine runs steps in the declared order as a linear chain). Explicit graphs are validated at load time: cycles, dangling edge endpoints, and duplicate step ids are rejected.

Execution is **checkpointed**. After every step, the engine persists a `StepExecution` (input, output, status, timings) plus the run's updated status. If the engine crashes mid-run, the host reads the `RunState` back and resumes from the first non-terminal step. Replays reuse recorded step outputs verbatim — no re-invocation of `execute` — so historical runs remain deterministic even if upstream apps change behavior.

Steps have **retry** and **on-error** policies. Retries apply to a single step's Invocation; when retries are exhausted, `onError` selects one of three outcomes: `fail` (the default) aborts the run, `continue` proceeds to the next step, and `continue-record` proceeds **and** keeps the step's [StepError](#steperror) in the run's end state so the failure stays observable. A step that declares an authored **error edge** (`Edge.when: "error"`) is the exception: its failure routes down that edge and its `onError` is not consulted — see [Amendment — 2026-07-29: failure-conditioned edges](#amendment--2026-07-29-failure-conditioned-edges-edgewhen), which is the governing text for both. Retry policy honors the Invocation's `retryable` classification: `phase: "auth"` errors are never retried (credentials aren't going to change mid-run), `phase: "execute"` errors are retried only when the action declares `idempotent: true` or the error object marks itself `retryable: true`.

The engine never touches the outside world directly. Every operational effect — calling an app, writing a log, checkpointing state, scheduling a delay, enqueueing a fan-out job — flows through `WorkflowContext`. This is the same shape [HookContext](./hook-runtime.md#context) has for action `execute`: a thin abstraction hostable in-process, over HTTP, or against a test double, without engine changes.

## Shape

```json
{
  "manifestVersion": "2",
  "id": "wf_daily_report",
  "name": "daily-report",
  "displayName": "Daily Report",
  "description": "Fetch yesterday's issues and post a summary to #ops.",
  "trigger": { "subscriptionId": "sub_9f4c…" },
  "variables": [
    { "key": "channel", "type": "string", "required": true, "default": "#ops" }
  ],
  "steps": [
    {
      "id": "fetch",
      "uses": { "app": "linear",   "action": "search-issues", "connection": "conn_ab12" },
      "with": {
        "query":   { "$expr": { "cat": ["updated:>", { "$": "trigger.event.since" }] } },
        "limit":   50
      },
      "retry":   { "maxAttempts": 3, "backoff": "exponential", "delayMs": 1000 },
      "onError": "fail"
    },
    {
      "id": "post",
      "uses": { "app": "slack", "action": "send-message", "connection": "conn_cd34" },
      "with": {
        "channelId": { "$": "vars.channel" },
        "text":      { "$expr": { "join": ["\n", { "$": "steps.fetch.output.items" }] } }
      }
    }
  ],
  "edges": [
    { "from": "fetch", "to": "post" }
  ]
}
```

### Field reference

#### Workflow

| Field | Type | Required | Description |
|---|---|---|---|
| `manifestVersion` | string | ✅ | Core spec version. `"2"` for the workflow model. |
| `id` | string | ✅ | Host-issued opaque id. Stable across renames. |
| `name` | string | ✅ | Machine name. Unique within the host. Lowercase, kebab-case. |
| `displayName` | string | ⬜ | Human-facing name. Falls back to `name`. |
| `description` | string | ⬜ | One-line summary. |
| `trigger` | [WorkflowTrigger](./trigger.md#workflowtrigger) | ⬜ | How this workflow starts. Absent means manual-only. See [Trigger RFC](./trigger.md). |
| `variables` | [WorkflowVariable](#workflowvariable)[] | ⬜ | Inputs collected from the caller / trigger event and made available as `vars.*`. |
| `steps` | [Step](#step)[] | ✅ | The graph nodes. At least one. |
| `edges` | [Edge](#edge)[] | ⬜ | Directed dependencies. When absent, the engine treats `steps` as a linear chain in declared order. |
| `settings` | object | ⬜ | `{ autoSave?, savePosition?, viewport? }` — authoring presentation for this workflow. Declarative only; the engine ignores it. `autoSave` and `savePosition` **default to `true`** when omitted. See [Amendment — 2026-07-29: authoring presentation](#amendment--2026-07-29-authoring-presentation-stepposition-workflowsettings). |

#### Step

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✅ | Machine name. Unique within the workflow. Downstream expressions reference outputs as `steps.<id>.output`. |
| `uses` | object | ✅ | `{ app, action, connection? }`. Fully names the [Invocation](./invocation.md) target. |
| `uses.app` | string | ✅ | App id (registry-resolved). |
| `uses.action` | string | ✅ | Action key within the app. |
| `uses.connection` | string \| null | ⬜ | Connection id. Required when the action's app declares auth and the action doesn't opt out with `requiresAuth: false`. |
| `with` | object | ⬜ | Param values. Each value is a literal, an object, an array, or an expression marker. See [Expression markers](#expression-markers). |
| `retry` | [RetryPolicy](#retrypolicy) | ⬜ | How to retry on failure. Defaults to no retry. |
| `onError` | enum | ⬜ | `"fail"` (default), `"continue"`, or `"continue-record"`. Applied when retries are exhausted: `fail` aborts the run; `continue` swallows the failure and proceeds; `continue-record` proceeds **and** rolls the step's [StepError](#steperror) into the run's end state (`RunState.stepErrors`) so the failure stays observable. Overridden, for the step it is declared on, by an authored error edge — see [Amendment — 2026-07-29](#amendment--2026-07-29-failure-conditioned-edges-edgewhen). |
| `ports` | object | ⬜ | `{ in?, out? }` — declared port cardinality. Omitted ⇒ `{ in: 1, out: 1 }`. `in > 1` opts the step into accepting multiple inbound edges (a fan-in node). See [Node Types RFC · Ports & cardinality](./node-types.md#ports--cardinality). |
| `notes` | string | ⬜ | Free-form author notes carried on the step. Declarative only — the engine ignores it. |
| `position` | object | ⬜ | `{ x, y }` — the step's coordinate on an authoring tool's canvas. Declarative only — the engine ignores it. Omitted ⇒ the editor lays the step out itself, exactly as today. See [Amendment — 2026-07-29: authoring presentation](#amendment--2026-07-29-authoring-presentation-stepposition-workflowsettings). |

> **Note:** "Required" (✅) above describes what a **valid, runnable** Step needs — it is not a
> storage-time constraint. A host may persist a Step (and a Workflow containing it) as an
> incomplete draft, e.g. with `uses.app`/`uses.action` unset. A separate computed validity signal
> or a publish/invoke-time gate is what enforces runnability, not storage rejection.

#### Edge

| Field | Type | Required | Description |
|---|---|---|---|
| `from` | string | ✅ | Step id. |
| `to` | string | ✅ | Step id. |
| `when` | enum | ⬜ | `"success"` (default) or `"error"` — which outcome of the `from` step activates this edge. `"success"` activates when that step succeeds, `"error"` when it fails. **An omitted `when` means `"success"`**, so every pre-existing edge is a success edge. See [Amendment — 2026-07-29](#amendment--2026-07-29-failure-conditioned-edges-edgewhen). |

#### WorkflowVariable

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✅ | Machine name. Referenced as `vars.<key>`. |
| `type` | enum | ⬜ | `"string"` \| `"number"` \| `"boolean"` \| `"object"` \| `"array"`. Advisory; hosts SHOULD validate at trigger/run boundary. |
| `required` | boolean | ⬜ | If true and no value provided at run start, the run is rejected. |
| `default` | any | ⬜ | Used when the caller doesn't supply a value. |

> Note: `WorkflowVariable` is a thin shape today. It's intended to converge on the [Param RFC](./param.md) at a future revision so workflow inputs validate and resolve identically to Action params.

#### RetryPolicy

| Field | Type | Required | Description |
|---|---|---|---|
| `maxAttempts` | number | ✅ | Total attempts including the first. `1` = no retry. |
| `backoff` | enum | ⬜ | `"fixed"` (default) or `"exponential"`. |
| `delayMs` | number | ⬜ | Base delay in ms before the first retry. Defaults to `0`. Exponential doubles each attempt. |

Retries are attempted only for errors the runtime classifies as **retryable**. `phase: "auth"` errors are never retried. `phase: "execute"` errors are retried only when the action declared `idempotent: true` or the error itself sets `retryable: true`.

## Execution model

### Planning

Before any step runs, the engine plans the graph:

1. Reject duplicate step ids.
2. If `edges` is empty or absent → the plan is `steps` in declared order (implicit linear chain).
3. Otherwise:
   - Reject edges referencing unknown step ids (`from` or `to`).
   - Build the in-degree map and adjacency list.
   - Topologically sort. Ties broken by declared step order for determinism.
   - Reject cycles (topological sort fails to consume all nodes).

The plan is a deterministic list of step ids. v0 executes them sequentially; parallel scheduling of independent branches is an engine-level enhancement that consumes the same plan.

### Run state

Every run is fully described by a `RunState`:

```json
{
  "runId": "run_5f...",
  "workflowId": "wf_daily_report",
  "status": "running",
  "variables": { "channel": "#ops" },
  "steps": {
    "fetch": {
      "stepId": "fetch",
      "status": "succeeded",
      "attempt": 1,
      "output": { "items": [...] },
      "startedAt": "2026-07-03T09:00:00Z",
      "finishedAt": "2026-07-03T09:00:03Z"
    }
  }
}
```

| Field | Type | Description |
|---|---|---|
| `runId` | string | Host-issued. Stable across resumes and replays. |
| `workflowId` | string | The workflow this run instantiates. |
| `status` | enum | `"queued"` \| `"running"` \| `"succeeded"` \| `"failed"` \| `"canceled"`. |
| `variables` | object | The resolved input scope for this run. |
| `steps` | object | Map of step id → `StepExecution`. Only completed / running / failed steps appear. |
| `output` | any | Final output when `status === "succeeded"`. Optional. |
| `error` | [StepError](#steperror) | Terminal error when `status === "failed"`. |

The engine writes a **checkpoint** through `WorkflowContext.state.checkpoint()` after every observable transition (status change, step start, step end, retry attempt). The host implementation of `checkpoint` MUST be durable — a run that survives a crash is one whose last checkpoint reached durable storage.

#### StepExecution

| Field | Type | Description |
|---|---|---|
| `stepId` | string | The step this record is for. |
| `status` | enum | `"pending"` \| `"running"` \| `"succeeded"` \| `"failed"` \| `"skipped"`. |
| `attempt` | number | 1-based attempt count. Incremented per retry. |
| `input` | object | Resolved params passed to the Invocation. Recorded for replay + debugging. |
| `output` | any | Action's return value. Present on `succeeded`. |
| `error` | [StepError](#steperror) | Present on `failed`. |
| `startedAt`, `finishedAt` | ISO-8601 | When the last attempt started / finished. |

#### StepError

| Field | Type | Description |
|---|---|---|
| `code` | string | Machine code (e.g. `unknown_action`, `network_error`, `param_invalid`). |
| `message` | string | Human-facing message. |
| `phase` | string | Invocation phase the error came from: `"resolution"` \| `"auth"` \| `"execute"` \| `"output"`. |
| `retryable` | boolean | Engine's classification of retry safety. |

### Replay

Replay re-executes a completed or failed run **without re-invoking actions**. The engine walks the plan; for each step that succeeded in the original run, it uses the recorded `StepExecution.output` verbatim. Steps that were pending or failed run fresh. This makes replays cheap and reproducible even when upstream apps have changed.

## Expression markers

Values in a step's `with` block, and by extension anywhere the model accepts expressions, use a two-marker convention:

| Marker | Meaning |
|---|---|
| `{ "$": "steps.fetch.output.items.0.title" }` | Path lookup sugar over the run scope. |
| `{ "$expr": <JSONLogic> }` | Full JSONLogic evaluation over the run scope. |
| plain object / array | Resolved recursively — nested markers evaluated in place. |
| anything else | Literal passthrough — **except** a string every one of whose `{{ … }}` markers names a run-scope root, which resolves; see [Amendment — 2026-08-14](#amendment--2026-08-14-root-anchored-template-strings-in-with-values). |

The two-marker form keeps a literal object unambiguous from an expression — the engine never has to guess whether `{ "==": [...] }` is data or logic.

The **run scope** is:

```ts
interface RunScope {
  vars:    Record<string, unknown>;                    // workflow-level variables
  steps:   Record<string, { output: unknown }>;        // completed step outputs so far
  trigger: { type: string; event?: unknown };          // trigger context (see Trigger RFC)
}
```

Expression semantics — operators, coercion, error handling — are specified by `@w6w/expr` (JSONLogic-based). This RFC only pins the marker convention and the scope shape.
See [Amendment — 2026-08-11: the multipart expression envelope and the `render` part kind](#amendment--2026-08-11-the-multipart-expression-envelope-exprvalue-and-the-render-part-kind-f-3), which specifies the multipart envelope and declares two further run-scope roots (`secrets`, `documents`) — the `RunScope` block above is incomplete rather than exhaustive, and that section governs where the two disagree.
See [Amendment — 2026-08-14: root-anchored template strings in `with` values](#amendment--2026-08-14-root-anchored-template-strings-in-with-values), which specifies when a **string** `with` value resolves against the run scope — the marker table's `anything else` row above is incomplete rather than exhaustive, and that section governs where the two disagree.

## Host contract — `WorkflowContext`

The engine is transport-free and host-free. Every operational effect goes through `WorkflowContext`, which the host implements.

```ts
interface WorkflowContext {
  run: {
    id: string;
    workflowId: string;
    trigger: "manual" | "schedule" | "webhook" | "replay";
    attempt: number;
  };

  /** Package as an Invocation and call the core runtime. Returns the action's output. */
  invoke(req: { app: string; action: string; connection?: string | null;
                params: Record<string, unknown>; stepId: string }): Promise<unknown>;

  log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void;

  /** Durable state persistence. `checkpoint` MUST reach durable storage before returning. */
  state: {
    checkpoint(patch: RunStatePatch): Promise<void>;
    load(runId: string): Promise<RunState | null>;
  };

  /** Durable scheduling for `wait` / `delay` steps. Optional in v0. */
  schedule?(directive: { at: string; resumeToken: string }
                     | { afterMs: number; resumeToken: string }): Promise<void>;

  /** Durable queueing for fan-out. Optional in v0. */
  queue?: { enqueue(job: { kind: string; payload: unknown }): Promise<{ jobId: string }> };

  /** Cooperative cancellation, checked between steps. */
  signal?: AbortSignal;
}
```

| Member | Required | Notes |
|---|---|---|
| `run` | ✅ | Correlation ids for logs and Invocations. `trigger` is the `RunTrigger` tag; the app-declared trigger (if any) is looked up via `workflow.trigger.subscriptionId`. |
| `invoke` | ✅ | The single bridge to the core runtime. The engine NEVER sees credentials, source refs, or the sandbox. |
| `log` | ✅ | Routed to the host's observability sink. |
| `state.checkpoint` | ✅ | Durable. A pre-crash checkpoint MUST be readable post-crash. |
| `state.load` | ✅ | Idempotent read for resume / replay. |
| `schedule` | ⬜ | Required only for hosts that support `wait` / `delay` steps. |
| `queue` | ⬜ | Required only for hosts that support fan-out / parallel branches. |
| `signal` | ⬜ | When provided, the engine polls between steps and aborts cleanly on signal. |

## Conformance

A host conforms to this RFC when:

- **Planning** rejects duplicate step ids, dangling edges, and cycles at load time.
- **Implicit chain** — a workflow with no `edges` executes `steps` in declared order.
- **Checkpoint durability** — a `RunState` read via `state.load()` after a process crash reflects the last successful `state.checkpoint()`.
- **Retry classification** — `phase: "auth"` errors are never retried; `phase: "execute"` errors are retried only when idempotent or `retryable: true`.
- **Replay determinism** — replaying a run yields the same terminal `status` and, for succeeded steps, the same `output`, without calling `execute` again.
- **Expression scope** — the engine populates `vars`, `steps`, and `trigger` in every expression evaluation as specified.
  See [Amendment — 2026-08-11: the multipart expression envelope and the `render` part kind](#amendment--2026-08-11-the-multipart-expression-envelope-exprvalue-and-the-render-part-kind-f-3), which adds the `secrets` and `documents` roots to that enumeration and governs this bullet.

The `@w6w/workflow` reference engine + its test fixtures constitute the executable version of this contract.

## Resolved questions

| Question | Resolution |
|---|---|
| Step contract | A step **is** an Invocation. No bespoke step shape — `uses` fully names an `(app, action, connection)` triple. |
| Graph shape | DAG with explicit `edges`; implicit linear chain when omitted. Cycles and dangling edges rejected at plan time. |
| Expression language | `{ "$": ... }` for path lookup, `{ "$expr": ... }` for JSONLogic. Two-marker form keeps literal objects unambiguous. |
| Replay semantics | Replays reuse recorded step outputs verbatim. Do not re-invoke actions. |
| Retry classification | Runtime-declared. Auth errors never retried. Execute errors retried only when idempotent or explicitly `retryable`. |
| Control-flow step types | Modeled as pseudo-actions with `type: "control"` (see [Action RFC §Control](./action.md#control)). The canonical set (`if`, `foreach`, `parallel`, `wait`) lives in the first-party `@w6w/control` app; every conforming engine natively interprets them (see [Engine RFC](./engine.md)). Extension controls beyond the canonical four are a future RFC. |

## Open questions

1. **Fan-out / parallel branches — default concurrency.** The `parallel` canonical control expresses opt-in concurrency at the step level. Do we also allow a workflow-level `concurrency` field that lets independent branches of the base DAG run concurrently without a `parallel` wrapper? Adds ergonomics; adds engine responsibility.
2. **Variables convergence with Param.** `WorkflowVariable` today is a shallow shape. Migrate to the full [Param RFC](./param.md) so variables get validation, dynamic options, and `dependsOn` — at the cost of a manifest-version bump.
3. **Sub-workflows.** Should a step be able to invoke another workflow (`uses.workflow`) as an alternative to `uses.action`? If so, how do sub-workflow retries and state nest into the parent run?
4. **Per-run TTL and cleanup.** How long do completed `RunState` records live? Host-configurable; RFC-level default?

## Status ladder

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze.
- `Final` — frozen for `manifestVersion: "2"`. Breaking changes require a new RFC and a `manifestVersion` bump.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.

## Amendment — 2026-07-29: failure-conditioned edges (`Edge.when`)

> This section is **additive** to the [Edge](#edge) shape and the [Execution model](#execution-model)
> above; it introduces no breaking change and no new host primitive. It adds one optional field to
> `Edge` and pins how a step's **failure** is routed along the graph. Everything it relies on already
> exists in the model: plan-time cycle rejection, and the edge-skip propagation the unmatched branch
> of `@w6w/control` · `if` already uses. Where this section and the pre-amendment prose on `onError`
> disagree, **this section governs**.

An **error edge** is an edge that activates when its source step **fails**, instead of when it
succeeds. It is expressed by the new optional `Edge.when` field:

| Value | Meaning |
|---|---|
| `"success"` | The edge activates when the `from` step reaches `status: "succeeded"`. **The default.** |
| `"error"` | The edge activates when the `from` step reaches `status: "failed"`. |

**Default.** `when` is optional and its omission means `"success"` — which is exactly what every
edge meant before this amendment. A host MUST reject a `when` value outside the two-member enum at
**load time**, alongside the graph validations in [Planning](#planning).

**Outcome selects the outgoing edges.** A step that ends `succeeded` activates its `when: "success"`
edges (an omitted `when` is one of them) and marks its outgoing `when: "error"` edges **skipped**. A
step that ends `failed` **and declares at least one outgoing `when: "error"` edge** does the
converse: it activates those error edges and marks its outgoing success edges **skipped**. A step
reachable only through skipped edges is recorded `status: "skipped"` — the same propagation the
unmatched branch of `if` already produces. Success routing and error routing are one mechanism, not
two.

**A failing step with no error edge is left to `onError`.** When a step ends `failed` and declares
**no** outgoing `when: "error"` edge, the rule above does not fire: that step's success edges are
**not** skipped, and its `onError` alone decides. `"fail"` (the default) ends the run; `"continue"`
and `"continue-record"` proceed along the step's ordinary outgoing edges, so the next step runs
exactly as it did before `Edge.when` existed — `"continue-record"` additionally keeping the
[StepError](#steperror) in the run's end state. Skipping a step's success lane on failure is what an
**authored error edge** buys; failing alone never does it.

**An error edge overrides `onError`.** When a step declares at least one outgoing `when: "error"`
edge, that edge — not the step's `onError` — decides what happens on failure. The run takes the
error edge and continues, whatever the step declares for `onError` (`"fail"`, `"continue"`, or
`"continue-record"`); the two do not compose. The edge is the more specific statement about that
step's failure. `onError` stays authoritative for every step that declares **no** error edge.

**All failure phases route.** Any step that ends `failed` takes its error edge, whatever the
[StepError](#steperror) `phase` — `"resolution"`, `"auth"`, `"execute"`, or `"output"`. v1 draws no
phase distinction.

**Retries come first.** A step takes its error edge only once it is *finally* failed: after its
`retry` policy is exhausted, or as soon as the error is classified non-retryable. Two step kinds run
no retry loop at all and therefore take their error edge on their **first** failure: `@w6w/call`
steps, and `@w6w/control` steps. An author who wants attempts before the error branch must declare
`retry` on a step kind that honors one.

**Error edges stay in the DAG.** An error edge is an ordinary directed edge and is validated like
one: dangling endpoints and **cycles** are rejected at load time. A failure therefore cannot route
backwards to an earlier step in v1 — "retry from step X" is not expressible as an error edge. This
is a stated limit of v1, carried by the existing cycle rejection rather than by new enforcement.

**Main graph only.** `when: "error"` applies to edges of the **main** graph. Steps owned by a
control's sub-block (`foreach.body`, `parallel.branches`, an `if` branch block) do not participate in
main-graph edge routing, and an edge touching such a step is already rejected at plan time; a step
inside a sub-block therefore cannot carry an error edge. A sub-block failure is handled by its
enclosing control's own failure modes (see the [Engine RFC](./engine.md#canonical-controls)).

**A success edge and an error edge MAY share a target.** The model permits `{ from: "a", to: "b" }`
and `{ from: "a", to: "b", when: "error" }` to coexist. The engine keys a skipped edge by
`(from, to, when)`, so the two never collide, and because a step is skipped only when **every**
inbound edge is skipped, the shared target runs **exactly once** on either path. The v1 *editor*
declines to author that pair — that is an authoring-tool limit, not a limit of this model.

**Terminal status.** A run whose failed step routes down an error edge, and whose error branch then
completes, ends `succeeded`. The failure is not erased: the failed step keeps its
[StepExecution](#stepexecution) in `RunState.steps` with `status: "failed"` and its `error`
populated, and the underlying call remains in the host's API-call log. A run ends `failed` only when
a failure reaches a step that declares neither an error edge nor a continuing `onError`.

**Additive & backward-compatible.** `when` is a new **optional** field on `Edge`; workflow
definitions are JSON, so existing `manifestVersion: "2"` workflows — every edge of which is
implicitly a success edge — remain valid and unchanged with **no migration**. A host that does not
understand `when` reads every edge as `when: "success"`, which is exactly the pre-existing behavior.

## Amendment — 2026-07-29: authoring presentation (`Step.position`, `Workflow.settings`)

> This section is **additive** to the [Workflow](#workflow) and [Step](#step) shapes above; it
> introduces no breaking change, no new host primitive, and no change to any existing field. It adds
> two optional fields that carry **authoring presentation** — where a step sits on an editor's
> canvas, and how an editor should behave while someone edits this workflow. **The engine ignores
> both fields entirely**: they are purely declarative, exactly like [`Step.notes`](#step). No plan,
> no checkpoint, no expression scope, and no [Conformance](#conformance) rule reads them, and a
> workflow's execution is byte-for-byte identical with them present, absent, or arbitrary. It is
> independent of, and does not interact with,
> [Amendment — 2026-07-29: failure-conditioned edges](#amendment--2026-07-29-failure-conditioned-edges-edgewhen).
> **HITL-6** asked whether a workflow's arrangement and its auto-save preference belong to *the
> workflow* or to *the person looking at it*; this amendment takes the **workflow** answer — both
> fields live in the workflow document, so everyone who opens a workflow sees the same arrangement
> and the same preferences.

Authoring tools need two things the pre-amendment model cannot carry: **where each step was placed**
on the canvas, and **per-workflow authoring preferences** (does editing save itself, is the
arrangement persisted at all, and what was the last camera position). Both are presentation, not
semantics, so they enter the model as optional declarative fields rather than as engine behaviour.

```ts
// on Step
position?: { x: number; y: number };

// on Workflow
settings?: {
  autoSave?: boolean; // omitted ⇒ true
  savePosition?: boolean; // omitted ⇒ true
  viewport?: { x: number; y: number; zoom: number };
};
```

### `Workflow.settings`

`settings` is itself optional; when the object is absent, every member below takes its own default.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `settings.autoSave` | boolean | ⬜ | **`true`** | Whether an authoring tool persists edits to this workflow without an explicit save action. |
| `settings.savePosition` | boolean | ⬜ | **`true`** | Whether an authoring tool persists step coordinates (`Step.position`) and `settings.viewport` when it saves. When `false`, an authoring tool does not write them; any values already stored are left as they are, not erased. |
| `settings.viewport` | object | ⬜ | *none* | `{ x: number, y: number, zoom: number }` — the last camera position of the canvas, so reopening the workflow restores the view. No default: a workflow with no `viewport` opens at whatever view the editor computes, exactly as today. |

`viewport` sits **inside** `settings` deliberately, so exactly one new top-level key enters the
portable workflow document. All three members are the same thing — authoring presentation for this
workflow — and they belong under one key.

**`autoSave` and `savePosition` default to `true` when omitted.** This is the single most important
sentence in this amendment, and it is *deliberately unlike* the house rule that
[`ports`](./node-types.md#ports--cardinality) and [`onError`](#step) follow, where an omitted field
reproduces prior behaviour. Here it does **not**: omitting `autoSave` means auto-save is **on**, and
omitting `savePosition` means positions are **persisted**, neither of which is what a host did before
this amendment. That is intended — the product requires both features **on by default**, so the
absent-value reading must be `true`, not `false` and not "whatever happened before". Concretely:
`settings.autoSave ?? true` and `settings.savePosition ?? true`. An implementation that reads either
as `?? false`, or that treats an absent `settings` object as "both off", contradicts this amendment.
Only an explicit `false` turns a feature off.

### `Step.position`

`position` is the step's coordinate on an authoring tool's canvas: `{ x: number, y: number }`, in the
editor's own coordinate space (the spec pins no unit, origin, or grid — those are the authoring
tool's).

**Rename-safe by construction.** Because the coordinate travels **with the step**, renaming a step id
carries its position along untouched: there is no workflow-level `id → {x,y}` map to keep in step
with renames, and therefore no orphaned entries and no id fix-up. This is why coordinates attach
per-`Step` rather than as one layout map on the workflow.

**No positions is a valid workflow.** `position` is optional per step, so a workflow whose steps
carry none — every workflow authored before this amendment — is laid out by the editor exactly as it
is today, from the graph alone. Partial coverage is likewise valid: an editor places the steps that
declare a `position` and computes the rest.

### Storage

Both fields live in the **workflow document itself** — the same JSON object that already carries
`steps` and `edges`. A host that stores a workflow definition as an opaque document (the reference
host stores it in an existing `definition` jsonb column) therefore needs **no new column and no
migration**; the two fields round-trip as ordinary members of the document. This RFC pins no storage
mechanism beyond that: what is normative is that both fields are part of the portable workflow
document, so a workflow exported from one host and imported into another keeps its arrangement.

**Additive & backward-compatible.** `settings` is a new **optional** field on `Workflow` and
`position` is a new **optional** field on `Step`; workflow definitions are JSON, so existing
`manifestVersion: "2"` workflows — none of which declares either — remain valid and unchanged with
**no migration**. A host that does not understand them ignores them, which is exactly the
pre-existing behavior; an engine is required to do precisely that. The one thing a host MUST NOT do
is read an omitted `autoSave` or `savePosition` as `false`.

## Amendment — 2026-08-11: the multipart expression envelope (`ExprValue`) and the `render` part kind (F-3)

> This section is **additive** to [Expression markers](#expression-markers) above; it introduces no
> breaking change, no new host primitive, and no change to any existing marker or field. It does
> three things: it **specifies the multipart expression envelope** (`ExprValue`) that authoring
> tools and engines already exchange but which this RFC has never named; it **declares two run-scope
> roots** — `secrets` and `documents` — that the pre-amendment scope block omits; and it adds
> **exactly one** new part kind, `render`. It is independent of, and does not interact with,
> [Amendment — 2026-07-29: failure-conditioned edges](#amendment--2026-07-29-failure-conditioned-edges-edgewhen)
> and
> [Amendment — 2026-07-29: authoring presentation](#amendment--2026-07-29-authoring-presentation-stepposition-workflowsettings)
> — the three amend independent parts of this RFC. **Where this section and the pre-amendment prose
> disagree, this section governs.** That applies specifically to the three-member `RunScope`
> interface under [Expression markers](#expression-markers) and to the *Expression scope* bullet
> under [Conformance](#conformance), each of which enumerates `vars`, `steps` and `trigger` alone:
> both are read as **incomplete rather than exhaustive**, extended by [Run-scope
> roots](#run-scope-roots) below, and neither is edited. The companion node that loads a document by
> key at run time is
> [Node Types RFC — the `@w6w/document` host node](./node-types.md#amendment--2026-08-11-the-w6wdocument-host-node-f-3).

[Expression markers](#expression-markers) pins two markers and the shape of the run scope, and says
as much in as many words: *"This RFC only pins the marker convention and the scope shape."* A third
form is nevertheless already in the model — the **multipart expression envelope** an authoring tool
produces whenever one param value mixes literal text with references (`Hi {{ vars.name }}, your
order is ready`). This section specifies that envelope, then adds one part kind to it.

### The envelope

An **`ExprValue`** is a `with` value of the form `{ "type": "expr", "parts": [ … ] }`: an ordered
list of **parts**, each resolved independently, **concatenated** into one string. It takes its place
alongside the two existing markers — the first two rows below are restated unchanged from
[Expression markers](#expression-markers) for context; only the third is new:

| Marker | Meaning |
|---|---|
| `{ "$": "steps.fetch.output.items.0.title" }` | Path lookup sugar over the run scope. |
| `{ "$expr": <JSONLogic> }` | Full JSONLogic evaluation over the run scope. |
| `{ "type": "expr", "parts": [ … ] }` | **Multipart expression envelope** — an ordered list of parts concatenated to a single string. |

A part is `{ "kind": <kind>, … }`. **Five** kinds are defined, and each populates exactly one field:

| `kind` | Field it populates | Resolves to |
|---|---|---|
| `text` | `value` (string) | The literal chunk, verbatim. |
| `var` | `ref` (path) | A path lookup against the **generic data root**, exactly as `{ "$": … }`. |
| `secret` | `ref` (secret name) | The plaintext of that named secret, read from the [`secrets`](#run-scope-roots) root. The **only** production in the model that may read it. |
| `expr` | `expr` (JSONLogic) | JSONLogic evaluated against the **generic data root**, exactly as `{ "$expr": … }`. |
| `render` | `ref` (path) | **New.** The string at `ref`, parsed as a `{{ }}` template and rendered — see [The `render` part kind](#the-render-part-kind). |

A part carries no field beyond the one its kind names. On the two kinds that carry their own content
— `text` and `expr` — an absent `value` / `expr` is read as empty rather than as an error. On the
three kinds whose field *names* something to look up, that field is **required**: a `var` part's
`ref`, a `secret` part's `ref`, and a `render` part's `ref`. A `secret` part whose `ref` names no
available secret fails the step rather than contributing empty, and a `render` part's `ref` must
resolve to a string — see [The `render` part kind](#the-render-part-kind).

Five kinds are defined here and no other is. A part whose `kind` is none of them is outside this
model; the reference engine contributes the empty string for it, which is a description of what that
engine does and not a requirement this RFC places on a host.

### An `ExprValue` always resolves to a single string

An `ExprValue` resolves to **one string** — always. That includes the case where `parts` holds
exactly one part, and the case where that one part's value is an object or an array, which is
stringified before it is concatenated. This is a **stated limit of the model, not a discovered
one**: it is what makes concatenation well defined for every combination of parts, and it is why the
envelope needs no result-type negotiation.

The consequence worth stating plainly, so that nobody meets it as a surprise: **a document rendered
through a `render` part cannot be handed to an object-typed param.** Whatever the document holds,
the envelope's contribution is a string. The structured value of a `json` document is reached the
other way round: a `{ "$": "steps.<id>.output.content" }` marker resolves to the value itself rather
than to a string form of it. Pointing a `render` part's `ref` at that parsed object does **not**
stringify it either — it fails the step, per [The `render` part kind](#the-render-part-kind).

### The `render` part kind

`{ "kind": "render", "ref": "<path>" }` reuses the envelope's existing `ref` field — no new field
enters the model. It resolves in four steps:

1. **Resolve `ref`** against the **generic data root** — the run scope minus `secrets`, per
   [Run-scope roots](#run-scope-roots) — to a value, exactly as a `var` part would.
2. **Require a string.** The value from step 1 must **be** a string; there is no coercion here and
   no fallback. A path that is absent, or that resolves to `null` or `undefined`, **fails the step**
   with `render_ref_unresolved`, naming the `ref` that was asked for. A path that resolves to any
   other non-string — an object, an array, a number, a boolean — **fails the step** with
   `render_ref_not_a_string`, naming the `ref` and the type found.
3. **Parse** the resulting string as a `{{ }}` template in **render mode** (below), yielding a list
   of parts.
4. **Resolve** each of those parts against **that same generic data root** and concatenate the
   results; the concatenation is this part's contribution to the envelope.

**Why step 2 fails rather than coerces.** An absent path is otherwise **byte-identical to an empty
template**: a `ref` with a typo in it renders to nothing, the step succeeds, and the run mails a
blank body. That failure is invisible — nothing in the run record distinguishes it from a document
that really was empty. Failing by name is what makes it visible, and it is why the two error names
above are part of this contract rather than an implementation detail: the step's outcome is the only
signal this model offers.

**One pass.** The parts produced in step 3 are resolved in step 4 and never re-enter step 1: a
reference produced *by* rendering is never itself rendered, whatever it resolves to. So content
containing `{{ documents.other.body }}` substitutes that other document's text **verbatim** —
`{{ }}` sequences and all, un-rendered. There is no recursion, no depth limit and no cycle
detection, because there is no second pass to bound.

**`render` has no `{{ }}` text spelling, in either parser mode.** It is an authored part kind only:
`{ "kind": "render", "ref": … }`. Nothing an author can type between `{{` and `}}`, and nothing a
document can contain, parses to a `render` part. That is what makes "one pass" a property of the
grammar rather than a rule an implementation must remember to apply.

### Render mode, and why rendered content cannot reach a secret

The `{{ }}` template grammar has **two parser modes**, and `render` uses the narrower one:

| Mode | Productions | Used by |
|---|---|---|
| editor | `{{ =<JSONLogic> }}` → an `expr` part · `{{ secrets.<name> }}` → a `secret` part · `{{ <path> }}` → a `var` part | authoring tools, round-tripping an authored `ExprValue` to text and back |
| **render** | `{{ =<JSONLogic> }}` → an `expr` part · `{{ <path> }}` → a `var` part | step 3 of a `render` part |

**Render mode's grammar has exactly two productions, and neither one is a secret reference.** It has
no production for a secret part and no production for a nested render part. This is a property of
the grammar itself, not a filter over its output: in render mode **no input has a parse that yields
a `secret` part**, so there is no such part in existence to be removed, rejected or skipped, and
nothing an implementer could forget to do.

`{{ secrets.API_KEY }}` inside rendered content is therefore not a secret reference at all. It
matches the ordinary path production and parses to `{ "kind": "var", "ref": "secrets.API_KEY" }` — a
path lookup like any other. And the generic data root it is looked up in is the run scope **minus**
`secrets` ([Run-scope roots](#run-scope-roots)), so the lookup finds nothing and contributes the
empty string, exactly as every unknown path does. Two independent structural barriers, each
sufficient on its own: the grammar cannot produce the part, and the root does not carry the data.
That the parse yields a `var` part naming the literal path `secrets.API_KEY` — rather than nothing
at all — is the observable difference between this mechanism and a post-parse filter, and it is what
a conformance test asserts on.

**Why the barrier is needed.** Rendered content is **data**, and the model does not guarantee it was
authored by the run's caller: a conforming host's document store may serve a run both the caller's
own documents and documents shared across the tenant, so a run started by one subject can render
content written by another. If a rendered `{{ secrets.X }}` resolved to plaintext, writing a shared
document would be enough to read someone else's vault through their own run — and on a host's
single-step authoring path the injected `secrets` root is typically every secret the scope can see,
not merely the ones the definition names. The barrier is what keeps *"a document is data"* true.

The barrier is about **`secrets` and nothing else.** Rendered content reads the same generic data
root every other expression reads — `vars`, `steps`, `trigger`, `documents`, and whatever else the
host populates for that pass. `render` is not a sandbox and narrows no other read surface; it simply
cannot reach `secrets`.

### Run-scope roots

The `RunScope` block under [Expression markers](#expression-markers) enumerates three roots (`vars`,
`steps`, `trigger`). Two more are part of the model and are declared here; per the governing clause
above, that block is incomplete rather than exhaustive.

| Root | Contents | Reachable through the generic data root? |
|---|---|---|
| `secrets` | Host-injected **plaintext**, keyed by secret name. | **No — never.** |
| `documents` | The run's project-scoped document store, keyed by document `key`. Ordinary data. | **Yes.** |

**`secrets`** is injected by the host from its vault before the run and is never persisted with run
state. Exactly one production in this model may read it: a `secret` part of an `ExprValue`, which
reads `secrets[ref]` **directly**, never through expression evaluation. It is **excluded from the
generic data root** — the root that `{ "$": … }`, `{ "$expr": … }`, `var` parts, `expr` parts and
every rendered reference are evaluated against is the run scope with `secrets` removed. So
`{ "$": "secrets.X" }` is an unknown path rather than a secret read and resolves to nothing, which
is what an unknown path always does. A host that puts `secrets` on the generic data root does not
conform to this RFC.

**`documents`** is ordinary data with no special handling: reachable as `documents.<key>` from any
expression, exactly like `vars` or `steps`. The host populates it under the run's own
`(tenant, subject, project)` — a workflow reads its **own** project's documents. Loading one lazily
by key at run time instead, so the key can come from a trigger input or an upstream step's output,
is what the
[`@w6w/document` node](./node-types.md#amendment--2026-08-11-the-w6wdocument-host-node-f-3) is for.

This section declares `secrets` and `documents`, and only those two. Any further root a host
populates for a particular pass is neither declared nor forbidden here; it remains unspecified by
this RFC.

### Conformance (additive)

A host that implements the multipart expression envelope MUST:

- Resolve an `ExprValue` to a **single string**, including when `parts` holds exactly one member,
  and including when that member's value is an object or an array — which is stringified before
  concatenation, never handed through as a structured value. (A `render` part's own `ref` is the one
  place this stringification does not apply: it requires a string, per the bullet below.)
- Evaluate `var` parts, `expr` parts, `{ "$": … }` and `{ "$expr": … }` against a data root from
  which `secrets` has been **removed**. Testably: for every run scope **S** and every `with` block
  that contains no `secret` part, resolving that block against **S** MUST produce a result identical
  to resolving it against `{ ...S, secrets: {} }`.
- Read plaintext from `secrets` for a `secret` part **only**, directly, and never through expression
  evaluation.
- Parse a `render` part's resolved content in **render mode**, whose grammar has no production for a
  secret reference. Testably: for every content string **T**, parsing **T** in render mode MUST
  yield **zero** parts of kind `secret`; and `{{ secrets.X }}` in particular MUST parse to a `var`
  part whose `ref` is the literal path `secrets.X`, and MUST therefore render as the empty string.
- Render in **one pass**: the parts produced by parsing a `render` part's content MUST NOT
  themselves be rendered. Testably: rendering content that contains `{{ documents.other.body }}`
  MUST substitute that document's text verbatim, including any `{{ }}` sequences inside it.
- **Fail the step** when a `render` part's `ref` does not resolve to a string: `render_ref_unresolved`
  when the path is absent or resolves to `null` / `undefined`, and `render_ref_not_a_string` for any
  other non-string, each naming the `ref`. Testably: a `render` part whose `ref` names a path the run
  scope does not carry MUST fail the step — it MUST NOT render as the empty string, and MUST NOT
  emit the literal text `null`.
- Make `documents.<key>` reachable through the generic data root like any other data, populated
  under the run's own project.

### An absent or empty `ref` names nothing

A `var`, `secret` or `render` part's `ref` is **required** (stated above). This clause says what
follows when one is absent or empty anyway, because "required" on its own leaves the case to each
host — and the reading a host is most likely to reach for is the dangerous one.

**An absent or empty `ref` names nothing. It MUST NOT resolve the data root.** The equivalence the
kinds table draws between a `var` part and `{ "$": … }` is narrowed here to exactly this extent: a
`var` part whose `ref` is absent or `""` contributes the **empty string**, not the run scope and not
a stringification of it. This is deliberate divergence from the JSONLogic identity `{ "var": "" }`,
which returns the whole data root — that production is reachable through `expr` parts and
`{ "$expr": … }`, where the author has written the empty path on purpose; it is not reachable
through the *absence* of a value the model already declared required.

The other two kinds inherit their existing consequences unchanged, because "names nothing" is
already the input those rules take: a `secret` part with an absent or empty `ref` names no available
secret and so **fails the step**, per the `secret` rule above; a `render` part with an absent or
empty `ref` has no resolved content and so fails the step with `render_ref_unresolved`, per
[The `render` part kind](#the-render-part-kind).

**Conformance (additive).** A host that implements the multipart expression envelope MUST NOT expose
the run scope, or any root of it, through an empty path in an envelope part. Testably: for every run
scope **S**, resolving a `with` block whose only part is `{ "kind": "var" }` or
`{ "kind": "var", "ref": "" }` MUST produce the empty string — it MUST NOT produce a serialization
of **S**, and in particular MUST NOT surface anything from [`secrets`](#run-scope-roots).

## Amendment — 2026-08-14: root-anchored template strings in `with` values

> This section is **additive** to [Expression markers](#expression-markers) above, and it is the
> reconciling authority over four earlier passages that read as if a plain string `with` value never
> resolves: the marker table's `| anything else |` row ([Expression markers](#expression-markers)),
> the [`Step.with`](#step) field row ("a literal, an object, an array, or an expression marker"), the
> [Non-Goals](#non-goals) bullet on the expression language and the [Resolved questions](#resolved-questions)
> "Expression language" row — each of which names only the two pre-existing markers — and the
> [Conformance](#conformance) "Expression scope" bullet. Where any of those and this section disagree
> about whether a plain string resolves, **this section governs**. The marker-table row is the one
> pre-existing line this amendment rewrites (below); the `Step.with` field row, the Non-Goals bullet,
> and the Resolved-questions row stand **unedited** and are read as **incomplete rather than
> exhaustive** — they enumerate the markers that existed before this amendment, not every value form a
> `with` value now takes. The Conformance "Expression scope" bullet is **unaffected**: it states which
> roots the engine populates in every evaluation, not which value *forms* resolve, and this amendment
> declares no new root. It is independent of, and does not interact with,
> [Amendment — 2026-07-29: failure-conditioned edges](#amendment--2026-07-29-failure-conditioned-edges-edgewhen)
> and
> [Amendment — 2026-07-29: authoring presentation](#amendment--2026-07-29-authoring-presentation-stepposition-workflowsettings)
> — neither changes what a `with` value resolves to. Its relationship to
> [Amendment — 2026-08-11: the multipart expression envelope and the `render` part kind (F-3)](#amendment--2026-08-11-the-multipart-expression-envelope-exprvalue-and-the-render-part-kind-f-3)
> is narrower than independence: this section **builds on** it — reusing the `secrets` and `documents`
> roots it declares — and **narrows** one of its sentences (below), without editing that amendment's
> text or changing anything it specifies about the multipart envelope, `render` parts, or the two
> secret barriers.

Before this amendment, a plain **string** `with` value was pinned as unconditional literal
passthrough — the marker table's `anything else` row. That is wrong the moment a host resolves
`{{ … }}` markers embedded in a plain string rather than only inside the two bracketed marker forms:
a workflow author who types `"Bearer {{ vars.token }}"` as a step's `with` value expects the token
substituted, not the literal braces sent to the app. This section specifies exactly when that
substitution happens and when it does not.

**§ The rule.**

1. A **string** `with` value resolves **iff** it contains at least one `{{ … }}` marker **and every
   one** of its markers names a run-scope root. Otherwise the string is passed through **unchanged**.
2. **All-or-nothing.** A string mixing rooted and unrooted markers (`"Hi {{ name }}, {{ vars.c }}"`)
   is passed through **whole and unchanged** — the rooted marker `{{ vars.c }}` is *not* resolved on
   its own. Partial resolution would silently delete the unrooted `{{ name }}` marker from the
   output, and the grammar has no escape sequence an author could use to get it back; leaving the
   whole string alone is the only reading that never destroys characters the author wrote.
3. **The root set is CLOSED and fixed** — it is not "whatever roots the host happens to have
   populated for this pass". This is load-bearing: an open set makes which vendor placeholders
   survive depend on the host running the workflow, not on the workflow's own text. The closed set is
   exactly the eight members of the exported `RunScope` type, which this RFC and its companions
   declare across three files and which this section gathers into one list:
   - `vars`, `steps`, `trigger` — [Expression markers](#expression-markers) of this RFC;
   - `secrets`, `documents` — [Amendment — 2026-08-11](#amendment--2026-08-11-the-multipart-expression-envelope-exprvalue-and-the-render-part-kind-f-3)
     § [Run-scope roots](#run-scope-roots), whose closing sentence — *"Any further root a host
     populates for a particular pass is neither declared nor forbidden here; it remains unspecified
     by this RFC"* — is narrowed **here**: an unspecified root is **not** a resolvable root for the
     rule in this section, whatever else it may be for a particular host's pass;
   - `inputs`, `output` — the Function RFC's widened `RunScope` (`rfcs/function.md:226-243`);
   - `foreach` — the Engine RFC's `@w6w/control` · `foreach` control, which adds `foreach.item` and
     `foreach.index` to the sub-block's run scope (`rfcs/engine.md:210`), and its Conformance item 6
     (`rfcs/engine.md:288`).

   The exported `RunScope` type in `@w6w/workflow` is **canonical** for this list: it is the single
   source of truth for which roots exist, and a future member added to it extends this rule's root
   set automatically — no separate list to keep in step.
4. **Marker-kind handling**, per the shared `{{ }}` grammar of [Render mode, and why rendered content
   cannot reach a secret](#render-mode-and-why-rendered-content-cannot-reach-a-secret): `{{
   =<JSONLogic> }}` and `{{ secrets.<name> }}` are always ours, and a **path** marker qualifies as
   rooted **iff its first dot-segment** is one of the eight names above. Parsing runs in **editor
   mode** — the same mode an authoring tool round-trips an `ExprValue` through — so a typed `{{
   secrets.API_KEY }}` inside a plain string behaves identically to the same reference expressed as
   an inserted secret chip in an `ExprValue`.

**§ Why root-anchored — the constraint, stated in the spec.** Root-anchoring is not a simplification the engine happens to make; it is what keeps this rule from
silently corrupting data that has nothing to do with `@w6w/workflow`'s own expression grammar. Of the
**121** distinct `{{ … }}` spellings measured across the first-party app pack, **116 are vendor-side
placeholders that must reach the vendor verbatim** — Mailjet's `{{var:name}}`, Mandrill's Handlebars
merge tags, Metabase's SQL `{{tag}}` filters, Google Slides' template placeholders, Apify's actor
input templates, and lemlist's personalization tags, among others. None of those names a run-scope
root. An unconditional string arm — resolve every `{{ … }}` it finds — would evaluate each of the 116
against a scope that has no matching key and **silently delete it**, and the grammar defines no
escape sequence an author could use to opt a vendor placeholder back out. Under the rule in this
section, every one of the 116 stays literal, because none of them is rooted; only the small set of
markers an author actually wrote against `vars`, `steps`, `trigger`, and the other five roots
resolves.

**§ Resolved semantics.** One normative clause each:

- **Interpolation inside a larger string is allowed** — `"Bearer {{ vars.token }}"` is a valid,
  resolving `with` value; the rule does not require the marker to be the whole string.
- **The result is always a single string**, inheriting [An `ExprValue` always resolves to a single
  string](#an-exprvalue-always-resolves-to-a-single-string): `"{{ vars.count }}"` with `count: 5`
  resolves to `"5"`, not the number `5`. An author who needs the typed value rather than its string
  form uses the `ExprValue` envelope's `var` part, `{ "$": … }`, or `{ "$expr": … }` instead.
- **A reference that resolves to nothing contributes the empty string**, exactly as a `var` part
  does — an absent or unresolved path is not an error here.
- **A `{{ secrets.<name> }}` naming no available secret fails the step**, exactly as a `secret` part
  does — this is the one marker kind for which "resolves to nothing" is a failure, not an empty
  string.
- **An unterminated `{{`** — no matching `}}` before the string ends — makes the whole string
  literal, and it is returned **byte-identical** to what was written, not re-concatenated to the same
  characters through a resolve-and-rejoin path that happens to reproduce them.
- **`{{ }}`** (an empty marker, naming no path) names no root, so the string carrying it is literal
  under the iff rule in clause 1 above — an empty marker is not itself a "root-anchored" marker.
- **There is no escape mechanism, and none is added by this amendment.** A string that must deliver a
  literal `{{ vars.x }}` to an app — as opposed to having it resolved — is expressible only through
  the `ExprValue` envelope's `text` part, which never parses its content for markers. This is a
  **known gap of the grammar**, deliberately left open rather than an oversight: inventing an escape
  syntax such as `\{{` is itself a grammar change, tracked separately.

**§ Reach beyond this RFC.** This rule governs every `with` value the shared `resolveWith` walks, and several of those clauses live
in RFCs this section may not edit; each is read as **incomplete rather than exhaustive**, governed
here, exactly as the passages reconciled above:

- the Function RFC's `impl.with` field row (*"Each value is a literal or an expression marker"*,
  `rfcs/function.md:206`) and `outputMap` row (`rfcs/function.md:207`) — both resolved by the same
  `resolveWith` the Function RFC's own Adapter section names;
- the Endpoint RFC's `action` arm `with` (`rfcs/endpoint.md:358`, same `resolveWith`) — its
  *"`with` omitted ⇒ the inbound payload is passed to the action as its params unchanged"* rule is
  about an **absent `with` block** and is **unaffected** by this section, which only governs a string
  value that is present;
- the Node Types RFC's *"literals pass through"* clause (`rfcs/node-types.md:215`) and its
  `@w6w/document` `key` param, *"a literal string is the degenerate case"* (`rfcs/node-types.md:388`);
- the Auth RFC's `connectionLabel: "{{user.name}} — {{team.name}}"` (`rfcs/auth.md:83`) is
  **unaffected, and named as such so it is not mistaken for a case this rule reaches**: it is a
  connection-label template, never a `with` value, and `user`/`team` are not run-scope roots — it
  stays literal under this rule twice over, once because it is not a `with` value and once because
  neither of its markers names a root.

**§ Conformance (additive).** A host that implements this rule MUST:

- Resolve a **string** `with` value **iff** it contains at least one `{{ … }}` marker and every one of
  its markers names one of the eight run-scope roots; otherwise pass it through unchanged. Testably:
  for every string containing only rooted markers, resolving it MUST differ from the input; for every
  string containing no marker, or containing at least one unrooted marker, resolving it MUST produce
  the **byte-identical** input string.
- Treat a mix of rooted and unrooted markers as **all-or-nothing**. Testably: a string containing both
  a rooted and an unrooted marker MUST resolve to the byte-identical input — the rooted marker MUST
  NOT be substituted while the unrooted one is left as literal text.
- Pass a string through **byte-identical** when it carries no `{{ … }}` marker, an unterminated `{{`,
  or an empty `{{ }}` marker. Testably: each of these three inputs, resolved, MUST equal itself.
- Resolve a rooted string to a **single string** result. Testably: a string whose sole marker resolves
  to a non-string value (number, boolean, object, array) MUST resolve to that value's string form, not
  the structured value.
- Contribute the **empty string** for a rooted path marker that resolves to nothing. Testably: a
  rooted marker naming a path absent from the run scope MUST resolve to `""`, not fail the step.
- **Fail the step** for a `{{ secrets.<name> }}` marker naming no available secret. Testably: such a
  marker MUST NOT resolve to the empty string or to the literal text.
- Treat the **eight-member `RunScope` root set** as closed for this rule: `vars`, `steps`, `trigger`,
  `secrets`, `documents`, `inputs`, `output`, `foreach`. Testably: a marker whose first dot-segment is
  none of the eight MUST leave the whole string unresolved, whatever else the host's ambient scope for
  that pass happens to carry.
