# RFC: Trigger Protocol

**Status:** Draft
**Author:** Segev Shmueli
**Date:** 2026-10-30

## Summary

The **W6W Trigger Protocol** (v1) is a delivery kind for [Triggers](./trigger.md): `delivery: "w6w-protocol"`. A partner that already owns an event source (an events platform, a ticketing system) implements a small, fixed HTTP surface. The host registers one **subscription** per workflow trigger node with the partner, and the partner pushes signed, batched **fires** to a single host endpoint. The host never polls and the partner never holds a w6w secret. This RFC defines the manifest declaration, the registration API the host calls (`{baseUrl}/w6w/v1/...`), the fire endpoint the partner calls (`POST {w6wOrigin}/triggers/protocol/v1/events`), the signing scheme, the lifecycle, the filter grammar, versioning and discovery, and what the host records. It extends [Trigger](./trigger.md) (the fourth delivery kind) and is paired with a partner-facing handoff that restates the wire contract field for field.

## Motivation

Today a trigger is one of two forms: a **webhook** (the app's sandboxed `onSubscribe` hook registers a URL with the vendor, the vendor posts to `/triggers/webhooks/:subscriptionId`) or a **poll** (the host asks on an interval). Both put per-vendor code in the sandbox and neither authenticates the sender: the webhook URL is a bearer secret. A partner that wants to be a first-class event source has to ship a sandboxed app that hand-rolls registration, and the host can never tell a genuine fire from a replay of a leaked URL.

Prior art for the signing primitive is the control-link and hub-spoke wire (Ed25519 compact JWS, `jti` replay store, `bodySha256` binding, `aud` separation): this protocol reuses that construction with its own `aud` and `typ` rather than inventing a scheme.

## Goals

- **One protocol, many partners.** A partner implements the surface once; no per-partner host code and no sandbox hook.
- **Push, batched, at-least-once**, with host-side dedupe so a partner retry is harmless.
- **Authenticated fires**: only the holder of a key the operator trusted can fire, and every signature is bound to the exact request.
- **Declarative.** The trigger is declared in the manifest; the host is the registration client.
- **Full lifecycle**: create, update in place, pause/resume, delete, reconcile.
- **Evolvable**: path- and header-versioned, with a capability document and a versioned filter grammar.

## Non-Goals

- **Non-workflow subscribers.** A fire still starts a workflow run; the protocol is a source-side delivery kind, not a subscriber class ([trigger.md](./trigger.md) Non-Goals).
- **Filter evaluation by the host in v1** (decided, see [Decisions](#decisions)). The host passes filters through.
- **Per-subscription shared secrets (HMAC-SHA256).** Considered, not v1: the host would store and transmit many secrets and invent its own replay scheme. The asymmetric scheme holds no host secret. It could be added later as an additional `typ`/header without changing the endpoints.
- **Partner-initiated registration.** The host registers; the partner never creates a subscription on its own.
- **Streaming and ordering.** Fires are unordered across events; a partner SHOULD send an entity's events in order but the host does not enforce it.
- **Replacing webhook and poll.** They are unchanged.

## Concept

```
 workflow publish ──► host registers ──►  POST {baseUrl}/w6w/v1/subscriptions   (partner stores it)
                       (Authorization: node connection's credential)

 partner event ─────► partner signs ───►  POST {w6wOrigin}/triggers/protocol/v1/events
                       (W6W-Signature: JWS)       │
                                                  ▼
                              verify ─► dedupe ─► store trigger event ─► run starts at the trigger node
```

- **Subscription.** One per published trigger node. `subscriptionId` is w6w's id, used by both sides for the life of the registration. The partner's own id is `partnerSubscriptionId`. A protocol subscription is always node-bound and has subscription type `"protocol"`.
- **Two directions, two credentials.** Host to partner: the bearer credential of the trigger node's own connection (the credential the app's actions use). Partner to host: an Ed25519 signature verifiable from the partner's published JWKS. Neither side stores a secret of the other.
- **Trust.** The manifest names the keys the host trusts to fire (via `jwksUrl`), so only operator-installed apps (global or tenant tier) may declare the delivery kind.
- **Persist-then-dispatch** is unchanged ([trigger.md](./trigger.md)): a fire is durably stored as a trigger event before the 200, then dispatched to a run at the bound node.

## Shape

### Manifest declaration (R-1, R-2)

A protocol trigger sets an authored `delivery` and a `protocol` block on the trigger declaration. The loader preserves `delivery` (it is not the host-derived `type`). The partner endpoint is declared **once per app**:

```json
{
  "id": "vip.cohost.w6w",
  "protocol": {
    "baseUrl": "https://api.cohost.vip",
    "jwksUrl": "https://api.cohost.vip/.well-known/w6w-jwks.json",
    "versions": [1]
  },
  "network": { "allow": ["api.cohost.vip"] },
  "triggers": [
    {
      "key": "order-placed",
      "title": "Order placed",
      "delivery": "w6w-protocol",
      "protocol": { "events": ["order.placed"], "filters": { "versions": [1] } },
      "requiresAuth": true,
      "params": [{ "key": "eventId", "label": "Event", "type": "string" }]
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `protocol.baseUrl` (app level) | string (https URL) | yes | Origin and optional path prefix of the partner API. The registration API is `{baseUrl}/w6w/v1/...`. No query or fragment; a trailing slash is ignored. |
| `protocol.jwksUrl` (app level) | string (https URL) | yes | Where the partner publishes the public keys that sign fires. |
| `protocol.versions` (app level) | integer[] | yes | Protocol versions the app speaks. v1: `[1]`. |
| `delivery` (trigger) | string | yes | `"w6w-protocol"`. Absent means webhook or poll, as before. |
| `protocol.events` (trigger) | string[] | yes | Event types this trigger delivers (at least one), each a `type` in the partner's capability document. |
| `protocol.filters.versions` (trigger) | integer[] | no | Filter grammar versions the trigger accepts. Default `[1]`. |

Rules the loader and validator enforce:

1. `baseUrl` and `jwksUrl` MUST be `https`, and both hosts MUST be in the app's `network.allow`. `http` is accepted only for a loopback host (`localhost`, `127.0.0.1`, `[::1]`), for local testing; w6w's egress refuses loopback in production.
2. A protocol trigger MUST NOT declare `onSubscribe`, `onUnsubscribe` or `poll`; the host is the registration client. An optional output parser (`parseOutput`) stays allowed. `handleIngest` is never invoked for a protocol fire (the envelope `payload` is already the normalized event).
3. Only an app installed at the **global or tenant tier** (operator-installed) may declare `delivery: "w6w-protocol"`; a user-tier app that does is refused at validation. The manifest names the keys w6w trusts for fires.
4. `type` for webhook and poll triggers is unchanged. The subscription created for a protocol trigger has `type: "protocol"`.
5. The registration `eventType` is the single entry of `protocol.events`; if the trigger lists several, it MUST declare a select param named `eventType` whose options are drawn from `protocol.events`, and that param's value is the `eventType` (the param is not repeated in `params`).
6. Filters, when the user sets them on the trigger node, are a node-level `filters` value in grammar `protocol.filters.versions`; they are not part of `params`.

### Registration client (R-4)

The host is the registration client. It calls `{baseUrl}/w6w/v1/subscriptions` authenticated with **the trigger node's own connection credential**, the same credential the app's actions use (for cohost, its `tenantAuth` client-credentials link, naming the publishing user as `sub`). A connection that needs an interactive user token is refused for protocol triggers: background retry and reconcile run with no user present. The host refuses to register when it has no configured public callback origin (a self-host without one cannot receive fires).

Every call to the partner carries the host-to-partner headers:

<a id="wire-http-headers-w6w-to-partner"></a>
<!-- wire: http-headers-w6w-to-partner -->
| name | type | required | description | example |
|---|---|---|---|---|
| `Authorization` | `string` | yes | `Bearer <access token>`. The token is minted for the user (`subject`) who published the workflow, by the same credential flow your API already accepts from w6w for workflow actions. Never a w6w-issued secret. | `Bearer fake-access-token-do-not-use` |
| `W6W-Protocol-Version` | `string` | yes | Protocol version of this call. Always `1` in v1. | `1` |
| `Accept` | `string` | yes | Always `application/json`. | `application/json` |
| `Content-Type` | `string` | no | `application/json` on calls that carry a body (create, update). Absent on bodiless calls. | `application/json` |

Every response, in both directions, carries:

<a id="wire-http-headers-response"></a>
<!-- wire: http-headers-response -->
| name | type | required | description | example |
|---|---|---|---|---|
| `Content-Type` | `string` | yes | `application/json` on every response that has a body. | `application/json` |
| `Retry-After` | `integer` | no | Seconds to wait before retrying. Sent with 429 and 503, and honoured by the receiver when present. | `30` |

#### Capability document (R-8)

`GET {baseUrl}/w6w/v1/capabilities` (no body). The host fetches it before the first registration of an app and caches it for 1 h, re-fetching when a registration is refused with `unsupported_protocol_version` or `unknown_event_type`. Response 200:

<a id="wire-capabilities-response"></a>
<!-- wire: capabilities-response -->
| name | type | required | description | example |
|---|---|---|---|---|
| `protocolVersions` | `integer[]` | yes | Protocol versions your endpoints speak. Must contain `1`. | `[1]` |
| `events` | `object[]` | yes | The event types you can deliver. One [capabilities-event](#wire-capabilities-event) per type. | `[{"type":"order.placed",...}]` |
| `filters` | `object` | yes | Filter grammar support. See [capabilities-filters](#wire-capabilities-filters). | `{"versions":[1]}` |
| `operations` | `object` | yes | Optional operations you implement. See [capabilities-operations](#wire-capabilities-operations). | `{"update":true,"pause":true,"list":true}` |

<a id="wire-capabilities-event"></a>
<!-- wire: capabilities-event -->
| name | type | required | description | example |
|---|---|---|---|---|
| `type` | `string` | yes | Event type name, lowercase dotted. This is the `eventType` used everywhere else. | `order.placed` |
| `description` | `string` | yes | One line, human readable. Shown to w6w users. | `A guest completed checkout.` |
| `payloadSchema` | `object` | no | JSON Schema (draft 2020-12) of the `payload` you send for this type. Used to help users map fields. | `{"type":"object","properties":{...}}` |

<a id="wire-capabilities-filters"></a>
<!-- wire: capabilities-filters -->
| name | type | required | description | example |
|---|---|---|---|---|
| `versions` | `integer[]` | yes | Filter grammar versions you can apply. `[]` means you apply no filters. v1 defines grammar version `1`. | `[1]` |

<a id="wire-capabilities-operations"></a>
<!-- wire: capabilities-operations -->
| name | type | required | description | example |
|---|---|---|---|---|
| `update` | `boolean` | yes | `true` if you implement `PATCH` on a subscription. If `false`, w6w deletes and re-creates (with a new `subscriptionId`) when a user changes a trigger's settings. | `true` |
| `pause` | `boolean` | yes | `true` if you implement pause and resume. If `false`, w6w never calls them and drops fires while a workflow is disabled. | `true` |
| `list` | `boolean` | yes | `true` if you implement the list endpoint. If `false`, w6w cannot detect registrations you hold that it has lost. | `true` |

```json
{
  "protocolVersions": [1],
  "events": [
    {
      "type": "order.placed",
      "description": "A guest completed checkout.",
      "payloadSchema": { "type": "object", "required": ["orderId"], "properties": { "orderId": { "type": "string" } } }
    }
  ],
  "filters": { "versions": [1] },
  "operations": { "update": true, "pause": true, "list": true }
}
```

If the document is unreachable or invalid, registration fails with the standard `failed` state and retries (see Lifecycle). `protocolVersions` MUST contain a version the host speaks; the host uses the highest common one (v1 hosts: `1`).

#### Create

`POST {baseUrl}/w6w/v1/subscriptions`, body:

<a id="wire-registration-request"></a>
<!-- wire: registration-request -->
| name | type | required | description | example |
|---|---|---|---|---|
| `subscriptionId` | `string` | yes | w6w's id for this subscription and the idempotency key of the create call. A repeat create with the same id returns the same registration. | `sub_01JC8Y2K7Q4M9X3VNT5R6ZB0HD` |
| `eventType` | `string` | yes | One of the `type` values in your capability document. | `order.placed` |
| `params` | `object` | yes | The trigger's settings, as configured by the user. Every secret-typed setting is omitted; w6w never sends one. May be `{}`. | `{"eventId":"evt_8812"}` |
| `filters` | `object or null` | no | Filter to apply before sending events, grammar in [filters](#wire-filters). Omitted or `null` means send every event of the type. | `{"version":1,"all":[...]}` |
| `callbackUrl` | `string` | yes | The https URL to POST fires to. Use exactly this value; do not build the URL yourself. The same value for every subscription of a w6w deployment. | `https://w6w.example.com/triggers/protocol/v1/events` |
| `identity` | `object` | yes | Who this subscription acts for. See [registration-identity](#wire-registration-identity). | `{"tenant":"cohost",...}` |
| `protocolVersion` | `integer` | yes | Protocol version of this request. Always `1` in v1. | `1` |

<a id="wire-registration-identity"></a>
<!-- wire: registration-identity -->
| name | type | required | description | example |
|---|---|---|---|---|
| `tenant` | `string` | yes | The w6w tenant (your own tenant name for you). | `cohost` |
| `account` | `object` | yes | The account inside the tenant. See [registration-account](#wire-registration-account). | `{"id":"acct_...","externalRef":"co_4471"}` |
| `subject` | `string` | yes | The user who published the workflow, in your own user-id space. You MUST check that this user may see the events (for example, owns the resource) before accepting the registration. | `usr_20418` |

<a id="wire-registration-account"></a>
<!-- wire: registration-account -->
| name | type | required | description | example |
|---|---|---|---|---|
| `id` | `string` | yes | w6w's own account id. Opaque to you; store it if you want to correlate. | `acct_01JC7WQ3H8E2D5F4G6A9B1C0ZK` |
| `externalRef` | `string or null` | yes | Your reference for the account (the company id you gave w6w). `null` if w6w has none. | `co_4471` |

`subscriptionId` is the idempotency key. A repeat create with the same `subscriptionId` and the same `eventType` returns the existing registration with **200** (not 201) and changes nothing; the same id with a different `eventType` is `409 conflict`. The host never sends a secret-typed param (R-10): `params` carries the node's params with every secret-typed param omitted. The partner MUST authorize `identity.subject` against the resource named in `params` and MUST scope the registration to `identity.account`; it MUST NOT trust the body alone.

Response **201** (new) or **200** (existing):

<a id="wire-registration-response"></a>
<!-- wire: registration-response -->
| name | type | required | description | example |
|---|---|---|---|---|
| `partnerSubscriptionId` | `string` | yes | Your own id for the registration. | `psub_9d2e41c7` |
| `acceptedFilters` | `object or null` | yes | The filters you will actually apply: the request's `filters`, a subset of its clauses, or `null` if you apply none (you then send every event of the type). | `{"version":1,"all":[...]}` |
| `status` | `string` | yes | `active` or `paused`. | `active` |

```json
{ "partnerSubscriptionId": "psub_9d2e41c7", "acceptedFilters": { "version": 1, "all": [{ "path": "/guest/tier", "op": "eq", "value": "vip" }] }, "status": "active" }
```

#### Update

`PATCH {baseUrl}/w6w/v1/subscriptions/{subscriptionId}` when the node's params or filters change. The subscription id survives. Only called if the capability document says `operations.update` is `true`; otherwise the host deletes and re-creates (with a **new** `subscriptionId`). Body:

<a id="wire-update-request"></a>
<!-- wire: update-request -->
| name | type | required | description | example |
|---|---|---|---|---|
| `params` | `object` | yes | The complete new settings (replaces the old ones). Secret-typed settings are omitted. | `{"eventId":"evt_9001"}` |
| `filters` | `object or null` | no | The complete new filter, or omitted/`null` for none. | `null` |
| `identity` | `object` | yes | Same shape and meaning as in the create request; re-authorize `subject` on every update. | `{"tenant":"cohost",...}` |
| `protocolVersion` | `integer` | yes | Always `1` in v1. | `1` |

Response **200**, a [registration-response](#wire-registration-response). `eventType` and `callbackUrl` cannot be changed by update.

#### Pause and resume

`POST {baseUrl}/w6w/v1/subscriptions/{subscriptionId}/pause` and `.../resume`, no body. The host calls them when the workflow is disabled or enabled. Response **200**, a [registration-response](#wire-registration-response) with `status` `paused` or `active`. Idempotent. Only called if `operations.pause` is `true`.

#### Delete

`DELETE {baseUrl}/w6w/v1/subscriptions/{subscriptionId}`, no body. Response **204**. Idempotent: the host treats **404 as success**. Called on node removal, workflow delete or archive, and connection delete.

#### List (reconcile)

`GET {baseUrl}/w6w/v1/subscriptions?callbackUrl=&cursor=&limit=`. Only called if `operations.list` is `true`. Returns the registrations created by the calling credential's tenant, paged by an opaque cursor. Query parameters:

Each w6w deployment has its own callbackUrl. Several deployments (local dev, staging, production) may share one partner tenant and credential, so w6w's reconcile deletes or re-registers only within the set this parameter selects and never touches another deployment's registrations.

<a id="wire-list-query"></a>
<!-- wire: list-query -->
| name | type | required | description | example |
|---|---|---|---|---|
| `cursor` | `string` | no | Opaque cursor from the previous page's `nextCursor`. Omit for the first page. | `c_Mw` |
| `limit` | `integer` | no | Page size, 1 to 200. Default 100. | `100` |
| `callbackUrl` | `string` | yes | The exact `callbackUrl` w6w sent at registration, URL-encoded. Only subscriptions whose stored `callbackUrl` equals it byte for byte are returned; if it is missing, answer `400 invalid_request`. | `https%3A%2F%2Fw6w.example.com%2Ftriggers%2Fprotocol%2Fv1%2Fevents` |

Response **200**:

<a id="wire-list-response"></a>
<!-- wire: list-response -->
| name | type | required | description | example |
|---|---|---|---|---|
| `subscriptions` | `object[]` | yes | One [list-item](#wire-list-item) per registration created by the calling credential's tenant. May be empty. | `[{"subscriptionId":"sub_...",...}]` |
| `nextCursor` | `string or null` | yes | Cursor for the next page, `null` on the last page. | `null` |

<a id="wire-list-item"></a>
<!-- wire: list-item -->
| name | type | required | description | example |
|---|---|---|---|---|
| `subscriptionId` | `string` | yes | w6w's id, as sent in the create request. | `sub_01JC8Y2K7Q4M9X3VNT5R6ZB0HD` |
| `partnerSubscriptionId` | `string` | yes | Your id, as returned in the create response. | `psub_9d2e41c7` |
| `eventType` | `string` | yes | The registration's event type. | `order.placed` |
| `status` | `string` | yes | `active` or `paused`. | `active` |

#### Errors

Every non-2xx response from a partner endpoint, and from the host's fire endpoint, has this body and `Content-Type: application/json`:

<a id="wire-error-body"></a>
<!-- wire: error-body -->
| name | type | required | description | example |
|---|---|---|---|---|
| `error` | `object` | yes | The error. See [error-detail](#wire-error-detail). Every non-2xx response from every endpoint of the protocol, in both directions, has exactly this body. | `{"code":"forbidden",...}` |

<a id="wire-error-detail"></a>
<!-- wire: error-detail -->
| name | type | required | description | example |
|---|---|---|---|---|
| `code` | `string` | yes | Machine-readable code from the error-code tables. Stable. | `forbidden` |
| `message` | `string` | yes | Human-readable explanation, safe to show in a UI. Never contains secrets or tokens. | `subject usr_20418 may not subscribe to this resource` |
| `retryable` | `boolean` | yes | `true` if repeating the identical request later can succeed. | `false` |

```json
{ "error": { "code": "forbidden", "message": "subject usr_20418 may not subscribe to this resource", "retryable": false } }
```

Partner error codes (statuses fixed by this table):

<!-- codes: partner-error-codes -->
| code | status | retryable | meaning |
|---|---|---|---|
| `invalid_request` | 400 | false | Body is not valid JSON, a required field is missing or has the wrong type. |
| `unauthorized` | 401 | false | Missing, expired or unacceptable bearer token. |
| `forbidden` | 403 | false | The token is valid but `identity.subject` may not subscribe to this. |
| `not_found` | 404 | false | No registration with that `subscriptionId`. |
| `conflict` | 409 | false | `subscriptionId` already exists with a different `eventType`. |
| `unknown_event_type` | 422 | false | `eventType` is not in your capability document. |
| `unsupported_filter_version` | 422 | false | `filters.version` is a grammar version you do not support. w6w then registers again with no filters. |
| `unsupported_protocol_version` | 422 | false | `protocolVersion` is not one you support. |
| `invalid_params` | 422 | false | `params` failed your validation. |
| `rate_limited` | 429 | true | Too many requests. |
| `internal_error` | 500 | true | Unexpected failure on your side. |
| `unavailable` | 503 | true | Temporarily unable to serve. |

Partner response codes and what the host does:

<!-- codes: partner-endpoint-codes -->
| status | applies to | w6w does | meaning |
|---|---|---|---|
| `200` | create (existing), update, pause, resume, capabilities, list | success | The call succeeded. For create, the registration already existed. |
| `201` | create | success | A new registration was created. |
| `204` | delete | success | Deleted. No body. |
| `400` | any | fail | Malformed request (`invalid_request`). Not retried. |
| `401` | any | fail | The bearer token was refused (`unauthorized`). Shown to the user; retried only by the hourly reconcile and manual retry. |
| `403` | any | fail | `subject` may not do this (`forbidden`). Not retried. |
| `404` | delete | success | Already gone. Delete is idempotent. |
| `404` | update, pause, resume | re-create | The registration is unknown to you (`not_found`). w6w re-creates it. |
| `409` | create | fail | The `subscriptionId` exists with a different `eventType` (`conflict`). |
| `422` | create, update | fail | Semantically invalid: `unknown_event_type`, `unsupported_protocol_version` or `invalid_params`. |
| `422` with `unsupported_filter_version` | create, update | re-register without filters | You do not support `filters.version`. w6w registers again with no filters; this is automatic and is not a failure. |
| `429` | any | retry | Slow down (`rate_limited`). w6w honours `Retry-After`. |
| `5xx` | any | retry | Your server failed (`internal_error`, `unavailable`). w6w retries with backoff. |

### Fire (R-5)

ONE endpoint serves every subscription: `POST {w6wOrigin}/triggers/protocol/v1/events`, where `{w6wOrigin}` is the origin of the `callbackUrl` the partner received (the registration carries the full URL; a partner uses it verbatim). Request headers:

<a id="wire-http-headers-partner-to-w6w"></a>
<!-- wire: http-headers-partner-to-w6w -->
| name | type | required | description | example |
|---|---|---|---|---|
| `W6W-Signature` | `string` | yes | The compact JWS (three base64url parts joined by `.`) that signs this request. No scheme prefix. See Signing. | `eyJhbGciOiJFZERTQSIs...` |
| `W6W-Protocol-Version` | `string` | yes | Protocol version of this call. Always `1` in v1. | `1` |
| `Content-Type` | `string` | yes | Always `application/json`. | `application/json` |

Body, 1 to 100 envelopes per request, at most 1 MiB:

<a id="wire-fire-request"></a>
<!-- wire: fire-request -->
| name | type | required | description | example |
|---|---|---|---|---|
| `events` | `object[]` | yes | 1 to 100 [fire-envelope](#wire-fire-envelope) objects. May mix subscriptions and event types. | `[{"eventId":"evt_...",...}]` |

<a id="wire-fire-envelope"></a>
<!-- wire: fire-envelope -->
| name | type | required | description | example |
|---|---|---|---|---|
| `eventId` | `string` | yes | Your unique id for this event (1 to 128 characters). It MUST be identical on every retry of the same event. | `evt_01JC8Z4M2N7P5Q9R3T6V8X0YAB` |
| `subscriptionId` | `string` | yes | w6w's `subscriptionId` from the registration this event is for. | `sub_01JC8Y2K7Q4M9X3VNT5R6ZB0HD` |
| `eventType` | `string` | yes | The event type; must equal the registration's `eventType`. | `order.placed` |
| `occurredAt` | `string` | yes | When the event happened, RFC 3339 with a time zone. | `2026-10-30T18:42:07Z` |
| `payload` | `object` | yes | The event data a workflow will see. A JSON object; if you declared a `payloadSchema` it should match. | `{"orderId":"ord_58213",...}` |

```json
{"events":[{"eventId":"evt_01JC8Z4M2N7P5Q9R3T6V8X0YAB","subscriptionId":"sub_01JC8Y2K7Q4M9X3VNT5R6ZB0HD","eventType":"order.placed","occurredAt":"2026-10-30T18:42:07Z","payload":{"orderId":"ord_58213","guest":{"id":"gst_1042","tier":"vip"},"total":{"amount":12500,"currency":"USD"}}}]}
```

The host answers **200** with one result per envelope, in order, whenever the request was authentic and well-formed, even if some or all events were not accepted:

<a id="wire-fire-response"></a>
<!-- wire: fire-response -->
| name | type | required | description | example |
|---|---|---|---|---|
| `results` | `object[]` | yes | Exactly one [fire-result](#wire-fire-result) per envelope, in the same order as the request. | `[{"eventId":"evt_...","status":"accepted"}]` |

<a id="wire-fire-result"></a>
<!-- wire: fire-result -->
| name | type | required | description | example |
|---|---|---|---|---|
| `eventId` | `string` | yes | The `eventId` this result is for. | `evt_01JC8Z4M2N7P5Q9R3T6V8X0YAB` |
| `status` | `string` | yes | `accepted`, `duplicate`, `ignored` or `rejected`. See the result-status table. | `accepted` |
| `reason` | `string` | no | Present when `status` is `ignored` or `rejected`: one of the reason codes in the reason table. | `unknown_subscription` |

```json
{ "results": [{ "eventId": "evt_01JC8Z4M2N7P5Q9R3T6V8X0YAB", "status": "accepted" }] }
```

Whole-request response codes:

<!-- codes: fire-response-codes -->
| status | partner action | meaning |
|---|---|---|
| `200` | done | The request was processed; read `results` for each event. |
| `400` | fix | Malformed request. Do not retry the same bytes. |
| `401` | fix | Signature or claims refused. Do not retry the same bytes; check key, clock and construction. |
| `413` | fix | Body over 1 MiB. Split the batch. |
| `429` | retry | w6w asks you to slow down. Wait at least `Retry-After`. |
| `5xx` | retry | Temporary failure at w6w. Retry with backoff. |

Per-event result statuses:

<!-- codes: fire-result-statuses -->
| status | partner action | meaning |
|---|---|---|
| `accepted` | done | w6w stored the event and will run the workflow. |
| `duplicate` | done | w6w already has an event with this `subscriptionId` and `eventId`. Nothing new was stored. |
| `ignored` | done | w6w deliberately dropped the event (see reason). Do not resend it. |
| `rejected` | fix | w6w refused the event (see reason). Do not resend it unchanged. |

Per-event reasons:

<!-- codes: fire-result-reasons -->
| reason | status | partner action | meaning |
|---|---|---|---|
| `unknown_subscription` | rejected | delete registration | The `subscriptionId` is unknown, deleted, belongs to another partner, or its trigger no longer exists in the workflow. Delete your registration and stop sending for it. |
| `paused` | ignored | none | The registration is paused. The event is dropped. Do not queue it for later. |
| `invalid_event` | rejected | fix | The envelope is well-formed JSON but invalid (for example `occurredAt` is not RFC 3339, or `payload` is not an object). |
| `event_type_mismatch` | rejected | fix | `eventType` differs from the registration's `eventType`. |

Host-side error codes on this endpoint:

<!-- codes: w6w-error-codes -->
| code | status | retryable | meaning |
|---|---|---|---|
| `invalid_request` | 400 | false | The body is not valid JSON, `events` is missing, empty or longer than 100, or an envelope is malformed. |
| `unauthorized` | 401 | false | Any signature or claim failure. One code and one message for every cause, so a caller cannot learn which check failed. |
| `payload_too_large` | 413 | false | The body is over 1 MiB. Send smaller batches. |
| `rate_limited` | 429 | true | w6w is shedding load. Honour `Retry-After`. |
| `internal_error` | 500 | true | Unexpected failure at w6w. |
| `unavailable` | 503 | true | w6w cannot serve right now (including: it could not fetch your JWKS). |

A 401 body is always `{"error":{"code":"unauthorized","message":"unauthorized","retryable":false}}`, byte for byte, for every signature or claim failure: no detail is given about which check failed. A subscription that does not exist, was deleted, is not owned by the signing partner (`iss` is not the app that owns the subscription), or whose trigger node no longer exists in the published workflow is `rejected` with reason `unknown_subscription` in every case, so a partner cannot learn whether an id exists for another partner. A paused subscription yields `ignored` with reason `paused`. A subscription is always bound to a trigger node; the fire starts a run **at that node** (the run seed's entry is the node; see [trigger.md](./trigger.md) amendment 2026-10-30 and the Engine RFC).

#### Partner retry and idempotency

The partner delivers **at least once**. On a response that is not a final outcome (network error, 429, 5xx, or a 200 whose result is not final) it retries with exponential backoff, the same `eventId`, and a **fresh signature (new `jti`, new `iat`)** on every attempt:

<!-- codes: retry-schedule -->
| parameter | value | meaning |
|---|---|---|
| `initial delay` | 10 s | Wait before the first retry of an event or request that failed with a retry outcome. |
| `backoff factor` | factor 2 | Each further wait is the previous wait times 2 (10 s, 20 s, 40 s, ...). |
| `maximum delay` | 1 h | No wait grows beyond this. |
| `give up after` | 24 h | Stop retrying an event 24 h after its first attempt. Same `eventId`, a fresh signature on every attempt. |

It honours `Retry-After` when present (the wait is the larger of the backoff and `Retry-After`, still capped at the maximum delay). A 400, 401 or 413 is not retried unchanged. The host deduplicates on `(subscriptionId, eventId)` for at least 7 days and answers `duplicate`; the dedupe check runs before any state change, so a retry after a lost response is harmless.

Limits applied by the host:

<!-- codes: limits -->
| limit | value | meaning |
|---|---|---|
| `events per request` | 100 | Maximum envelopes in one fire request. |
| `request body` | 1 MiB | Maximum fire request body. Larger gets 413. |
| `signature lifetime` | 300 s | Maximum `exp` minus `iat` that w6w will accept. |
| `signature age` | 60 s | w6w accepts a signature up to 60 s after `iat` (plus the skew below). |
| `clock skew` | 30 s | Tolerance applied both ways. |
| `duplicate memory` | 7 days | w6w remembers `(subscriptionId, eventId)` at least this long. |
| `call timeout` | 15 s | w6w gives up on a single call to your endpoints after 15 s and treats it as a retryable failure. |
| `JWKS cache` | 10 min | w6w caches your JWKS this long, and re-fetches at most once a minute when it sees an unknown `kid`. |

### Signing, partner to host (R-3)

**Decided** (see [Decisions](#decisions)): the scheme below is the v1 scheme.

Every fire is signed by the partner with an **Ed25519** key as a **JWS compact** serialization carried in the `W6W-Signature` header. The partner publishes its public keys as a JWKS at the manifest's `jwksUrl`; rotation is "publish two keys, `kid` selects": publish the new key next to the old one, wait at least 20 minutes, start signing with the new `kid`, and remove the old key at least 10 minutes after the last signature with it. To revoke a compromised key, remove it from the JWKS; w6w stops accepting it within 10 minutes, and for an immediate cut-off contact w6w so an operator flushes the cached JWKS. w6w stores no per-subscription secret.

JWKS document served at `jwksUrl` (HTTPS, `Content-Type: application/json`):

<a id="wire-jwks-document"></a>
<!-- wire: jwks-document -->
| name | type | required | description | example |
|---|---|---|---|---|
| `keys` | `object[]` | yes | The public keys you currently sign with, plus any key you are rotating in or out. One [JWK](#wire-jwk) per key. Serve it over https at the `jwksUrl` you gave w6w. | `[{"kty":"OKP",...}]` |

<a id="wire-jwk"></a>
<!-- wire: jwk -->
| name | type | required | description | example |
|---|---|---|---|---|
| `kty` | `string` | yes | Key type. Always `OKP`. | `OKP` |
| `crv` | `string` | yes | Curve. Always `Ed25519`. | `Ed25519` |
| `x` | `string` | yes | The 32-byte public key, base64url without padding (43 characters). | `BJbHuTi6HfewpoRFw8QqBXzg-sv9WDaAPBbyGf_0rs4` |
| `kid` | `string` | yes | Key id, unique within the document. The `kid` in a JWS header selects the key. | `cohost-2026-10` |
| `use` | `string` | no | If present, `sig`. | `sig` |
| `alg` | `string` | no | If present, `EdDSA`. | `EdDSA` |

JWS protected header:

<a id="wire-jws-header"></a>
<!-- wire: jws-header -->
| name | type | required | description | example |
|---|---|---|---|---|
| `alg` | `string` | yes | Always `EdDSA`. Any other value is refused. | `EdDSA` |
| `typ` | `string` | yes | Always `w6w-trigger+jwt`. Any other value is refused. | `w6w-trigger+jwt` |
| `kid` | `string` | yes | The `kid` of the key in your JWKS that made the signature. | `cohost-2026-10` |

JWS payload (claims), exactly these eight and no others:

<a id="wire-jws-claims"></a>
<!-- wire: jws-claims -->
| name | type | required | description | example |
|---|---|---|---|---|
| `iss` | `string` | yes | Your app id, exactly as w6w knows your app. Identifies the signer. | `vip.cohost.w6w` |
| `aud` | `string` | yes | Always `w6w-trigger`. | `w6w-trigger` |
| `iat` | `integer` | yes | Issued-at, Unix seconds. Set it to the moment you sign, on EVERY attempt. | `1790337600` |
| `exp` | `integer` | yes | Expiry, Unix seconds. At most 300 s after `iat`; use `iat` + 60. | `1790337660` |
| `jti` | `string` | yes | Unique id of this signature, new for every attempt (a UUID). A `jti` seen twice is refused. | `2f6b3c1e-8d4a-4b7e-9a15-0c3e5d7f9b21` |
| `htm` | `string` | yes | HTTP method of the request being signed. Always `POST`. | `POST` |
| `htu` | `string` | yes | Path of the request URL, no scheme, host or query string. | `/triggers/protocol/v1/events` |
| `bodySha256` | `string` | yes | base64url (no padding) SHA-256 of the exact request body bytes. | `0z87A9kVW5CYgsSWoWVl5HFeeXmOQJUuzW1Ev1zyR74` |

Construction:

1. Serialize the body to bytes and keep those exact bytes for sending.
2. `bodySha256` = base64url (no padding) of SHA-256 over those bytes.
3. Build the header and claims objects; `iat` = now, `exp` = `iat` + 60, `jti` = a fresh UUID, `htm` = `POST`, `htu` = the path of the `callbackUrl`.
4. Signing input = `base64url(header JSON) + "." + base64url(claims JSON)` (UTF-8, no padding).
5. Signature = Ed25519 over the ASCII bytes of the signing input; the token is `signingInput + "." + base64url(signature)`.
6. Send the token as the `W6W-Signature` header value.

Verification (the host), in order; every failure is a uniform 401:

1. Header present; compact form; `alg` is `EdDSA`, `typ` is `w6w-trigger+jwt` (anything else, including `none`, is refused before any key lookup).
2. Read `iss` only as a lookup hint: it must name an installed global- or tenant-tier app that declares `protocol`; load that app's JWKS from its **manifest** `jwksUrl` (never a URL from the token), cached up to 10 minutes, re-fetched at most once a minute on an unknown `kid`. If the JWKS cannot be fetched at all the response is 503 (retryable), not 401.
3. Select the key by `kid` from that JWKS only; verify the signature.
4. The claim set is exactly the eight claims; `aud` = `w6w-trigger`; `iss` equals the app id; `htm` = the request method; `htu` = the request path; `bodySha256` = base64url SHA-256 of the received raw bytes.
5. Window (mirrors the control-link request artifact's 60 s lifetime and 30 s skew; see the limits table): `exp - iat` ≤ 300 s; `iat` no more than 30 s in the future; now no more than 60 s past `iat` plus 30 s skew, and no more than 30 s past `exp`.
6. Replay: `jti` is inserted into a nonce store (insert-if-absent, retained for at least 90 s past `iat`); a `jti` already present is refused. A refused request never consumes a nonce.
7. Only then is the body parsed, and per-event dedupe on `(subscriptionId, eventId)` applies.

Worked example (fake key; see the handoff for the reproducible script). Header JSON `{"alg":"EdDSA","typ":"w6w-trigger+jwt","kid":"cohost-2026-10"}`, claims JSON `{"iss":"vip.cohost.w6w","aud":"w6w-trigger","iat":1790337600,"exp":1790337660,"jti":"2f6b3c1e-8d4a-4b7e-9a15-0c3e5d7f9b21","htm":"POST","htu":"/triggers/protocol/v1/events","bodySha256":"0z87A9kVW5CYgsSWoWVl5HFeeXmOQJUuzW1Ev1zyR74"}`, resulting token:

```
eyJhbGciOiJFZERTQSIsInR5cCI6Inc2dy10cmlnZ2VyK2p3dCIsImtpZCI6ImNvaG9zdC0yMDI2LTEwIn0.eyJpc3MiOiJ2aXAuY29ob3N0Lnc2dyIsImF1ZCI6Inc2dy10cmlnZ2VyIiwiaWF0IjoxNzkwMzM3NjAwLCJleHAiOjE3OTAzMzc2NjAsImp0aSI6IjJmNmIzYzFlLThkNGEtNGI3ZS05YTE1LTBjM2U1ZDdmOWIyMSIsImh0bSI6IlBPU1QiLCJodHUiOiIvdHJpZ2dlcnMvcHJvdG9jb2wvdjEvZXZlbnRzIiwiYm9keVNoYTI1NiI6IjB6ODdBOWtWVzVDWWdzU1dvV1ZsNUhGZWVYbU9RSlV1elcxRXYxenlSNzQifQ.0AXeAtNUuvD23tO5lm4c02qlPx4fGVzMTTdhT4l2PEDxJFB1gQpK0mX4GvYWYHYBg-LlPiIV0LvdTcv9oLtaAQ
```

### Filters (R-7)

**Decided** (see [Decisions](#decisions)): the host does not evaluate filters in v1.

Registration carries `filters`. Grammar version 1:

<a id="wire-filters"></a>
<!-- wire: filters -->
| name | type | required | description | example |
|---|---|---|---|---|
| `version` | `integer` | yes | Filter grammar version. Only `1` is defined. | `1` |
| `all` | `object[]` | yes | Clauses that must ALL match (logical AND). 1 to 20 [filter-clause](#wire-filter-clause) objects. | `[{"path":"/guest/tier","op":"eq","value":"vip"}]` |

<a id="wire-filter-clause"></a>
<!-- wire: filter-clause -->
| name | type | required | description | example |
|---|---|---|---|---|
| `path` | `string` | yes | A JSON Pointer (RFC 6901) into the event `payload`. | `/guest/tier` |
| `op` | `string` | yes | One of `eq`, `neq`, `in`, `exists`. | `eq` |
| `value` | `any` | no | Required for `eq` and `neq` (a JSON scalar) and `in` (a non-empty array of scalars). Must be absent for `exists`. | `"vip"` |

Operators: `eq` (equal), `neq` (not equal; true when the path is missing), `in` (value is one of the array), `exists` (the path is present, any value including `null`). `eq`, `in` and `neq` compare JSON scalars; a missing path makes `eq` and `in` false. The partner MAY evaluate filters and reports what it applied in `acceptedFilters` (the full object, a subset of clauses, or `null`). The host stores `acceptedFilters` and passes the filters through; **the host does not evaluate them in v1**, so a partner that ignores them sends the workflow every event. Extension point: a new `version` number. A partner that does not know the version refuses with `422 unsupported_filter_version`; the host then registers again with no filters and records that fact on the subscription.

### Lifecycle (R-6)

| Host event | Partner call | Notes |
|---|---|---|
| Workflow publish, trigger node added | create | Draft saves never register. |
| Publish, node params or filters changed | update (if `operations.update`) else delete then create (new `subscriptionId`) | The subscription id survives an update. |
| Workflow disabled | pause (if `operations.pause`) | Subscription state `paused`. If the partner has no pause, fires are `ignored` with reason `paused`. |
| Workflow enabled | resume | |
| Trigger node removed, workflow deleted or archived, connection deleted | delete | 404 counts as success. |
| Hourly, and on demand | list, then reconcile | w6w is the source of truth: a registration only the partner has is deleted at the partner; one only w6w has is re-created. |

Subscription states (host-side, visible per trigger node):

| State | Meaning |
|---|---|
| `pending` | Created, not yet registered. |
| `registered` | The partner accepted the registration (`active`). |
| `failed` | Registration or an update failed; `lastError` has the partner's `code` and `message` (at most 500 characters). When the partner's answer is a `retry` outcome (429, 5xx, no answer) it is retried automatically with backoff, starting at 30 s, factor 2, cap 1 h. A `fail` outcome (for example 403 or 422 `invalid_params`) is not retried automatically; it is retried on manual retry, on the next publish of the workflow and by the hourly reconcile. |
| `paused` | The partner has paused it, or the workflow is disabled. |
| `destroying` | Delete in progress. The row is removed afterwards regardless of the partner's answer; reconcile is the backstop for a partner that was unreachable. |

If the partner is unreachable at registration time, **the publish still succeeds**; the subscription is `failed` with a visible error and retries automatically. Delete is called as a best effort and never blocks the user's action.

### Versioning and discovery (R-8)

Path-versioned (`/w6w/v1/...` partner side, `/triggers/protocol/v1/...` host side) plus the header `W6W-Protocol-Version: 1` on every request in both directions. A request with an unsupported version is refused (`422 unsupported_protocol_version` by a partner; `400 invalid_request` by the host). A change that is not backward compatible gets a new path version and a new version number; additive changes (new optional fields, new filter grammar `version`s, new optional operations) do not. Receivers MUST ignore unknown fields in objects they receive (senders MUST NOT depend on that for required data). The capability document is the discovery mechanism.

### Observability (R-9)

**Decided** (see [Decisions](#decisions)): a fire's record is its run and its trigger event; no invocation row.

- Each fire is a trigger-event record (status `received` → `dispatched`, or `ignored` / `failed`) and the run started at the trigger node, linked by the run id.
- Registration state per trigger node (`registered` / `failed` / `paused`, last error, last fire time) is visible in Studio.
- Registration, update, pause, resume, delete and list calls are recorded as outbound API calls with the `Authorization` header redacted.
- The `W6W-Signature` header is never persisted in the stored event headers (it is a replayable credential for the duration of its window).

### Secrets (R-10)

No secret appears in a registration body, a fire response, a log line, or an example in this RFC except as an obviously fake placeholder. w6w never sends secret-typed params to a partner. The partner's key is public; the only secret a partner holds is its own signing key, which never leaves it.

## Security considerations

- **Authenticity**: Ed25519 over bound claims; verification pins `alg` and `typ`, selects keys only from the manifest's `jwksUrl`, and never lets the token choose its own signer.
- **Replay**: `jti` nonce store plus a 60 s + 30 s window; `bodySha256` ties the signature to the exact bytes; per-event dedupe survives a lost response.
- **Uniform refusal**: one 401 body for every signature or claim failure, and `unknown_subscription` for unknown, deleted, foreign and stale ids.
- **Operator trust**: only operator-installed apps declare the kind; its JWKS host must be in the app's `network.allow`.
- **Closing the old door**: a protocol subscription MUST be refused by the bearer-in-URL `POST /triggers/webhooks/:subscriptionId` route (its id is not a secret here).
- **Registration is authenticated by the node's own credential, not a w6w secret**, and carries the publishing `subject`, which the partner MUST authorize.
- **A partner key can fire any subscription of its own app.** Ownership is by app, not by tenant; the partner is trusted to route correctly within its app.
- **Egress**: the host calls the partner through its guarded fetch (no private or loopback destinations in production), without following redirects.

## Conformance

A host conforms when:

- a manifest with `delivery: "w6w-protocol"` and a valid `protocol` block loads, and a user-tier app declaring it is refused;
- publishing a workflow with a protocol trigger node produces exactly one create call per node with the headers and body above, and none for a draft save;
- a fire with a valid signature produces one stored trigger event and a run at the node; the same `eventId` again yields `duplicate`;
- every signature or claim failure produces the identical 401 body;
- the reference stub (a single-file partner server shipped with the host's tests, implementing every endpoint with in-memory state, with a helper that signs and sends fires) passes the full create / update / pause / resume / delete / list / fire / duplicate / rejected / paused flow against the host.

A partner conforms when it passes the host's checks in the handoff test plan.

## Decisions

Three product decisions were settled before v1; each is decided 2026-10-31 by the product owner and is the v1 behaviour everywhere in this RFC.

1. **Signing scheme.** Partner-signed Ed25519 JWS verified from the partner's JWKS (decided 2026-10-31 by the product owner). HMAC-SHA256 per subscription was considered and is not v1.
2. **Filter evaluation.** Only the partner evaluates filters; w6w passes them through (decided 2026-10-31 by the product owner).
3. **Fire record.** A fire is a trigger event plus the run it started; no invocation row (decided 2026-10-31 by the product owner).

## Status ladder

Use the project-wide ladder:

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze.
- `Final` — frozen for the current `manifestVersion`. Breaking changes require a new RFC and a `manifestVersion` bump.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.
