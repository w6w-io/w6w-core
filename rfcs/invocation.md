# RFC: Invocation

**Status:** Final
**Author:** Segev Shmueli
**Date:** 2026-05-18 (revised 2026-06-01)

## Summary

An **Invocation** is the envelope used to call an Action. It binds an App, an Action within that App, a Connection that supplies credentials, and the resolved `params` payload. Every Action call — by a workflow step, by the editor's test-run button, by an API caller, by a replay — flows through this shape.

## Motivation

Action manifests define what an Action expects to receive and return. They do not define what *calling* one looks like at the wire. Without a shared envelope:

- Workflow steps and ad-hoc API callers diverge on shape.
- Observability (Run RFC) can't standardize what it records per step.
- Editor and runtime test-execution paths drift.

A single envelope means every caller — interactive, programmatic, scheduled — speaks the same shape.

## Goals

- Define the **minimum closed shape** required to execute an Action: app, action, connection, params.
- Standardize **trace / correlation** fields for observability and replay.
- Specify the **resolution sequence** that turns an Invocation into an `execute` call.
- Be **serialization-agnostic**.
- Keep Actions and Connections at arm's length — Actions never see credentials.

## Non-Goals

- Defining a transport (HTTP, gRPC, in-process). The envelope is logical.
- Specifying the full result envelope — Action's `output` shape covers the success body; complete error/response semantics live in the Run RFC.
- Authorization of *who* may invoke — host concern.

## Shape

```json
{
  "manifestVersion": "1",
  "app":        "com.acme.slack",
  "action":     "send-message",
  "connection": "conn_01HXY3Q9PZ...",
  "params": {
    "channelId": "C12345",
    "text":      "Hello!",
    "threadTs":  "1700000000.000100"
  },
  "context": {
    "invocationId": "inv_01HXY...",
    "runId":        "run_01HXY...",
    "stepId":       "step_03",
    "trigger":      "workflow"
  }
}
```

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `manifestVersion` | string | ✅ | Core spec version. |
| `app` | string (app id) | ✅ | The App declaring the Action. |
| `action` | string (key) | ✅ | Action `key` within the App. |
| `connection` | string (connection id) | ⬜ | Connection that supplies credentials. Required for Actions whose App declares Auth, **unless** the Action sets `requiresAuth: false` (see [Action RFC](./action.md)). |
| `params` | object | ⬜ | Map of param `key` → value. Conforms to the Action's `params` schema after resolution. |
| `context` | object | ⬜ | Trace / correlation metadata. Populated by the caller; never required for correctness. |
| `context.invocationId` | string | ⬜ | Unique per Invocation. Host-issued. |
| `context.runId` | string | ⬜ | The Workflow Run this Invocation belongs to. |
| `context.stepId` | string | ⬜ | The step within the Run. |
| `context.trigger` | enum | ⬜ | What initiated the call: `workflow`, `editor`, `api`, `replay`, `test`. |

## Resolution sequence

Before `execute` runs, the host performs the following in order. Each step is a hard gate — failure short-circuits with a typed error.

1. **Resolve Action.** Look up `(app, action)`. Reject `unknown_app` / `unknown_action`.
2. **Resolve Connection.** Look up `connection`. Reject `unknown_connection`. Apply lifecycle rules from the [Connection RFC](./connection.md):
   - `pending` → reject `connection_pending`.
   - `needs_refresh` → run Auth `refresh`. On failure, transition to `broken` and reject `connection_broken`.
   - `broken` → reject `connection_broken`.
   - `revoked` → reject `connection_revoked`.
   - `connected` → proceed.
3. **Resolve params.** Run the Action's [Param resolution](./action.md#param-resolution) over the supplied `params`. Reject `param_invalid` on validation failure.
4. **Invoke `execute`.** Pass the resolved params. The Auth `sign` hook is invoked transparently for any outbound request the Action makes, with the Connection's credential injected. The Action receives only the redacted Connection projection (if any).

## Errors

Errors carry their phase so callers can decide what to retry:

| Phase | Examples | Caller's option |
|---|---|---|
| `resolution` | `unknown_app`, `unknown_action`, `param_invalid` | Fix and re-submit; never retry as-is. |
| `auth` | `connection_pending`, `connection_broken`, `connection_revoked` | Surface to the user; re-run after a fresh Auth flow. |
| `execute` | Hook threw, upstream API error | Per retry policy (Run RFC). |
| `output` | Return value didn't match declared `output` shape | Bug in the publisher's Action; not retryable. |

