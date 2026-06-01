# RFC: Connection

**Status:** Final
**Author:** Segev Shmueli
**Date:** 2026-05-18 (revised 2026-06-01)

## Summary

A `Connection` is the **stored instance** produced when a user completes an Auth flow. It holds the opaque credential blob, the display metadata used to label the connection, the reference to the App and Auth method that produced it, and the lifecycle state visible to the platform.

Connections are runtime entities, not publisher-authored manifests. This RFC defines the **logical schema** of a Connection so other primitives — Action, Invocation, Workflow, Run — can reference it portably. It does not mandate storage mechanics.

## Motivation

The Auth RFC describes how a user *connects* to an App. It is silent on what a connection *is* once it exists. Without a defined Connection:

- Actions can't be invoked against a specific stored credential — the [Invocation](./invocation.md) envelope has nothing to reference.
- Workflow steps can't be tied to a chosen connection.
- The Auth lifecycle has hooks but no state machine — hosts each invent one.
- The boundary between "what publishers see" (credential is opaque) and "what the host stores" (the credential blob plus metadata) is unstated.

## Goals

- Define a Connection's **logical schema**: identity, app/auth reference, credential blob, display metadata, state, timestamps.
- Define the **lifecycle state machine** so hosts agree on what each Auth hook transitions into.
- Define how Actions and Workflow steps **reference** a Connection.
- Define a **redacted projection** so userland code (Actions) never sees the credential.
- Stay **serialization-agnostic** like the rest of the spec.

## Non-Goals

- Storage mechanics, encryption-at-rest, key management — still the host's concern (carried over from Auth RFC).
- Wire format for syncing connections across hosts.
- Sharing semantics — see Open Questions.
- Audit and observability surfaces — covered by Run RFC.

## Concept

A Connection is the **runtime view** of an Auth method. The Auth manifest is "how to log in." A Connection is "the result of logging in," for one principal, against one App, via one Auth method.

The credential remains **opaque** to the platform. A Connection wraps it, but never introspects it. Auth's `sign` hook is still the only thing that ever reads the credential blob.

### Lifecycle

| State | Meaning | Entered when |
|---|---|---|
| `pending` | User started a flow, not yet finished. | Flow initiated. |
| `connected` | Credential live; `test` last passed. | `exchange` returned and `test` passed. |
| `needs_refresh` | Credential expired or was rejected; `refresh` should run. | `test` failed with a refreshable error, or `expiresAt` passed. |
| `broken` | Connection needs user attention. | `refresh` failed, or `test` failed with a non-refreshable error. |
| `revoked` | Terminal. Credential revoked. | User disconnected, `revoke` succeeded, or remote revoked. |

Transitions are driven by Auth hooks — `exchange`, `test`, `refresh`, `revoke`. Hosts may not invent additional transitions.

## Shape

### Stored record

```json
{
  "manifestVersion": "1",
  "id": "conn_01HXY3Q9PZ...",
  "app": "com.acme.slack",
  "auth": "./auth/oauth2.json",
  "owner": "user_8x7H...",
  "state": "connected",
  "credential": "<opaque blob>",
  "display": {
    "user": { "name": "Alice", "id": "U123" },
    "team": { "name": "Acme",  "id": "T456" }
  },
  "label": "Alice — Acme",
  "createdAt":       "2026-05-01T14:22:09Z",
  "lastTestedAt":    "2026-05-18T09:00:00Z",
  "lastRefreshedAt": "2026-05-15T03:11:00Z",
  "expiresAt":       "2026-05-22T03:11:00Z"
}
```

### Redacted projection

The same record, as exposed to any userland code (Action `execute`, Workflow steps, editor previews):

```json
{
  "id": "conn_01HXY3Q9PZ...",
  "app": "com.acme.slack",
  "auth": "./auth/oauth2.json",
  "owner": "user_8x7H...",
  "state": "connected",
  "display": { "user": { "name": "Alice", "id": "U123" }, "team": { "name": "Acme", "id": "T456" } },
  "label": "Alice — Acme",
  "createdAt": "2026-05-01T14:22:09Z",
  "lastTestedAt": "2026-05-18T09:00:00Z",
  "expiresAt": "2026-05-22T03:11:00Z"
}
```

