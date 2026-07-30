# RFC: Engine

**Status:** Draft
**Author:** Segev Shmueli
**Date:** 2026-07-04

## Summary

The **Engine** is the component that executes a [Workflow](./workflow.md) against a live [`WorkflowContext`](./workflow.md#host-contract--workflowcontext), turning a `Workflow` definition + trigger event into a `RunResult`. This RFC defines the contract any engine implementation MUST satisfy for a workflow to be portable across engines — planning, checkpoint, retry, control-action interpretation, replay — and pins the **canonical control set** every conforming engine natively implements. It also draws the line between what the engine owns and what the host owns (via `WorkflowContext`), so multiple engines can coexist without fragmenting the workflow language.

## Motivation

The workflow definition is portable. Its execution should be too. Different implementors have legitimately different execution models:

- **Reference:** in-process sequential, single node, Postgres checkpoints.
- **Serverless partner:** each step is a Lambda; state in DynamoDB; fan-out via SQS.
- **Streaming partner:** engine consumes a Kafka topic; state hydrated from a KTable.
- **Distributed partner:** Temporal-style workers with sticky routing.

All of these can consume the **same** `Workflow` and produce the **same** `RunState`. What differs is *how they get there*. Absent a shared engine contract, each partner's engine becomes a de facto fork of the language — a workflow authored for one engine won't run on another because subtle interpretations diverge. This RFC pins the invariants that make cross-engine portability real, without prescribing implementation.

## Goals

- Define the **engine contract** — inputs, outputs, side effects — that every implementation satisfies.
- Pin the **canonical control set** (`if`, `foreach`, `parallel`, `wait`) with exact interpretation semantics so control-driven workflows behave identically across engines.
- State **conformance invariants** (planning determinism, checkpoint durability, retry classification, replay determinism) mapped to a test fixtures package hosts run against.
- Draw the **engine ↔ host boundary** clearly enough that a partner can implement one without touching the other.
- Enable **multi-engine ecosystems** — the reference engine is one implementation, not the only one.

## Non-Goals

- **Prescribing an execution model.** Sequential, parallel, distributed, serverless — all conforming.
- **Prescribing state storage.** Postgres, DynamoDB, an in-memory map — all fine. The contract is `state.checkpoint` returns after durable commit; where "durable" lives is host business.
- **Prescribing wire protocols.** Engines that run in a different process from the host use whatever transport they like (HTTP, gRPC, in-process). The `WorkflowContext` interface abstracts it.
- **Extending the control set beyond the canonical four.** Partner control actions are a future extension (`extensions.md`, TBD).
- **Workflow versioning at runtime.** A running engine sees a resolved `Workflow` definition; how the definition is fetched, cached, or hot-reloaded is a host concern.

## Concept

The engine is a **pure function of `(Workflow, RunSeed, WorkflowContext)` to `RunResult`** — with the seam that all side effects flow through `WorkflowContext`. Everything else the engine does is deterministic given its inputs and the observed outputs of `context.invoke` and `context.state.load`.

- **`Workflow`** — the definition (see [Workflow RFC](./workflow.md)).
- **`RunSeed`** — the inputs that seed a run: `{ runId, workflowId, trigger, variables, resumeFromRunId? }`.
- **`WorkflowContext`** — the host abstraction. The engine touches the outside world ONLY through it.
- **`RunResult`** — `{ runId, status, output?, error?, state }`.

Given the same `(Workflow, RunSeed)` and a deterministic replay of `context.invoke` / `context.state` responses, two conforming engines produce the same `RunResult`. That's what makes workflows portable.

The engine owns:

- **Planning** — validating and ordering the graph.
- **Control interpretation** — the canonical control set is native; unknown control actions raise `unknown_control`.
- **Expression evaluation** — resolving `with` markers against the run scope (delegated to `@w6w/expr`).
- **Retry decisions** — applying step `retry` policy and honoring runtime retryability classification.
- **On-error routing** — deciding where a failed step goes once retries exhaust. An authored **error edge** (`Edge.when: "error"`) is the higher-precedence decision and overrides the step's policy; only a step with no error edge falls back to `onError` (`fail` vs. `continue` vs. `continue-record`). See [Error routing](#error-routing--failure-conditioned-edges-edgewhen).
- **Replay logic** — using recorded `StepExecution.output` for previously-completed steps.
- **Cancellation** — checking `context.signal` between steps.

The host owns:

- **Registering + resolving apps** — so `context.invoke` can dispatch to the right action.
- **Credentials + Connections** — the engine never sees a secret.
- **State persistence** — `context.state.checkpoint / load`.
- **Scheduling** — `context.schedule` for `wait`.
- **Queuing** — `context.queue` for fan-out under `parallel` when distributed.
- **Trigger delivery** — [Trigger manager](./trigger.md#host-contract--triggermanager) hands a normalized event to the engine as `RunSeed`.
- **Observability** — routing `context.log` lines to the sink of choice.

## Engine contract

```ts
export interface Engine {
  /**
   * Run a workflow to completion, or until it suspends (see wait / queue).
   * The returned RunResult reflects the terminal `state` or the state at the
   * point of suspension.
   */
  run(input: {
    workflow: Workflow;
    seed: RunSeed;
    context: WorkflowContext;
  }): Promise<RunResult>;

  /**
   * Resume a suspended run — from a `wait` scheduled fire, a queue callback,
   * or a crash-recovery path. The engine loads state via `context.state.load`,
   * verifies it's resumable, and continues.
   */
  resume(input: {
    runId: string;
    resumeToken?: string;             // matches the token given to context.schedule
    context: WorkflowContext;
    /** Optional: an already-loaded Workflow. Otherwise the host provides it via context. */
    workflow?: Workflow;
  }): Promise<RunResult>;

  /**
   * Reconstruct a completed run without invoking actions. Used by editors,
   * audits, and partial re-execution ("continue from step X with new params").
   */
  replay(input: {
    runId: string;
    context: WorkflowContext;
    /** If provided, the engine re-executes only steps at or downstream of this id. */
    from?: string;
  }): Promise<RunResult>;
}

export interface RunSeed {
  runId:     string;
  workflowId: string;
  trigger:   RunTrigger;                       // "manual" | "schedule" | "webhook" | "replay"
  variables: Record<string, unknown>;
  /** Event payload — populated when trigger === "webhook" (from Trigger dispatcher). */
  event?: unknown;
  /** Present when the seed is a crash-resume; engine calls context.state.load(seed.runId). */
  resumeFromRunId?: string;
}
```

`Engine` is intentionally the minimum surface. Everything an engine needs from outside is either in `input` or accessed through `context`. Additional convenience methods (`cancel`, `pause`) are host-level operations layered on top — they mutate state via `context.state` and rely on the engine's next `run` / `resume` call to observe the change.

### Error routing — failure-conditioned edges (`Edge.when`)

> **Additive (2026-07-29).** Routing a step's **failure** along an edge. It is neither a new control
> nor a new host primitive: it reads one new optional field, `Edge.when` (see
> [Workflow RFC · Amendment 2026-07-29](./workflow.md#amendment--2026-07-29-failure-conditioned-edges-edgewhen)),
> and decides it with the engine's existing edge-skip propagation and plan-time cycle rejection.
> Conformance invariant 9; fixture tag `error-routing`.

Routing a step's **outcome** onto its outgoing edges is the engine's responsibility, and it is the
same responsibility for success and for failure. `Edge.when` is `"success"` (the default, and the
meaning of every edge authored before this amendment) or `"error"`.

**Semantics:** when a step reaches a terminal status, the engine activates the outgoing edges whose
`when` matches the outcome — `"success"` on `succeeded`, `"error"` on `failed` — and marks the
step's remaining outgoing edges **skipped**. Skipped edges propagate exactly as they already do for
the unmatched branch of `@w6w/control` · `if`: a step is skipped, and records
`status: "skipped"`, only when it has at least one incoming edge and **every** incoming edge is
skipped. The engine keys a skipped edge by `(from, to, when)`, so a success edge and an error edge
between the same pair of steps are distinct keys; a step that is the target of both therefore runs
**exactly once**, on whichever path is live.

**An unmatched `if` skips every outgoing edge.** [`@w6w/control` · `if`](#w6wcontrol--if) whose
`condition` evaluates false treats **all** of its outgoing edges as skipped, error edges included —
even though the step itself ends `succeeded`, which is why the generic outcome rule above must not be
read as activating that step's success edges. The two rules do not conflict, because marking an edge
skipped is **additive**: a routing decision may only add edges to the skipped set, and an edge once
marked skipped is **never undone**. An engine that implements the success/error split by *replacing*
the skipped set rather than adding to it silently breaks `if`.

**Precedence.** A step that declares at least one outgoing `when: "error"` edge routes its failure
down that edge and the run continues; the step's `onError` is **not** consulted for that step. A step
with no error edge is unchanged — `onError` (`fail` / `continue` / `continue-record`) decides, after
retries exhaust, as before.

**Ordering against retry.** The error edge is taken only when the step is finally `failed` — after
`retry` is exhausted or the error is classified non-retryable (invariant 3 is unaffected). Step
kinds that run no retry loop (`@w6w/call` and `@w6w/control` steps) take their error edge on the
first failure.

**Scope.** Every [StepError](./workflow.md#steperror) `phase` routes — `"resolution"`, `"auth"`,
`"execute"`, `"output"` alike. Error edges belong to the **main** graph only: sub-block steps
(`foreach.body`, `parallel.branches`, an `if` branch block) do not participate in main-graph edge
routing, and a main-graph edge touching one is already rejected at plan time. Error edges are
ordinary DAG edges, so a cycle — routing a failure back to an earlier step — is rejected at plan
time in v1.

**Terminal status:** a run whose failed step routed down an error edge, and whose error branch then
completed, ends `succeeded`, with the failed step's `StepExecution` retained in `RunState.steps`
(`status: "failed"`, `error` populated).

**Failure modes:** a `when` value outside the enum raises `param_invalid` at load time, never at run
time.

## Canonical controls

Every conforming engine natively interprets the four control actions listed here. A workflow that uses only these controls + regular actions runs on every conforming engine unchanged.

Canonical control actions live in the first-party `@w6w/control` app. Their `(appId, key)` identity is what the engine matches to a semantic — an unknown control action raises `unknown_control` at plan time.

### `@w6w/control` · `if`

Runs the downstream branch only when `condition` evaluates true.

**Params:**

| Key | Type | Required | Description |
|---|---|---|---|
| `condition` | boolean | ✅ | Result of an expression evaluation. |

**Semantics:** the engine evaluates `condition`. If truthy, downstream steps (per the graph) run normally; if falsy, all edges outgoing from this step are treated as **skip** — steps reachable only through those edges receive `status: "skipped"` and are omitted from execution.

**Output:** `{ matched: boolean }` — recorded on the step's `StepExecution.output` for observability.

**Failure modes:** none intrinsic; a coercion failure on `condition` raises `param_invalid`.

### `@w6w/control` · `foreach`

Runs a sub-block once per item in `items`, collecting outputs.

**Params:**

| Key | Type | Required | Description |
|---|---|---|---|
| `items` | array | ✅ | Items to iterate. |
| `body` | string[] | ✅ | Step ids forming the sub-block executed per item. Must be a contiguous DAG rooted at the first id, with edges internal to the sub-block. |
| `parallelism` | number | ⬜ | Max concurrent iterations. Defaults to `1` (sequential). Engines that don't support concurrency clamp to `1` and log at `warn`. |

**Semantics:** for each item in `items`, the engine spawns a **child scope** where `foreach.item` and `foreach.index` are added to the run scope for the sub-block's steps. The sub-block's `StepExecution` records are keyed under `steps.<forEachStepId>.iterations[<index>].<stepId>`. When all iterations complete, the parent step's `output` is `{ items: [<per-iteration output>] }` where each per-iteration output is the last step's output in the sub-block.

**Failure modes:** if any iteration fails and the parent step's `onError` is `"fail"`, all in-flight iterations are canceled (via `context.signal`) and the run fails. Under `"continue"`, per-iteration failures are recorded and iteration continues.

### `@w6w/control` · `parallel`

Runs multiple branches concurrently, joins on all.

**Params:**

| Key | Type | Required | Description |
|---|---|---|---|
| `branches` | string[][] | ✅ | Each element is a list of step ids forming one branch. Branches must be disjoint (no shared step ids) and internally connected. |
| `strategy` | enum | ⬜ | `"all"` (default) waits for every branch; `"race"` cancels the losers when one completes; `"any"` waits for the first successful branch and cancels the rest. |

**Semantics:** the engine executes each branch as a sub-DAG. Under `"all"`, waits for every branch to reach a terminal step status. Under `"race"` / `"any"`, cancels outstanding branches via `context.signal` after the winner is chosen. Output shape: `{ branches: [<per-branch last-step-output>] }` (`"all"`), `{ winner: <index>, output: <last-step-output> }` (`"race"` / `"any"`).

**Portability floor:** every engine MUST support `strategy: "all"`. `"race"` and `"any"` are strongly encouraged but MAY raise `unsupported_strategy` on engines without cancellation primitives; workflows depending on them are non-portable to those engines and MUST document this dependency.

### `@w6w/control` · `wait`

Suspends the run for a duration or until a wall-clock time.

**Params:**

| Key | Type | Required | Description |
|---|---|---|---|
| `duration` | string | ⬜ | ISO-8601 duration (e.g. `"PT5M"` = 5 min). |
| `until` | string | ⬜ | ISO-8601 timestamp. |

Exactly one of `duration` / `until` MUST be provided.

**Semantics:** the engine calls `context.schedule({ afterMs, resumeToken })` (or `{ at, resumeToken }` for `until`), then returns a `RunResult` with `status: "queued"` and a `suspendedAt` marker. The host later invokes `engine.resume({ runId, resumeToken, context })` when the schedule fires. **`wait` requires the host to implement `context.schedule`**; engines running under a host without it MUST fail at plan time with `unsupported_wait`.

### `@w6w/control` · `aggregate`

> **Additive (2026-07-23).** A fan-in join that pairs with node input cardinality
> (`Step.ports.in > 1`, see [Node Types RFC](./node-types.md#ports--cardinality)). It extends the
> canonical set with a **join** semantic; it introduces no new host primitive — the "wait for all"
> is the engine's existing topological ordering, not a new suspension point.

Waits for **all** inbound edges to arrive, then combines their source outputs into one value.

**Params:**

| Key | Type | Required | Description |
|---|---|---|---|
| `mode` | enum | ✅ | `"array"` (ordered collection of inbound outputs) or `"object"` (shallow-merge, later edges win). |

**Semantics:** an `aggregate` node sits on a node that declares `ports.in > 1`, so several upstream
branches point at it. The engine's planning already topologically orders the graph: a node does not
run until **every** node with an edge into it has reached a terminal status. `aggregate` relies on
that existing **join** — it needs no `context.schedule` / suspension. When the engine reaches the
node, all of its inbound edges' source steps have already run, so their outputs are present in the
run scope at `steps.<sourceId>.output`. The engine reads those source outputs, in the workflow's
declared inbound-edge order, and produces:

- `mode: "array"` → `{ result: [<source output>, …] }` — an ordered array, one entry per inbound edge.
- `mode: "object"` → `{ result: { …shallow-merged } }` — the inbound source outputs shallow-merged
  into one object; on key collision the **later** edge (in declared order) wins.

Inbound edges whose source was **skipped** (e.g. the unmatched branch of an `if`) contribute no entry.

**Output:** `{ result: unknown[] | Record<string, unknown> }` — recorded on the step's
`StepExecution.output` and referenceable downstream as `steps.<aggregateStepId>.output.result`.

**Failure modes:** none intrinsic. `first` / `last` / custom-expression modes are out of scope for
v1; an unknown `mode` raises `param_invalid`.

## Conformance

A host + engine pair conform to this RFC when the following invariants hold:

1. **Planning determinism.** Two runs of the same `Workflow` produce the same step order (up to ties broken by declared order).
2. **Checkpoint durability.** After a process crash, `state.load(runId)` returns a state that reflects the last successful `state.checkpoint()`.
3. **Retry classification.** `phase: "auth"` errors are never retried. `phase: "execute"` errors are retried only when the action declares `idempotent: true` OR the error object sets `retryable: true`.
4. **Replay determinism.** Replaying a run reuses recorded `StepExecution.output` verbatim for previously-succeeded steps and produces the same terminal `status`.
5. **Control set support.** All four canonical controls interpret as specified. Unknown control actions raise `unknown_control` at plan time (never at run time).
6. **Expression scope.** The engine populates `vars`, `steps`, and `trigger` in every expression evaluation as specified in the [Workflow RFC](./workflow.md#expression-markers). Within a `foreach` sub-block, `foreach.item` and `foreach.index` are added.
7. **Cancellation.** When `context.signal` fires, the engine finishes the in-flight step invocation (best-effort abort via the runtime), then transitions the run to `status: "canceled"` and stops.
8. **Suspend / resume.** After `wait`, the engine may only be resumed via `resume(runId, resumeToken)` where the token matches the one passed to `context.schedule`.
9. **Error routing** (fixture tag `error-routing`). A step that ends `failed` and declares at least one outgoing edge with `when: "error"` routes down that edge — its `onError` is not consulted — and the step's outgoing `when: "success"` edges are marked skipped; on `succeeded`, the converse. Any `StepError` `phase` routes, and routing happens only after `retry` is exhausted or the error is non-retryable. A step that is the target of both a success edge and an error edge out of the same step executes **exactly once** (skipped edges are keyed by `(from, to, when)`, and a step is skipped only when every one of its incoming edges is skipped). A run whose error branch completes ends `status: "succeeded"` with the failed step's `StepExecution` retained (`status: "failed"`, `error` populated).

A conformance test fixtures package (`@w6w/engine-conformance`, TBD) will ship alongside this RFC. Each invariant maps to one or more fixtures the engine's harness runs against. A `run-conformance` CLI in the reference engine repo demonstrates the shape.

## Reference implementation

`w6w-io/w6w-workflow` ships the reference engine, MIT-licensed. It is one implementation of the contract in this RFC — not the sole owner of it. The reference engine's package is `@w6w/workflow-engine`; it exports the `Engine` interface and a `createEngine()` factory. Hosts that only need one engine can construct it directly; hosts that want to swap can inject an alternate implementation.

The reference engine's execution model is documented in the workflow repo's `README.md` and is not part of this RFC — it is descriptive of one conforming choice, not prescriptive of the contract.

## Open questions

1. **Nested control actions.** Can `foreach.body` contain `parallel`, or a nested `foreach`? First read: yes, uniformly — the sub-block is just a sub-DAG that follows the same rules. But it multiplies the state-management surface; worth stating explicitly.
2. **Cursor state in `foreach`.** When a run resumes mid-`foreach`, which iterations are considered complete? Options: (a) all iterations that reached a terminal step, (b) checkpoint iterations individually so partial iteration state resumes. (a) is simpler; (b) is more efficient for long iterations.
3. **Error propagation across `parallel` branches.** When one branch fails under `strategy: "all"`, do in-flight branches continue to completion or receive `context.signal`? This RFC picks cancellation; some engines may prefer completion to preserve side-effects — worth pinning explicitly.
4. **`schedule` with monotonic vs. wall-clock time.** `wait { until }` uses wall-clock; if the system clock jumps, does the resume fire early or on the intended timestamp? Host concern, but the contract should say the engine assumes wall-clock semantics.
5. **Extension control actions.** How does a partner-supplied control action become interpretable? Options: (a) engine plugins registered at construction, (b) each control action ships a `semantics` module the engine loads in a sandbox, (c) purely convention — the workflow declares which engine it targets. Deferred to a future `extensions.md` RFC.
6. **Engine identity in `WorkflowContext.run`.** Should the run's context expose which engine ran it (`engineId`, `engineVersion`) so replays can reject cross-engine deltas? Useful for debugging; adds a small field.

## Status ladder

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze.
- `Final` — frozen for `manifestVersion: "2"` (matches the Workflow RFC). Breaking changes require a new RFC and a `manifestVersion` bump.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.
