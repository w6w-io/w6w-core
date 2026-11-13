# RFC: Auth

**Status:** Final **Author:** Segev Shmueli **Date:** 2026-04-15 (revised 2026-06-01)

## Summary

An `Auth` manifest declares **how a user connects their account** to an App. It covers the common
types (OAuth 2.0, API key, Basic, Bearer) plus a `custom` escape hatch for exotic flows, and exposes
**lifecycle hooks** so a publisher can run code before, during, and after the connection is made —
including per-request signing.

Auth manifests are **separate files** referenced from the App manifest. An App may reference
multiple Auth files when it supports more than one connection method (e.g., OAuth 2.0 and API key).

## Motivation

Authentication is the single most divergent piece across integration platforms. Zapier, n8n, Make,
Shopify — each invents its own shape for what should be a small, well-understood problem. A unified
auth spec means:

- A publisher describes "how to log in to my service" once.
- Any compliant host can run the flow, store the resulting credential, and sign outgoing requests.
- Custom / bespoke auth doesn't require platform-specific escape hatches — it's the `custom` type
  with hooks.

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

> **Amended 2026-10-27:** credentials are still opaque to host and app code, but the compiled-in provider for a source's contract interprets it, so this line is refined, not dropped; see also [Credential](./credential.md) — see [§Amendment — 2026-10-27](#amendment--2026-10-27-serviceaccount-strict-auth-keys-and-refined-opacity).

## Concept

An `Auth` describes **one** authentication method. Each Auth manifest has:

1. A **`type` discriminant** (`oauth2` / `apiKey` / `basic` / `bearer` / `custom` / `tenantAuth` /
   `jit`).
2. A **type-specific configuration block** keyed by the type name.
3. A **`fields`** array of [Param](./param.md) entries — inputs collected from the user at connect
   time.
4. A **`hooks`** block — lifecycle callbacks (preflight, exchange, test, sign, refresh, revoke,
   afterConnect).

