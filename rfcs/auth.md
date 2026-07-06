# RFC: Auth

**Status:** Final
**Author:** Segev Shmueli
**Date:** 2026-04-15 (revised 2026-06-01)

## Summary

An `Auth` manifest declares **how a user connects their account** to an App. It covers the common types (OAuth 2.0, API key, Basic, Bearer) plus a `custom` escape hatch for exotic flows, and exposes **lifecycle hooks** so a publisher can run code before, during, and after the connection is made — including per-request signing.

Auth manifests are **separate files** referenced from the App manifest. An App may reference multiple Auth files when it supports more than one connection method (e.g., OAuth 2.0 and API key).

## Motivation

Authentication is the single most divergent piece across integration platforms. Zapier, n8n, Make, Shopify — each invents its own shape for what should be a small, well-understood problem. A unified auth spec means:

- A publisher describes "how to log in to my service" once.
- Any compliant host can run the flow, store the resulting credential, and sign outgoing requests.
- Custom / bespoke auth doesn't require platform-specific escape hatches — it's the `custom` type with hooks.

## Goals

- Cover the common types out of the box: **OAuth 2.0**, **API key**, **Basic**, **Bearer**.
- Support fully **custom flows** via user-collected fields plus hooks.
- Provide a **lifecycle hook** model covering:
  - **Before** the flow (preflight setup)
  - **During** the flow (token exchange, per-request signing)
  - **After** the flow (validation, post-setup, refresh, revoke)
- Allow an App to expose **multiple Auth methods** via separate Auth files.
- Be serialization-agnostic (JSON / YAML / XML / TOML).

## Non-Goals

- Specifying secret storage, encryption-at-rest, or key management — that's the host's concern.
- Defining the runtime / language in which hooks execute — deferred to a separate runtime RFC.
- Re-specifying the OAuth 2.0 / OIDC RFCs — we reference them.
- Declaring credential shape — credentials are opaque (see Concept).

## Concept

An `Auth` describes **one** authentication method. Each Auth manifest has:

1. A **`type` discriminant** (`oauth2` / `apiKey` / `basic` / `bearer` / `custom` / `tenantAuth`).
2. A **type-specific configuration block** keyed by the type name.
3. A **`fields`** array of [Param](./param.md) entries — inputs collected from the user at connect time.
4. A **`hooks`** block — lifecycle callbacks (preflight, exchange, test, sign, refresh, revoke, afterConnect).

Only `hooks.test` is required. Everything else is optional and only declared when the auth type needs it.

### Credentials are opaque

The publisher's hooks own the full credential lifecycle:

- **`exchange`** decides what gets stored (the credential blob).
- **`sign`** uses the stored credential to inject auth into every outbound request.
- **`refresh`** updates the credential when it expires.

From the platform's view, the credential is an **opaque blob**. The spec does not declare its shape, and actions never access credential fields directly. An action emits a request; the request passes through `sign`; `sign` handles auth. This keeps tokens server-side and the action surface narrow.

## Shape

### Shared top-level fields

Every Auth manifest, regardless of `type`, starts with:

```json
{
  "manifestVersion": "1",
  "type": "oauth2",
  "displayName": "Sign in with Slack",
  "description": "OAuth 2.0 with PKCE.",
  "connectionLabel": "{{user.name}} — {{team.name}}"
}
```

`manifestVersion` declares which version of the Core spec this file targets — needed because Auth manifests are standalone files. There is no `id`; the App references Auth files by path, and `(app.id + filename)` is sufficient cross-reference.

### OAuth 2.0

```json
{
  "manifestVersion": "1",
  "type": "oauth2",
  "displayName": "Sign in with Slack",
  "oauth2": {
    "authorizationUrl": "https://slack.com/oauth/v2/authorize",
    "tokenUrl":         "https://slack.com/api/oauth.v2.access",
    "refreshUrl":       "https://slack.com/api/oauth.v2.access",
    "revokeUrl":        "https://slack.com/api/auth.revoke",
    "scopes":           ["chat:write", "channels:read"],
    "scopeSeparator":   " ",
    "pkce":             true,
    "extraAuthParams":  { "user_scope": "identity.basic" }
  },
  "hooks": {
    "test": "./hooks/test.ts",
    "sign": "./hooks/sign.ts"
  }
}
```

### API Key

```json
{
  "manifestVersion": "1",
  "type": "apiKey",
  "displayName": "API Key",
  "apiKey": {
    "in":     "header",
    "name":   "Authorization",
    "prefix": "Bearer "
  },
  "fields": [
    { "key": "apiKey", "label": "API Key", "type": "secret", "required": true }
  ],
  "hooks": {
    "test": "./hooks/test.ts"
  }
}
```

### Basic / Bearer

```json
{
  "manifestVersion": "1",
  "type": "basic",
  "displayName": "Basic Auth"
}
```

```json
{
  "manifestVersion": "1",
  "type": "bearer",
  "displayName": "Access Token",
  "fields": [
    { "key": "token", "label": "Access Token", "type": "secret", "required": true }
  ]
}
```

### Tenant Auth

```json
{
  "manifestVersion": "1",
  "type": "tenantAuth",
  "displayName": "Acme",
  "tenantAuth": { "link": "io.w6w.acme", "resourcePrefix": "urn:acme:" }
}
```