The complete error envelope (codes, structured details, retry hints) is specified in the Run RFC.

## Idempotency

Invocations are not implicitly idempotent. If an Action's manifest declares `idempotent: true` (per the Action RFC's open question on this field), the platform MAY use `context.invocationId` as a dedupe key when re-driving from a Run. Without that declaration, replaying an Invocation with the same `invocationId` is a no-op suppression — the prior result is returned and `execute` is not re-run.

## Resolved questions

| Question | Resolution |
|---|---|
| Result envelope | **Stops at the request side.** Success / error response shape is defined in the future Run RFC. This RFC specifies only what enters `execute`. |
| Streaming | **Deferred** to a future RFC. `manifestVersion: "1"` Actions return a single value. |
| Connectionless actions | Resolved in the Action RFC: optional `requiresAuth: false` on the Action manifest opts a single Action out of needing a Connection even when the App declares Auth. `connection` here remains optional. |
| App version pinning | **Rely on `context.runId`.** The Run record pins the App version; the envelope itself does not carry `app@version`. Avoids two sources of truth on replay. |
| Caller identity | **Derived from transport.** No `principal` in the envelope. Audit is the host's responsibility through its API gateway / RPC layer. |

## Amendment — 2026-07-23: the `ctx.invokeCallable` seam (F-3)

> This section is **additive** and does **not** change the frozen Invocation envelope, resolution
> sequence, or error phases above — an Invocation still calls exactly one Action. It records a new,
> sibling **host capability** used by the [`@w6w/call`](./node-types.md#amendment--2026-07-23-the-w6wcall-host-node-f-3)
> node, alongside `ctx.invoke` (call an Action) and `ctx.invokeFunction` (call a Function).

`ctx.invokeCallable` is the host seam for invoking a **`Callable`** — a reference to either a
[Function](./function.md) or a [Workflow](./workflow.md) (the
[Endpoint RFC · Callable](./endpoint.md#callable) union). It lives on
[`WorkflowContext`](./workflow.md#host-contract--workflowcontext) next to `invoke` / `invokeFunction`,
so the engine asks the host to run a sub-run rather than loading a Function or Workflow itself.

```ts
ctx.invokeCallable(req: {
  target: Callable;              // { kind:"function"; function } | { kind:"workflow"; workflow }
  input?: Record<string, unknown>;
  wait: boolean;                 // per-node (HITL-5), independent of target.kind
  stepId: string;
}): Promise<
  | { kind: "output"; output: unknown }   // wait: true  — the sub-run's completed output
  | { kind: "handle"; runId: string }      // wait: false — a run handle to poll
>;
```

- **Target resolution — same project only (HITL-D).** The host resolves `target` to a Function or a
  Workflow **within the same project** as the calling workflow. A cross-project target is rejected in
  resolution (a `resolution`-phase error, per the table above); there is no cross-project sub-run in
  v0.
- **Return.** With `wait: true` the host awaits the sub-run — a Function invoke (via
  `invokeFunction`) **or** a Workflow run (via `enqueueRun`) — to completion and returns its `output`,
  which the `@w6w/call` node exposes as its step output. With `wait: false` the host returns a run
  handle `{ runId }` immediately and does not await. The `wait` choice is **per node** and
  independent of whether `target` is a Function or a Workflow (see the
  [Endpoint RFC — per-node wait/no-wait](./endpoint.md#amendment--2026-07-23-per-node-waitno-wait-f-3)).
- **Reuses existing choke points.** `invokeCallable` funnels into the same `invokeFunction` /
  `enqueueRun` paths that back the Endpoint dispatch table — no parallel credential, source, or
  sandbox path. The engine never sees credentials, source refs, or the sandbox, exactly as with
  `ctx.invoke`.

### Open/closed seam

`ctx.invokeCallable` sits on the same open/closed boundary as `ctx.invoke` (STRATEGY §5.1). The
**contract** — the `@w6w/call` node kind and the `ctx.invokeCallable` capability signature — is
declared in the open `@w6w/workflow-types` and surfaced by `@w6w/ui`; the **implementation** (project
scoping, entitlement, sub-run scheduling, awaiting, metering) is provided by the **closed server
host**. No capability implementation crosses the seam: the engine holds only the interface and asks
`ctx`, so the OSS engine stays host-free while the private host owns how a Callable actually runs —
the identical split already used for `ctx.invoke` and `ctx.invokeFunction`.
