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