`tenantAuth` is defined by **provenance, not shape**: the credential is sourced
from the **tenant**, not entered by the user. There is no connect flow and no
user-collected `fields`. The host mints a live, per-subject credential from a
per-tenant "app link" (keyed by the acting principal's subject) and hands it to
this method's `sign` hook exactly like a `bearer` credential.

This is a platform-agnostic primitive: any partner that embeds w6w as a tenant
can expose its own API to its users' workflows with **zero per-user setup**. The
App only *declares* it uses tenant auth; the link config and secrets live host-
side and never ship in the app package. `tenantAuth.link` names the app link
(defaults to the App id); `tenantAuth.resourcePrefix` is an optional convention
the App uses to recognize/round-trip the partner's resource identifiers.

### Custom

```json
{
  "manifestVersion": "1",
  "type": "custom",
  "displayName": "HMAC Authentication",
  "fields": [
    { "key": "accountId",  "label": "Account ID",  "type": "string", "required": true },
    { "key": "privateKey", "label": "Private Key", "type": "secret", "required": true },
    {
      "key": "region",
      "label": "Region",
      "type": "select",
      "options": { "source": "./hooks/regions.ts" }
    }
  ],
  "hooks": {
    "preflight":    "./hooks/preflight.ts",
    "exchange":     "./hooks/exchange.ts",
    "test":         "./hooks/test.ts",
    "afterConnect": "./hooks/after-connect.ts",
    "sign":         "./hooks/sign-request.ts",
    "refresh":      "./hooks/refresh.ts",
    "revoke":       "./hooks/revoke.ts"
  }
}
```

## Lifecycle

Every auth flow passes through the same phases. Each phase has an optional hook (except `test`, which is required).

| Hook | Phase | Runs | Purpose |
|---|---|---|---|
| `preflight` | connect | Before the user is prompted | Any setup needed before the flow starts (e.g. fetch a one-time request token). |
| `exchange` | connect | After the user completes the flow | Exchange an auth code or raw form input for a stored credential. Returns the opaque credential blob. |
| `test` | connect + periodic | After `exchange`, and on schedule | **Required.** Validates the credential is live. Failure surfaces as a broken connection. |
| `afterConnect` | connect | After `test` | Fetch display data (user name, team, region) for `connectionLabel` variables. |
| `sign` | runtime | On every outbound request | Inject auth headers, sign the request, add query params. Receives the opaque credential; actions never see it. |
| `refresh` | runtime | When the credential expires or is rejected | Refresh OAuth token (or equivalent) and retry. Returns updated credential blob. |
| `revoke` | disconnect | When the user disconnects | Revoke the credential server-side, clean up any remote state. |

### Why hooks at every phase

Real-world auth rarely fits the textbook flow:

- **Before** — some APIs require fetching a request token, CSRF token, or tenant discovery URL before authorization.
- **During** — signing (HMAC, AWS SigV4, JWT assertion) happens per request, not once at connect time.
- **After** — a lot of providers need a "who am I?" call to derive the connection label or discover the account's region/tenant.

Hooks make these first-class instead of workarounds.

## Field reference

### Top-level

| Field | Type | Required | Description |
|---|---|---|---|
| `manifestVersion` | string | ✅ | Core spec version this file targets. |
| `type` | enum | ✅ | `"oauth2"` \| `"apiKey"` \| `"basic"` \| `"bearer"` \| `"custom"` \| `"tenantAuth"`. |
| `displayName` | string | ✅ | Human-facing name shown on the connect button. |
| `description` | string | ⬜ | Short explanation for the connect screen. |
| `connectionLabel` | string (template) | ⬜ | Template rendered with variables set by `afterConnect` to label saved connections. |
| `fields` | [Param](./param.md)[] | ⬜ | Inputs collected from the user at connect time. |
| `hooks` | object | ⬜ | Lifecycle hooks (see Lifecycle table). `test` is required within this block. |

### `oauth2`

| Field | Type | Required | Description |
|---|---|---|---|
| `authorizationUrl` | URL | ✅ | Authorization endpoint. |
| `tokenUrl` | URL | ✅ | Token exchange endpoint. |
| `refreshUrl` | URL | ⬜ | Refresh endpoint (defaults to `tokenUrl` if omitted). |
| `revokeUrl` | URL | ⬜ | Revocation endpoint used on disconnect. |
| `scopes` | string[] | ⬜ | Default scopes requested. |
| `scopeSeparator` | string | ⬜ | Separator used when joining scopes. Defaults to `" "`. |
| `pkce` | boolean | ⬜ | Enable PKCE. Defaults to `true`. |
| `extraAuthParams` | object | ⬜ | Extra query params appended to the authorization URL. |

### `apiKey`

| Field | Type | Required | Description |
|---|---|---|---|
| `in` | enum | ✅ | `"header"` \| `"query"` \| `"body"`. |
| `name` | string | ✅ | Header / param / body-key name. |
| `prefix` | string | ⬜ | Prefix prepended to the value (e.g., `"Bearer "`). |

## Hook runtime

All hooks named here — `preflight`, `exchange`, `test`, `afterConnect`, `sign`, `refresh`, `revoke` — execute under the [Hook Runtime RFC](./hook-runtime.md). Their input/output shapes, the ambient `HookContext`, the credential-isolation invariant that makes `sign` the only network-less hook with the credential, the error shape, the default 30 s timeout, and the sandbox posture are all defined there. The per-hook signatures appear in the [Hook registry](./hook-runtime.md#hook-registry).

## Resolved questions

| Question | Resolution |
|---|---|
| Hook runtime contract | Covered by the [Hook Runtime RFC](./hook-runtime.md). |
| `test` cadence | **Host's choice.** The spec defines `test`'s contract (input, output, semantics). When and how often it runs to validate stored Connections is a host policy — informed by `Connection.expiresAt` and observed failures, not prescribed by this RFC. |
