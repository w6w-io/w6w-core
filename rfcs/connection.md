# RFC: Connection

**Status:** Draft
**Author:** TBD
**Date:** 2026-05-18

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

## Open questions

1. **Sharing.** Can a Connection be shared between workspaces / teams / multiple owners? If so, `owner` becomes a list or moves to a separate access table.
2. **Multi-account hints.** OAuth flows that authorize multiple workspaces in one credential (Slack, GitHub orgs) — one Connection with sub-accounts, or N Connections sharing a refresh token?
3. **Credential rotation outside `refresh`.** Some credentials rotate via the `sign` hook (e.g., AWS SigV4 deriving short-lived signatures from a long-lived key). Does Connection need to model this, or is it invisible to the platform?
4. **Health probe scheduling.** Auth defers `test` cadence to the host. Should Connection record `nextTestAt` to make scheduling first-class?
5. **State on import.** When connections are migrated from another host, what state do they land in — `connected` (trust the source) or `needs_refresh` (force re-validation)?
6. **Display metadata schema.** `display` is free-form today. Worth declaring an optional `displaySchema` in the Auth manifest so hosts can validate `afterConnect` output?
