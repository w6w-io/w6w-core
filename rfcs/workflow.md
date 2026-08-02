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
| anything else | Literal passthrough. |

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