> **Amended 2026-10-27:** the type list now has eight members, adding `serviceAccount` — see [§Amendment — 2026-10-27](#amendment--2026-10-27-serviceaccount-strict-auth-keys-and-refined-opacity).

Only `hooks.test` is required. Everything else is optional and only declared when the auth type
needs it.

### Credentials are opaque

The publisher's hooks own the full credential lifecycle:

- **`exchange`** decides what gets stored (the credential blob).
- **`sign`** uses the stored credential to inject auth into every outbound request.
- **`handshake`** is the socket-backed generalization of `sign`, for protocols with no single
  signable request. Instead of augmenting one HTTP `Request`, it produces the protocol's auth
  frames **iteratively** — bytes to send, and a slot for the server's reply — round-trip by
  round-trip (Postgres SASL/SCRAM, MySQL native password, Redis `AUTH`/`HELLO`) until the
  handshake completes and the host hands the action a live `ctx.socket`.
- **`refresh`** updates the credential when it expires.

From the platform's view, the credential is an **opaque blob**. The spec does not declare its shape,
and actions never access credential fields directly. An action emits a request; the request passes
through `sign`; `sign` handles auth. This keeps tokens server-side and the action surface narrow.

> **Amended 2026-10-27:** opacity is refined (only the provider for the source's contract interprets it), and for a `serviceAccount` auth `sign` receives a derived token, never the stored source — see [§Amendment — 2026-10-27](#amendment--2026-10-27-serviceaccount-strict-auth-keys-and-refined-opacity).

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

`manifestVersion` declares which version of the Core spec this file targets — needed because Auth
manifests are standalone files. There is no `id`; the App references Auth files by path, and
`(app.id + filename)` is sufficient cross-reference.

> **Amended 2026-10-27:** an auth is referenced by its required, unique, immutable `key`, and an undeclared key fails `auth_not_found` — see [§Amendment — 2026-10-27](#amendment--2026-10-27-serviceaccount-strict-auth-keys-and-refined-opacity).

### OAuth 2.0

```json
{
  "manifestVersion": "1",
  "type": "oauth2",
  "displayName": "Sign in with Slack",
  "oauth2": {
    "authorizationUrl": "https://slack.com/oauth/v2/authorize",
    "tokenUrl": "https://slack.com/api/oauth.v2.access",
    "refreshUrl": "https://slack.com/api/oauth.v2.access",
    "revokeUrl": "https://slack.com/api/auth.revoke",
    "scopes": ["chat:write", "channels:read"],
    "scopeSeparator": " ",
    "pkce": true,
    "extraAuthParams": { "user_scope": "identity.basic" }
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
    "in": "header",
    "name": "Authorization",
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

> **Amended 2026-11-10:** a `bearer` auth like this one (one secret field), an `apiKey` auth with one secret field, and a `basic` auth whose two fields carry `credentialRole` accept a shared credential of a static contract; the host derives that as `accepts` — see [§Amendment — 2026-11-10](#amendment--2026-11-10-host-derived-accepts).

### Tenant Auth

```json
{
  "manifestVersion": "1",
  "type": "tenantAuth",
  "displayName": "Acme",
  "tenantAuth": { "link": "io.w6w.acme", "resourcePrefix": "urn:acme:" }
}
```

`tenantAuth` is defined by **provenance, not shape**: the credential is sourced from the **tenant**,
not entered by the user. There is no connect flow and no user-collected `fields`. The host mints a
live, per-subject credential from a per-tenant "app link" (keyed by the acting principal's subject)
and hands it to this method's `sign` hook exactly like a `bearer` credential.

This is a platform-agnostic primitive: any partner that embeds w6w as a tenant can expose its own
API to its users' workflows with **zero per-user setup**. The App only _declares_ it uses tenant
auth; the link config and secrets live host- side and never ship in the app package.
`tenantAuth.link` names the app link (defaults to the App id); `tenantAuth.resourcePrefix` is an
optional convention the App uses to recognize/round-trip the partner's resource identifiers.

### JIT (session token)

```json
{
  "manifestVersion": "1",
  "type": "jit",
  "displayName": "Session (JIT)",
  "jit": { "resourcePrefix": "urn:acme:" }
}
```

`jit` is the **zero-config sibling of `tenantAuth`**, also defined by provenance: no connect flow,
no user `fields`. The difference is _where the credential comes from_ — instead of the host minting
a token from a per-tenant app link, the credential **is the caller's own inbound token** (the JWT
the tenant minted to authenticate the request), forwarded to this method's `sign` hook exactly like
a `bearer` credential. A `jit` Connection stores only a `{ via: "jit" }` reference; the token is
supplied fresh per request and never persisted.

> **Amended 2026-10-27:** a `jit` Connection has no Credential record, and its token is never persisted — see [§Amendment — 2026-10-27](#amendment--2026-10-27-serviceaccount-strict-auth-keys-and-refined-opacity).

Use it when the App's API accepts the **same token the caller already presents** (the audiences
overlap) — no app link, no token endpoint, nothing per-tenant to configure. Because it forwards the
inbound request token, it is **unavailable to background/scheduled runs** (which carry none) and the
host fails the call closed. When the App's API needs a _different_ audience, use `tenantAuth` with a
token-exchange link (RFC 8693) instead. `jit.resourcePrefix` is the same editor-only convention as
`tenantAuth.resourcePrefix`.

### Custom

```json
{
  "manifestVersion": "1",
  "type": "custom",
  "displayName": "HMAC Authentication",
  "fields": [
    { "key": "accountId", "label": "Account ID", "type": "string", "required": true },
    { "key": "privateKey", "label": "Private Key", "type": "secret", "required": true },
    {
      "key": "region",
      "label": "Region",
      "type": "select",
      "options": { "source": "./hooks/regions.ts" }
    }
  ],
  "hooks": {
    "preflight": "./hooks/preflight.ts",
    "exchange": "./hooks/exchange.ts",
    "test": "./hooks/test.ts",
    "afterConnect": "./hooks/after-connect.ts",
    "sign": "./hooks/sign-request.ts",
    "handshake": "./hooks/handshake.ts",
    "refresh": "./hooks/refresh.ts",
    "revoke": "./hooks/revoke.ts"
  }
}
```

## Lifecycle

Every auth flow passes through the same phases. Each phase has an optional hook (except `test`,
which is required).

| Hook           | Phase              | Runs                                       | Purpose                                                                                                        |
| -------------- | ------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `preflight`    | connect            | Before the user is prompted                | Any setup needed before the flow starts (e.g. fetch a one-time request token).                                 |
| `exchange`     | connect            | After the user completes the flow          | Exchange an auth code or raw form input for a stored credential. Returns the opaque credential blob.           |
| `test`         | connect + periodic | After `exchange`, and on schedule          | **Required.** Validates the credential is live. Failure surfaces as a broken connection.                       |
| `afterConnect` | connect            | After `test`                               | Fetch display data (user name, team, region) for `connectionLabel` variables.                                  |
| `sign`         | runtime            | On every outbound request                  | Inject auth headers, sign the request, add query params. Receives the opaque credential; actions never see it. |
| `handshake`    | runtime            | Once per action `execute`, before `ctx.socket` is handed to it | The socket analogue of `sign`: produce the protocol's auth frames iteratively, round-trip by round-trip, until the connection is authenticated. Receives the opaque credential and the read-only connect target; the host drives the byte exchange over the real socket. |
| `refresh`      | runtime            | When the credential expires or is due for keep-alive | Refresh OAuth token (or equivalent). Returns updated credential blob. For `oauth2`, overrides the built-in refresh. |
| `revoke`       | disconnect         | When the user disconnects                  | Revoke the credential server-side, clean up any remote state.                                                  |

> **Amended 2026-10-27:** the opaque blob is the legacy-path shape; for `serviceAccount`, `exchange` never runs and `sign` receives a `DerivedToken` — see [§Amendment — 2026-10-27](#amendment--2026-10-27-serviceaccount-strict-auth-keys-and-refined-opacity).

> **Amended 2026-11-13:** the `refresh` row read "when the credential expires or is rejected … and retry". The host runs it on expiry and on a background keep-alive schedule, an `oauth2` auth without the hook gets a built-in refresh, and nothing here re-runs a rejected call — see [§Amendment — 2026-11-13](#amendment--2026-11-13-refresh-lifecycle).

### Why hooks at every phase

Real-world auth rarely fits the textbook flow:

- **Before** — some APIs require fetching a request token, CSRF token, or tenant discovery URL
  before authorization.
- **During** — signing (HMAC, AWS SigV4, JWT assertion) happens per request, not once at connect
  time.
- **After** — a lot of providers need a "who am I?" call to derive the connection label or discover
  the account's region/tenant.

Hooks make these first-class instead of workarounds.

## Field reference

### Top-level

| Field             | Type                  | Required | Description                                                                                     |
| ----------------- | --------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `manifestVersion` | string                | ✅       | Core spec version this file targets.                                                            |
| `type`            | enum                  | ✅       | `"oauth2"` \| `"apiKey"` \| `"basic"` \| `"bearer"` \| `"custom"` \| `"tenantAuth"` \| `"jit"`. |
| `displayName`     | string                | ✅       | Human-facing name shown on the connect button.                                                  |
| `description`     | string                | ⬜       | Short explanation for the connect screen.                                                       |
| `connectionLabel` | string (template)     | ⬜       | Template rendered with variables set by `afterConnect` to label saved connections.              |
| `fields`          | [Param](./param.md)[] | ⬜       | Inputs collected from the user at connect time.                                                 |
| `setup`           | object[]              | ⬜       | Where to get what `fields` ask for: ordered `{ text, url? }` steps, `url` https only. Display-only. |
| `hooks`           | object                | ⬜       | Lifecycle hooks (see Lifecycle table). `test` is required within this block.                    |

> **Amended 2026-10-27:** the `type` enum has eight members, adding `serviceAccount`, and the `serviceAccount` block is defined in the amendment — see [§Amendment — 2026-10-27](#amendment--2026-10-27-serviceaccount-strict-auth-keys-and-refined-opacity).

### `oauth2`

| Field              | Type     | Required | Description                                            |
| ------------------ | -------- | -------- | ------------------------------------------------------ |
| `authorizationUrl` | URL      | ✅       | Authorization endpoint.                                |
| `tokenUrl`         | URL      | ✅       | Token exchange endpoint.                               |
| `tokenAuthMethod`  | string   | ⬜       | `client_secret_post` (default) or `client_secret_basic` for host token exchange. |
| `tokenBodyFormat`  | string   | ⬜       | `form` (default) or `json` for the token request body. |
| `refreshUrl`       | URL      | ⬜       | Refresh endpoint (defaults to `tokenUrl` if omitted).  |
| `refreshTokenTtlSeconds` | integer | ⬜ | Lifetime of the vendor's refresh token, in seconds, when it expires (sliding or absolute). Drives keep-alive cadence. Omit when refresh tokens do not expire. |
| `accessTokenTtlSeconds` | integer | ⬜ | Access-token lifetime to assume when a token response has no `expires_in`. Without it such a token is never treated as expiring. |
| `builtinRefresh` | boolean | ⬜ | `false` disables the built-in refresh for a vendor with no refresh grant. Defaults to `true`. A `refresh` hook always wins. |
| `revokeUrl`        | URL      | ⬜       | Revocation endpoint used on disconnect.                |
| `scopes`           | string[] | ⬜       | Default scopes requested.                              |
| `scopeSeparator`   | string   | ⬜       | Separator used when joining scopes. Defaults to `" "`. |
| `pkce`             | boolean  | ⬜       | Enable PKCE. Defaults to `true`.                       |
| `extraAuthParams`  | object   | ⬜       | Extra query params appended to the authorization URL.  |
| `setup`            | object   | ⬜       | Display-only client-registration guidance; see [`oauth2.setup`](#oauth2setup). |

> **Amended 2026-11-13:** `refreshTokenTtlSeconds`, `accessTokenTtlSeconds` and `builtinRefresh` are new; `refreshUrl` is where the built-in refresh posts — see [§Amendment — 2026-11-13](#amendment--2026-11-13-refresh-lifecycle).

#### `oauth2.setup`

An optional block of guidance for registering an OAuth client with the vendor. It is **display-only**: no flow, hook or runtime path reads it, and it plays no part in the `preflight` lifecycle phase (that is a hook that runs at connect time; `setup` here is only text a host may show). Hosts treat every field as **untrusted** and fall back per field when one is missing or unusable. A validator still rejects a malformed block. Every field is optional.

| Field              | Type   | Description                                                                   |
| ------------------ | ------ | ----------------------------------------------------------------------------- |
| `consoleUrl`       | URL    | Vendor developer console. Must be an absolute `https:` URL.                   |
| `instructions`     | string | Plain-text steps for creating the client.                                     |
| `clientIdHint`     | string | Plain-text hint for the client id.                                            |
| `clientSecretHint` | string | Plain-text hint for the client secret.                                        |
| `redirectUriHint`  | string | Plain-text hint for the redirect URI the vendor asks for.                     |
| `extraHint`        | string | Plain-text hint for anything else the vendor asks for.                        |
| `extraTemplate`    | object | Suggested `extra` object for a tenant OAuth app (a plain object, not an array). |

### `apiKey`

| Field    | Type   | Required | Description                                        |
| -------- | ------ | -------- | -------------------------------------------------- |
| `in`     | enum   | ✅       | `"header"` \| `"query"` \| `"body"`.               |
| `name`   | string | ✅       | Header / param / body-key name.                    |
| `prefix` | string | ⬜       | Prefix prepended to the value (e.g., `"Bearer "`). |

## Hook runtime

All hooks named here — `preflight`, `exchange`, `test`, `afterConnect`, `sign`, `handshake`,
`refresh`, `revoke` — execute under the [Hook Runtime RFC](./hook-runtime.md). Their input/output shapes, the ambient
`HookContext`, the credential-isolation invariant that makes `sign` the only network-less hook with
the credential, the error shape, the default 30 s timeout, and the sandbox posture are all defined
there. The per-hook signatures appear in the [Hook registry](./hook-runtime.md#hook-registry).

> **Amended 2026-10-27:** the per-hook credential access is tabulated for legacy and provider-derived auths, replacing the "only `sign`" shorthand — see [§Amendment — 2026-10-27](#amendment--2026-10-27-serviceaccount-strict-auth-keys-and-refined-opacity).

## Resolved questions

| Question              | Resolution                                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hook runtime contract | Covered by the [Hook Runtime RFC](./hook-runtime.md).                                                                                                                                                                                                |
| `test` and Health Checks | `test` keeps this contract unchanged. [`healthcheck.md`](./healthcheck.md) *derives* a `kind: "credential"` health check from it (`auth:<key>`) so credential liveness, vendor status and quota surface uniformly — no change is required of an existing Auth method. |
| `test` cadence        | **Host's choice.** The spec defines `test`'s contract (input, output, semantics). When and how often it runs to validate stored Connections is a host policy — informed by `Connection.expiresAt` and observed failures, not prescribed by this RFC. |

## Amendment — 2026-10-27: `serviceAccount`, strict auth keys and refined opacity

> **Additive, with refinements.** This section adds the `serviceAccount` auth type and introduces the
> [Credential RFC](./credential.md). It refines or supersedes exactly these passages, each of which
> carries a pointer to this section: the Non-Goals line "Declaring credential shape"; Concept's type
> list (item 1); the `sign` bullet and the opaque-blob paragraph under "Credentials are opaque"; the
> `(app.id + filename)` cross-reference sentence under Shared top-level fields; the `jit` paragraph's
> "stores only a `{ via: "jit" }` reference"; the Lifecycle table's `exchange`, `sign` and `handshake`
> rows; the Field reference's top-level `type` enum; and the Hook runtime paragraph's "the only
> network-less hook with the credential". Everything else in this RFC stands.

### Opacity is refined, not dropped

The Concept's rule that the credential is opaque remains true for host code and for app code: both
store, move, redact and **never interpret** a source. What changes is who _can_: the **only** code that
interprets a stored source is the compiled-in credential provider for that source's contract
(`@w6w/credential-providers`), in the host's own realm and never in a sandbox. The "Declaring
credential shape" non-goal stands for publisher manifests: an app still declares no shape for a
stored credential; it names the contracts it accepts (`serviceAccount.accepts`) and the provider owns
the shape. See [Credential RFC §Opacity, refined](./credential.md#opacity-refined).

> **Amended 2026-11-10:** for static contracts the host also reads the source, only via the pure `@w6w/types` helper `mapGenericSource`, in the host realm and never in a sandbox or publisher code — see [Credential RFC §Amendment](./credential.md#amendment--2026-11-10-static-credential-contracts-and-derived-compatibility).

### Auth keys and how a Connection names its auth

- An auth's **`key`** is **required**, **unique within the App** and **immutable across versions**
  (`auth.schema.json` constrains it to `^[A-Za-z0-9_-]+$`). Renaming a key is removing an auth: a
  Connection that still names the old key fails as below.
- **`Connection.auth` stores the key.** The cross-reference is `(app.id, key)`, not
  `(app.id + filename)`; that sentence under Shared top-level fields is superseded.
- **An undeclared key fails `auth_not_found`**, in phase `auth`. `authFor` never falls back to the
  first declared auth, because signing a Connection with a different method's hooks is a
  credential-confusion defect (D-5).
- The per-type JSON examples in this RFC use the legacy **path-reference** form (Hook Runtime RFC
  [§Module format, A](./hook-runtime.md#a-path-reference-declarative-manifests)): they carry
  `manifestVersion` and a `hooks` block. The **code-first** declaration is what
  [`auth.schema.json`](../packages/schema/schemas/auth.schema.json) validates: `key`, `type` and
  `displayName` are required, there is **no** `hooks` member and **no** `manifestVersion`, and unknown
  members are rejected.

### The stored source is not the input credential

The Lifecycle table's "opaque credential" describes the **legacy** path. For a `serviceAccount` auth:

- The stored **source** is the user's `serviceAccountKey` field value (see below). `exchange` **never
  runs** for it: there is nothing to exchange, and the provider validates the source instead.
- `sign` receives a **`DerivedToken`** (`{ accessToken, tokenType: "Bearer", expiresAt }`), not the
  stored source, and stamps `Bearer ${accessToken}`. `handshake` likewise receives the `DerivedToken`.
- `test` and `afterConnect` receive `credential: null` and a **signed** `ctx.fetch`; they also receive
  the non-secret `binding` and `credentialDisplay`. Per-hook detail:
  [Hook Runtime RFC §Per-hook secret access and network posture](./hook-runtime.md#per-hook-secret-access-and-network-posture).

### `serviceAccount`

An auth of this type (configured by `ServiceAccountConfig`, `@w6w/types`) has a stored service-account source as its credential, and the host **derives**
short-lived tokens through a compiled-in provider. The App declares only which credential contracts
it accepts; it can never declare a token destination.

```ts
const serviceAccount: AuthDefinition = {
  key: "service-account",
  type: "serviceAccount",
  displayName: "Service account",
  fields: [
    { key: "serviceAccountKey", label: "Service account key", type: "json", secret: true,
      required: true, ui: "textarea" },
  ],
  serviceAccount: {
    accepts: ["google-service-account.v1"],
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    impersonation: "none",
  },
  sign({ request, credential }) {
    const { accessToken } = credential as { accessToken: string }; // a DerivedToken
    request.headers["authorization"] = `Bearer ${accessToken}`;
    return request;
  },
  test: async (_input, ctx) => ({ ok: (await ctx.fetch("https://api.example.com/whoami")).ok }),
};
```

| Field | Type | Required | Description |
|---|---|---|---|
| `accepts` | string[] | ✅ | Credential contract ids this auth takes (`name.vN`), at least one. A credential with any other contract does not fit. |
| `scopes` | string[] | ✅ | Scopes the auth requests by default, at least one. The ceiling for approval: an approved binding is a subset of these. |
| `impersonation` | enum | ✅ | `"none"`, `"optional"` or `"required"` — whether a Connection may or must name a `delegatedUser`. |
| `bindingFields` | [Param](./param.md)[] | ⬜ | Non-secret, per-Connection binding inputs (for example `projectId`). Never `secret`. |

There is **no URL or endpoint field** (D-7): the destination of a token exchange belongs to the
provider's contract, never to the app. `Auth.fields` remain the **credential-source input**: a
`serviceAccount` auth declares, by convention, exactly one, `serviceAccountKey` (`type: "json"`, `secret: true`,
`required: true`, `ui: "textarea"`). `bindingFields` are collected per Connection and stored on the
binding, never with the source.

> **Amended 2026-11-10:** only `serviceAccount` auths *declare* `accepts`. A `bearer`, `apiKey` or `basic` auth also takes a managed credential, with `accepts` derived by the host — see [§Amendment — 2026-11-10](#amendment--2026-11-10-host-derived-accepts).

**The type list.** `Auth.type` is one of the eight members of `AUTH_TYPES` (`@w6w/types`), in
canonical order: `oauth2`, `apiKey`, `basic`, `bearer`, `custom`, `tenantAuth`, `jit`,
`serviceAccount`. The Concept's list of seven and the Field reference `type` enum are read as these
eight. `tenantAuth` and `jit` are unchanged; for **`jit`** there is **no Credential record** (a `jit`
Connection holds no `credentialId`), and the token is supplied fresh per request and **never
persisted**.

### Which hooks receive the credential

The shorthand that `sign` is "the only network-less hook with the credential" is retired. Several
auth hooks receive the credential on the legacy path, and for a provider-derived auth the stored
source reaches **no** hook. The Hook Runtime RFC's per-hook table is the single statement of this.

A runtime that is given **no credential resolver** MUST fail a `serviceAccount` auth closed with
`provider_unsupported`, for preparation, for every auth hook it would run, and for health: the
stored source must never reach `sign`. That is why the in-core refresh path never serves a
`serviceAccount` auth (see [Credential RFC §Resolution](./credential.md#resolution)).

## Amendment — 2026-11-10: host-derived `accepts`

> **Additive.** It qualifies the Amendment 2026-10-27 statements that a credential is managed only for
> a `serviceAccount` auth and that an auth names its contracts in `serviceAccount.accepts`. Neither
> is edited: a `serviceAccount` auth still declares `accepts`, and the other types still use the
> legacy hook path unless a shared credential is attached.

A `bearer`, `apiKey` or `basic` auth takes a shared credential of a static contract
([Credential RFC](./credential.md#amendment--2026-11-10-static-credential-contracts-and-derived-compatibility))
when its shape fits:

- `bearer` or `apiKey`: exactly one field and it is secret (`type: "secret"` or `secret: true`) —
  accepts `bearer.v1` / `api-key.v1`;
- `basic`: exactly two fields, one with `credentialRole: "username"` and one with `"password"`
  ([Param RFC](./param.md#amendment--2026-11-10-credentialrole)) — accepts `basic.v1`. Names are never
  consulted.

Any other shape (extra fields, `oauth2`, `custom`, `tenantAuth`, `jit`) accepts nothing and keeps the
legacy path.

**`accepts` is host-derived.** A host emits `accepts` (an array of contract ids; empty or omitted when
none) on each auth in its auth listing, computed from the auth type and fields. It is not authored: a
manifest cannot declare a top-level `accepts` on an auth, and a host strips one when it appears in
inbound data, so a manifest cannot widen what a credential may be attached to. The `serviceAccount`
block's own `serviceAccount.accepts` is unchanged and is the only authored list.

## Amendment — 2026-11-13: Refresh lifecycle

> **Additive, with one refinement.** This section specifies when and how a host refreshes an `oauth2`
> credential, including a built-in refresh that needs no hook and a background keep-alive. It
> refines exactly the Lifecycle table's `refresh` row (pointer below the table) and adds three
> optional `oauth2` fields (pointer below the field table). Everything else in this RFC stands. The
> pure policy lives in `@w6w/runtime` (`packages/runtime/src/refresh-policy.ts`); the Connection
> fields it reads are in [Connection RFC §Amendment — 2026-11-13](./connection.md#amendment--2026-11-13-auto-refresh).

### Why

An OAuth2 refresh token often expires too, either a fixed time after consent (absolute) or a fixed
time after its last use (sliding). A host that refreshes only when a call needs a token loses every
sliding refresh token whose Connection sits idle longer than that lifetime, and the user has to
reconnect. A vendor with 7-day access tokens and 30-day refresh tokens disconnects an account
that sees no activity for a month. Refreshing on a schedule keeps it alive.

### Who refreshes

Exactly one refresher: the host's credential resolver
([Credential RFC §Resolution](./credential.md#resolution), D-C2). It refreshes in two situations,
and both use the same code path:

1. **On use**, when the stored access token expires within `TOKEN_SKEW_MS` (60 s) or the Connection
   is `needs_refresh`.
2. **Keep-alive**, a background sweep that refreshes a Connection when the policy below says it is due,
   even if nothing has used it. The sweep asks the resolver to refresh and never refreshes by itself.

A rejected call (for example a vendor `401`) does not cause a refresh and a re-run. Re-running a
non-idempotent action is unsafe, and this amendment does not add it.

### Which refresh runs

For an `oauth2` auth, in order:

1. If the auth defines a **`refresh` hook**, the hook runs and the built-in refresh never does, even
   with `builtinRefresh: true`. Input: `{ credential }`, the stored credential. Output: the complete
   new credential, as a non-empty plain object. The host writes it back in place of the old one. A
   throw, or a non-object or empty result, fails the refresh and leaves the stored credential as it
   was.
2. Otherwise, if `oauth2.builtinRefresh` is not `false` **and** the stored credential has a
   `refreshToken`, the host runs the **built-in refresh** below.
3. Otherwise the credential is not refreshable. It is used as stored until it expires.

`isRefreshable(auth, hasRefreshHook)` from `@w6w/runtime` answers steps 1 and 2 without looking at the
credential. A host shows the result as `refreshable` on the auth listings its connect UI reads.

The built-in refresh needs the host's OAuth client, so it runs only where a resolver runs. An
embedder that uses the in-core path (no resolver) has only the hook.

### The built-in refresh

The grant follows RFC 6749 §6. `oauth2RefreshRequest` from `@w6w/runtime` builds it:

- `POST` to `refreshUrl`, or to `tokenUrl` when `refreshUrl` is not set.
- The body has `grant_type=refresh_token` and `refresh_token=<stored refreshToken>`, plus `scope`
  only when the host sends one. Without `scope`, the vendor re-issues the scopes it granted
  originally. The body is form-encoded by default. With `tokenBodyFormat: "json"` the host sends the
  same parameters as a JSON object.
- Client authentication uses the **same OAuth client and the same method as the code exchange**
  that created the Connection. The client is the app's, or the tenant's where the host lets a tenant
  register its own. With `tokenAuthMethod: "client_secret_basic"` the client id and secret go in an
  `Authorization: Basic` header. Otherwise they go in the body as `client_id` and `client_secret`. A
  public client with no secret sends `client_id` in the body only.
- The request goes through the host's guarded egress, like the code exchange.

`mergeRefreshedCredential` merges the response into the stored credential:

| Stored member | After a successful refresh |
|---|---|
| `accessToken` | The response's `access_token`. A response without one fails the refresh. |
| `refreshToken` | **Rotation:** the response's `refresh_token` when it has a non-empty one. Otherwise the old value is kept, because a vendor that does not rotate leaves the old token valid. |
| `expiresAt` (epoch ms) | `now + expires_in` (a number or numeric string, seconds). Without `expires_in`, `now + accessTokenTtlSeconds`. Without either, unset, because the old instant belonged to the old token. |
| `scope`, `tokenType` | Replaced when the response carries `scope` / `token_type`, kept otherwise. |
| anything else | Kept unchanged (for example vendor extras that an `exchange` hook stored). |

`accessTokenTtlSeconds` applies the same way at connect time, when the code exchange's response has
no `expires_in`.

Rotation must not lose a token. Once a vendor issues a rotated refresh token, the old one may already
be spent. The host writes the merged credential back with a compare-and-set on `refreshSeq`
([Credential RFC §`revision` and `refreshSeq`](./credential.md#revision-and-refreshseq)). A refresher
that loses that race uses the winner's stored credential and does not send the grant again.

A failed refresh never copies vendor text into a stored or surfaced message. It may name the OAuth
error **code** (`invalid_grant`, …) when that code is well-formed (`OAuthRefreshError.code`).

### Keep-alive policy

`keepAliveDecision(input)` from `@w6w/runtime` is the whole policy. All times are epoch ms.

| Constant | Value | Meaning |
|---|---|---|
| `KEEPALIVE_LEAD_MS` | 1 h | Refresh when the access token expires within this. |
| `KEEPALIVE_DEFAULT_MAX_IDLE_MS` | 7 d | Refresh at least this often. |
| `KEEPALIVE_FAILURE_RETRY_MS` | 1 h | A failing Connection is retried at most this often. |
| `KEEPALIVE_GIVE_UP_MS` | 72 h | Failing this long means the Connection is broken. |

The maximum idle time is `keepAliveMaxIdleMs(refreshTokenTtlSeconds)`, which is
`min(refreshTokenTtlSeconds × 1000 / 3, 7 d)`. A third of the lifetime leaves room for failed
attempts before a sliding refresh token lapses.

The rules are checked in order, and the first match decides:

1. Refresh failing since `refreshFailingSince`, and `now − refreshFailingSince ≥ 72 h`: **give up**.
2. Still failing: **due (`retry`)** once 1 h has passed since the last attempt (or since
   `refreshFailingSince` when no attempt time is recorded). Before that, not due, even if the token
   is expiring.
3. `expiresAt − 1 h ≤ now`: **due (`expiring`)**.
4. `lastRefreshedAt + maxIdle ≤ now`, or no `lastRefreshedAt` is known: **due (`max_idle`)**.
   `lastRefreshedAt` is the last successful refresh, or the original grant.
5. Otherwise **not due**.

The sweep considers a Connection only when all of these hold:

- `autoRefresh` is not `false`;
- its state is `connected` or `needs_refresh`;
- its auth is `oauth2` and refreshable;
- its stored credential has a `refreshToken`;
- it is not `jit` (a `jit` token is never persisted).

How often the sweep runs is up to the host. It has to run much more often than `KEEPALIVE_LEAD_MS`;
the reference host runs it every 15 minutes. Keep-alive is maintenance, not a use of the Connection:
no Action runs and nothing is signed. A user-owned Connection is therefore kept alive like an account
one, without making it usable by anyone else.

**Sliding vs absolute.** Keep-alive extends a **sliding** refresh token, because each refresh issues
a new one or restarts its clock. An **absolute** lifetime counts from consent, and no refresh can
extend it. When that lifetime ends the user must reconnect. `refreshTokenTtlSeconds` sets the cadence
in both cases. Only the vendor's documentation says which kind it is.

Worked example (`accessTokenTtlSeconds: 604800`, `refreshTokenTtlSeconds: 2592000`). Max idle
is `min(10 d, 7 d) = 7 d`, so the `expiring` rule fires first, about an hour before day 7. Each
refresh issues a fresh 30-day refresh token, so a Connection that nothing uses stays connected
indefinitely.

### Failure policy

- **On use.** A failed refresh fails that call with `credential_invalid` and leaves the stored
  credential unchanged. It does not mark the Connection `broken`.
- **Keep-alive.** A failed refresh records, on the Connection, `refreshFailingSince` (set only if
  empty), the attempt time, and a service-authored error code (never vendor text). The policy then
  retries hourly. Any successful refresh, on use or in the background, clears the failure and sets
  `lastRefreshedAt`.
- **Give up.** After 72 h of failures the host moves the Connection to `broken`, the existing
  "`refresh` failed" transition in the
  [Connection lifecycle](./connection.md#lifecycle), and emits its usual connection-health event. A
  single failure never breaks a Connection, because a vendor outage of a few hours must not
  disconnect every user.