The `credential` field is **stripped**. `lastRefreshedAt` is **stripped** (leaks rotation cadence). Everything else is intact.

Only Auth `sign` / `refresh` / `revoke` hooks ever receive the unredacted record.

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `manifestVersion` | string | ✅ | Core spec version. |
| `id` | string | ✅ | Stable, host-issued identifier. Opaque outside the host. |
| `app` | string (app id) | ✅ | The App this Connection authorizes against. |
| `auth` | string (path) | ✅ | Reference to the Auth manifest that produced this Connection. Same path the App manifest uses. |
| `owner` | string | ✅ | Host-issued identifier of the principal that owns the Connection (user, workspace, etc.). |
| `state` | enum | ✅ | Lifecycle state. |
| `credential` | opaque | ⬜ | Whatever `exchange` returned. Present only on states where a credential exists. **Host-encrypted at rest. Never present in the redacted projection.** |
| `display` | object | ⬜ | Free-form metadata populated by Auth's `afterConnect`. Source of `connectionLabel` variables. |
| `label` | string | ⬜ | Rendered `connectionLabel`. Cached for list views; re-rendered when `display` changes. |
| `createdAt` | timestamp | ✅ | When the Connection was first persisted. |
| `lastTestedAt` | timestamp | ⬜ | Last successful `test`. |
| `lastRefreshedAt` | timestamp | ⬜ | Last successful `refresh`. Redacted in the projection. |
| `expiresAt` | timestamp | ⬜ | When known (e.g. OAuth `expires_in`). Drives proactive refresh scheduling. |

## Referencing a Connection

Actions and Workflow steps refer to a Connection by `id`. The Action invocation envelope (see [Invocation](./invocation.md)) carries the `connection` field. The platform resolves it to the Connection record at runtime and feeds the credential into the Auth `sign` hook. The Action receives the **redacted projection** if it asks for connection context at all.

## Credential handling rules

The Auth RFC declares credentials opaque. This RFC tightens that into testable invariants:

1. The blob is whatever `exchange` returned. The platform never parses it.
2. The host encrypts it at rest. Encryption mechanism is host-defined.
3. The blob is decrypted only to be passed to `sign`, `refresh`, or `revoke`.
4. No userland surface — Action `execute`, Workflow expressions, editor previews, logs, traces — ever sees the blob.
5. A Connection record exposed to userland MUST be the redacted projection.

## Import

When a Connection is migrated from another host (export from host A, import to host B), the imported record MUST land in state `needs_refresh`. The receiving host runs the Auth `refresh` (or, for credentials without a refresh hook, `test`) before transitioning to `connected`. Trusting the source's `connected` state silently across hosts is not spec-compliant — re-validation is cheap and is the only thing that guarantees the credential is live in the new environment.

## Resolved questions

| Question | Resolution |
|---|---|
| Sharing | **Deferred.** `owner` is a single principal in `manifestVersion: "1"`. Multi-owner / team sharing will be a follow-up RFC that introduces a separate access table; the Connection record stays slim. |
| Multi-account hints | **N Connections, one per account.** Flows that authorize multiple workspaces in one credential (Slack, GitHub orgs) produce one Connection per workspace. Grouping in the UI is a host concern. |
| Credential rotation outside `refresh` | **Invisible to the platform.** Schemes that derive per-request signatures from a long-lived key (AWS SigV4, etc.) do the derivation inside `sign` and do not mutate the stored credential. Connections that genuinely need rotation use `refresh`. |
| Health probe scheduling | **Host's choice.** No `nextTestAt` field. Hosts derive scheduling from `expiresAt`, `lastTestedAt`, and their own policy. |
| State on import | `needs_refresh`. See [Import](#import) above. |
| Display metadata schema | **Deferred.** `display` remains free-form for `v1`. Optional `displaySchema` in the Auth manifest may be added later without breakage. |
