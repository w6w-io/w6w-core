# RFC: Credential

**Status:** Review
**Author:** Segev Shmueli
**Date:** 2026-10-27

## Summary

A `Credential` is a **stored, tenant-owned secret source** that one or more [Connections](./connection.md)
bind to. The platform stores it and never shows it. For a provider-derived auth (`serviceAccount`) it
never hands the source to publisher code; the other auth types keep the behaviour the hook-runtime
table describes. For an auth
of type `serviceAccount` the host uses a **compiled-in credential provider** to _derive_ a
short-lived authorization (a `DerivedToken`) from the source; only that token ever reaches the
Auth `sign` hook. For every other auth type the source is the opaque blob the [Auth RFC](./auth.md)
has always described, and the behaviour is unchanged.

> **Amended 2026-11-10:** a credential is no longer tied to `serviceAccount` auths: three static contracts (`bearer.v1`, `api-key.v1`, `basic.v1`) let a shared credential fit a `bearer`, `apiKey` or `basic` auth with no derivation step — see [§Amendment — 2026-11-10](#amendment--2026-11-10-static-credential-contracts-and-derived-compatibility).

This RFC defines the logical model (the credential record, the per-Connection binding, the three
shapes of a resolved authorization), the provider contract, the compatibility rules between
credentials and apps, the lifecycle policy, the authorization cache key, the resolution seam between
host and runtime, and the resolution-time error codes. It is host-agnostic: it names the
`@w6w/types`, `@w6w/runtime` and `@w6w/credential-providers` symbols a host builds on, and nothing
about how a particular host stores or routes them.

## Motivation

Before this RFC a credential existed only as the `credential` member of one Connection. That has
four consequences a host and an app author both hit:

- **One secret, many copies.** A Google service-account key used by six apps was pasted into six
  Connections. Rotating it meant six edits, and nothing recorded that they were the same key.
- **The source reached `sign`.** For a service account, the long-lived private key was handed to a
  hook that signs a JWT on every request — the exact opposite of what credential isolation wants.
- **Authority travelled with the secret.** Scopes and the impersonated user lived inside the stored
  payload, so sharing a key also shared its authority, and nothing compared what an app asked for
  with what the owner approved.
- **Two refreshers.** Each host path (invoke, hub egress, tenant minting) refreshed on its own,
  so two requests could race over one rotating grant.

Credential, binding and derived authorization are separated so that a secret is stored once,
authority is approved per Connection, and exactly one party derives or refreshes a token.

## Goals

- Define the **Credential record**: ownership, contract id, status, two change counters, display
  metadata — and **never a payload**.
- Define the **binding** (what a Connection asks for) and the **approved binding** (what the host
  allows), so authority never rides on the secret.
- Define the **provider contract**: how a host turns a stored source into a short-lived token
  without the source ever entering a sandbox.
- Define **compatibility** between a credential's contract and an auth's `accepts`, and state why
  that is not authorization.
- Define the **lifecycle policy**: private vs shared credentials, disconnect, delete, disable,
  revoke, rotation — and what none of them can undo.
- Define the **authorization cache key** and the **resolution seam** (`CredentialResolver.prepare`).
- Close the resolution-time **error codes**.

## Non-Goals

- Storage mechanics, encryption at rest, key management, audit — host concerns (see
  [Auth RFC](./auth.md) Non-Goals).
- Management routes, HTTP shapes and their error codes. Those are **host-local**; this RFC lists only
  the codes a runtime or a resolution step raises.
- Cross-account and multi-owner sharing, providers that may leave the host, additional providers,
  provider-side revocation — deferred (see [Open questions](#open-questions)).
- Changing what `oauth2`, `apiKey`, `basic`, `bearer`, `custom`, `tenantAuth` and `jit` store or
  how their hooks behave.

> **Amended 2026-11-10:** three static providers (`bearer.v1`, `api-key.v1`, `basic.v1`) now ship, so "additional providers" is partly done and static auths gain a credential path — see [§Amendment — 2026-11-10](#amendment--2026-11-10-static-credential-contracts-and-derived-compatibility).

## Concept

### Source, record, binding, authorization

- **Source.** The secret material a credential holds (for `google-service-account.v1`, a Google
  service-account key). The source is what the user typed or pasted; it is encrypted at rest by the
  host and **never appears in any API surface, record, log, trace or error**.
- **`CredentialRecord`.** What callers see: `id`, `tenant`, `account`, `createdBy`, `name`,
  `contract`, `revision`, `refreshSeq`, `status`, `display` (non-secret, provider-chosen metadata
  such as a service-account email) and `ownerConnectionId` (see [Lifecycle](#lifecycle-policy)).
  There is **no payload or ciphertext member**, by design: a record is always safe to return.
- **`ConnectionBinding`.** Non-secret, per-Connection inputs: optional `scopes`, optional
  `delegatedUser` (the user a service account impersonates; this is **not** the Connection's `owner`
  and **not** the acting principal's subject), and non-secret `settings`.
- **`ApprovedBinding`.** `{ scopes, delegatedUser }` — what the host approved the binding to carry.
  A derived token may carry only the approved binding, never the raw binding.
- **`ResolvedAuthorization`.** What the host hands the runtime for one use, one of three arms:
  - `{ kind: "none" }` — no credential applies.
  - `{ kind: "legacyOpaque", source, credential, sourceRevision }` — an opaque credential for the
    auth's own hooks. `source` is `"stored"`, `"tenantAuth"` or `"jit"`.
  - `{ kind: "derived", token, expiresAt, sourceRevision }` — a `DerivedToken`
    (`{ accessToken, tokenType: "Bearer", expiresAt }`, `expiresAt` in **epoch milliseconds**).

A Connection names its credential by `credentialId` and carries `binding`, `approved` and a
`bindingRevision` that is bumped whenever scopes or the delegated user change (see
[Connection RFC §Amendment](./connection.md#amendment--2026-10-27-credential-reference-binding-and-lifecycle)).

### Opacity, refined

The Auth RFC's rule that credentials are opaque **stands, refined**: host code and app code treat a
source as opaque — they store it, move it, redact it and never parse it. The **only** code that
interprets a source is the compiled-in provider for that source's contract, and it does so inside
the host's own realm, never in a sandbox, never in publisher code (intake D-4, D-A1). "Opaque to the
platform" now means "opaque to everything except the one provider that owns the contract".

> **Amended 2026-11-10:** for the three static contracts the host also maps the source with `mapGenericSource` (reads `token`/`key`/`username`/`password`), a pure `@w6w/types` helper run in the host realm, never in a sandbox or publisher code — see [§Amendment — 2026-11-10](#amendment--2026-11-10-static-credential-contracts-and-derived-compatibility).

### Compatibility ids

A credential has a **contract id**. A provider-backed contract id is `<name>.v<N>` and matches
`CREDENTIAL_CONTRACT_ID_RE` (`/^[a-z0-9-]+\.v[0-9]+$/`), for example `google-service-account.v1`.

- A **major** (`vN`) is a compatibility boundary. `v1` and `v2` are **incompatible**; there is no
  implicit upgrade, coercion or fallback between them.
- A credential normalised from a pre-credential Connection carries `legacy:<appId>#<authKey>`,
  built by `legacyContractId(appId, authKey)`. It never matches `CREDENTIAL_CONTRACT_ID_RE`
  and is bound to **one app and one auth key** — a legacy credential is never shared across apps.
- An auth declares which contracts it takes in `serviceAccount.accepts`. A credential is compatible
  with an auth exactly when its contract equals one of the `accepts` entries (exact match).
- **Compatibility is not authorization.** That a credential fits an auth says nothing about scopes
  or delegation: those are approved per Connection (see [Scopes and delegation](#scopes-and-delegation)).

> **Amended 2026-11-10:** an auth does not have to declare `accepts`. For `bearer`, `apiKey` and `basic` auths the host derives the accepted contract from the auth type and fields, and `legacy:` ids stay never-shared — see [§Amendment — 2026-11-10](#amendment--2026-11-10-static-credential-contracts-and-derived-compatibility).

#### Manifest and provider versions

- `manifestVersion` **stays `"1"`.** The `serviceAccount` auth type, `Connection.credentialId` and
  the binding members are **additive**; no existing manifest changes meaning. A host that predates
  this RFC does not know the `serviceAccount` type and rejects such an app at load, which is the
  correct failure.
- A provider's `version` (semver of the implementation) is distinct from its contract **major**. A
  new provider `version` within one major is compatible with existing credentials and changes the
  [cache key](#authorization-cache-key), so tokens derived by the old implementation are not reused.
  A new contract major is a new contract id.

## Shape

### A credential record

```json
{
  "id": "cred_01HZ...",
  "tenant": "tn_acme",
  "account": "acct_acme",
  "createdBy": "user_8x7H...",
  "name": "Workspace automation",
  "contract": "google-service-account.v1",
  "revision": 3,
  "refreshSeq": 0,
  "status": "active",
  "display": { "client_email": "svc@acme.iam.gserviceaccount.com", "project_id": "acme-prod" },
  "ownerConnectionId": null,
  "createdAt": "2026-10-27T09:00:00Z",
  "updatedAt": "2026-10-27T09:00:00Z"
}
```

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✅ | Stable, host-issued identifier. |
| `tenant` | string | ✅ | Owning tenant. Ownership is the credential's **own**; it is not inherited from a Connection. |
| `account` | string | ✅ | Owning account within the tenant. |
| `createdBy` | string | ✅ | Host-issued identifier of the principal that created it (attribution, not authority). |
| `name` | string | ✅ | Human-facing label. |
| `contract` | string | ✅ | Contract id (see [Compatibility ids](#compatibility-ids)). |
| `revision` | integer | ✅ | Bumped on **source rotation**. See [`revision` and `refreshSeq`](#revision-and-refreshseq). |
| `refreshSeq` | integer | ✅ | Bumped when the host writes back a refreshed grant. Does not invalidate derived tokens. |
| `status` | `CredentialStatus` | ✅ | `"active"`, `"disabled"` or `"revoked"`. |
| `display` | object of strings | ✅ | Non-secret metadata chosen by the provider (`displayOf`). Never key material. |
| `ownerConnectionId` | string or null | ✅ | Set: a **private** credential owned by that one Connection. Null: **shared**. |
| `createdAt`, `updatedAt` | timestamp | ✅ | ISO 8601. |

### A `serviceAccount` auth (code-first)

The shape below is the code-first declaration; [`auth.schema.json`](../packages/schema) validates the
declaration, which has no `hooks` and no `manifestVersion` member. It is adapted from the
[`service-account` fixture](../fixtures/apps/service-account/auth/service-account.ts), which
declares no `fields` block and has a different `test` and an `afterConnect`; the `fields` entry
below is the provider input contract added here.

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
    // `credential` is the DerivedToken, never the stored key.
    const { accessToken } = credential as { accessToken: string };
    request.headers["authorization"] = `Bearer ${accessToken}`;
    return request;
  },
  async test(_input, ctx) {
    // `credential` is null here; ctx.fetch is signed by the host.
    const res = await ctx.fetch("https://api.example.com/whoami");
    return { ok: res.ok };
  },
};
```

By convention (neither the validator nor the schema enforces the count; the provider's `validateSource` validates the
stored payload's shape), a `serviceAccount` auth declares exactly **one** source field, `serviceAccountKey` (`type: "json"`,
`secret: true`, `required: true`, `ui: "textarea"`). It never declares a token URL or any endpoint:
the destination of a token exchange belongs to the provider, never to the app.

The validator requires a `sign` hook for a `serviceAccount` auth (alongside the generic rule that
only `hooks.test` is required elsewhere).

## Provider contract

A `CredentialProvider` (`@w6w/types`) is the host-side code that owns one contract id:

```ts
interface CredentialProvider {
  contract: string;   // e.g. "google-service-account.v1"
  version: string;    // implementation semver
  capabilities: { handoffable: boolean; crossConnectionTokenReuse: boolean; delegation: boolean };
  validateSource(payload: unknown): unknown;              // throws credential_invalid
  displayOf(source: unknown): Record<string, string>;     // non-secret metadata only
  deriveAuthorization(i: { source; binding; approved; egress: TokenEgress; now? }): Promise<DerivedToken>;
  revoke?(i: { source; egress: TokenEgress }): Promise<void>;
}
```

> **Amended 2026-11-10:** `CredentialProvider` is a union on `kind`. `deriveAuthorization` is required only on the `"derived"` arm; a `"static"` provider has none, and every provider carries a `descriptor`. The `accepts` sentence in rule 1 below names `serviceAccount` auths only — see [§Amendment — 2026-11-10](#amendment--2026-11-10-static-credential-contracts-and-derived-compatibility).

Normative rules for a host:

1. **Trust is a compiled-in registry.** Providers are registered in code through
   `createCredentialProviderRegistry(list)` (a `CredentialProviderRegistry`: `get(contract)`,
   `contracts()`), matched **exactly** by contract id. A provider is **never** loaded from app,
   pack, registry or database data, and an app can only name a contract in `accepts`; it cannot
   supply code for one (D-A1).
2. **Unsupported means refused.** A contract with no registered provider fails
   `provider_unsupported` **at attach** (when a Connection is bound to the credential) **and at use**.
3. **Egress is injected and pinned.** A provider performs no I/O of its own. It reaches the network
   only through the `TokenEgress` the host injects (`(url, { method: "POST", headers, body }) =>
   Promise<Response>`), and only to the endpoint its contract pins. A source's own `token_uri`
   (or any URL inside a source) is **never** a destination. The app's `network.allow` is not
   consulted for the provider's call, and a provider's endpoint does not widen it.
4. **Errors are fixed text.** A provider failure is a `W6WError` in phase `auth` with a fixed
   message; its `details` are limited to `retryable`, `status`, an allowlisted OAuth error name and
   the offending field name. An upstream response body, a key, a JWT or a cryptography error is
   **never** copied into a message or `details` (D-C5).
5. **Capabilities are promises the host enforces.**
   - `crossConnectionTokenReuse: false` — a derived token MUST NOT be shared between Connections.
     This is the **default** and means **connection isolation**: the host MUST namespace any token
     cache or store by Connection, because [`authorizationCacheKey`](#authorization-cache-key) itself
     carries no Connection id.
   - `handoffable: false` — the source MUST NOT leave the host that holds it, in any mode, to any
     other host or process (D-C4). A run that needs such a credential executes where the source
     lives; the host does not export the source, and does not export a token derived from it to a
     peer that would then refresh it.
   - `delegation` — the provider honours `approved.delegatedUser`.
6. **Authority comes from `approved` only.** `deriveAuthorization` reads scopes and the delegated
   user from `approved`; the raw `binding`, and any `scopes` member inside a source payload, never
   widen the token (D-D2).

### The v1 instance: `google-service-account.v1`

> **Amended 2026-11-10:** this is the only *derived* provider, no longer the only provider; three static providers sit beside it — see [§Amendment — 2026-11-10](#amendment--2026-11-10-static-credential-contracts-and-derived-compatibility).

`googleServiceAccountV1` (`@w6w/credential-providers`, provider `version` `"1.0.0"`) takes a Google
service-account key (`type: "service_account"`, `client_email`, a PKCS8 `private_key`; the optional
`private_key_id`, `project_id`, `client_id` are kept as strings) or the single-key wrapper
`{ "serviceAccountKey": <object or JSON string> }` that the `serviceAccountKey` field produces. Its
capabilities are `handoffable: false`, `crossConnectionTokenReuse: false`, `delegation: true`.

It signs an RS256 JWT (`iss` = `client_email`, `scope` = the approved scopes joined by a space,
`aud` and destination = `GOOGLE_TOKEN_ENDPOINT` (`https://oauth2.googleapis.com/token`), `exp` one
hour after `iat`, `sub` only when `approved.delegatedUser` is non-empty) and exchanges it through the
injected `TokenEgress`. The key is imported non-extractable and lives only inside one
`deriveAuthorization` call. Provider failures map to the [codes](#error-codes) as follows: an invalid
source or key, a network failure, a transient (429/5xx) or rejected exchange, and a malformed response
are `credential_invalid` (`details.retryable` distinguishes a retry-later failure); an empty approved
scope set is `scope_not_approved`; a delegation the vendor rejects is `delegation_rejected`. It
implements no `revoke`.

## Scopes and delegation

- Scopes and the delegated user live **only on the binding**. A `scopes` member inside a credential
  payload is never stored with the source and never widens authority (D-D2).
- **`approved ⊆ declared`.** The host MUST compute `ApprovedBinding` so that every approved scope is
  one the auth declares in `serviceAccount.scopes`. The default, when a binding names no scopes, is
  the declared scopes.
- Comparison uses **one** canonical form: `normalizeScopes` (trim each entry, drop empties, dedupe,
  sort). It is the only form used for the cache key and for approval comparison; an entry is never
  split on inner whitespace.
- An **app upgrade that widens** what an auth asks for — more declared scopes, or a stricter
  `impersonation` than the Connection's approval covers — MUST fail `scope_not_approved` at use until
  the owner re-approves. A host never silently widens an approval to match a new app version.
- `delegatedUser` is the name for the impersonated user everywhere. It is distinct from `owner`
  (the Connection's host attribution) and from the acting principal's subject (D-A4).
- **One boundary normaliser.** Pre-credential Google payloads (eleven app-specific shapes) are mapped
  to `{ source, binding, approved }` by exactly one pure function,
  `normaliseLegacyGoogleServiceAccount(payload, declared)`. A `scopes` member in the old payload is
  read only to **narrow** within the declared scopes, never copied and never widening. There is **no
  read-time adapter** for old shapes: compatibility stops at the boundary where a record is created or
  migrated (D-D3).

## Lifecycle policy

- **Private vs shared.** A credential created for one Connection is **private**
  (`ownerConnectionId` = that Connection). A credential created on its own, or one a second Connection
  attaches to, is **shared** (`ownerConnectionId` null). Sharing is within **one tenant and account**,
  by `credentialId` (D-B3).

> **Amended 2026-11-10:** there is no promotion — a second Connection attaching does not turn a private credential shared — and an app-scoped credential cannot be attached across apps — see [§Amendment — 2026-11-10](#amendment--2026-11-10-static-credential-contracts-and-derived-compatibility).
- **Disconnect detaches.** Deleting or disconnecting a Connection detaches it. It deletes a **private**
  credential that no other Connection references. It **never** revokes or deletes a **shared**
  credential.
- **Delete is refused while referenced.** Deleting a credential that Connections still reference MUST
  fail and report its dependents; there is **no silent cascade** (D-B5).
- **Disable is reversible.** A disabled credential denies **new resolution** at its next use, on
  **every** node a host runs, **cache hits included**: a host MUST consult the credential's status
  on every resolution, not only on a cache miss. Re-enabling restores use.
- **`revoked` is terminal.** A revoked credential is never usable again.
- **Rotation.** Replacing the source bumps `revision`. That invalidates every derived authorization
  (the revision is part of the cache key) and marks Connection tests stale (D-B4, D-5).
- **Revoke behaviour is per contract.** When an app's `revoke` hook or a provider's `revoke` exists,
  the host may run it on revoke; for `google-service-account.v1` there is **none**.
- **Tokens already issued cannot be retracted.** Disabling, rotating, revoking or deleting a
  credential stops _new_ derivation. A token already derived stays valid at the vendor until its own
  expiry; no operation here can recall it (AC7).

### `revision` and `refreshSeq`

Two counters, because two different things change (D-B4):

- **`revision`** — key material or a user-driven rotation. A bump invalidates derived tokens.
- **`refreshSeq`** — the host writing back a refreshed grant (for instance a rotating OAuth refresh
  token). It does **not** invalidate derived or sibling state.

A persisted derived token (`StoredToken`: `token`, `source` of `"provider"`, `"oauthRefresh"` or
`"tenantAuth"`, `sourceRevision`, `bindingRevision`, `version`) lives in a `TokenStore`:

- `get(key)` returns the stored token or null.
- `compareAndSet(key, expectedVersion, value)` is the **correctness guarantee** for concurrent
  writers: it succeeds only when the stored `version` is still `expectedVersion` (and a host also
  requires the source revision to be unchanged). A loser re-reads.
- `lease(key, ttlMs)` is a **best-effort** single-flight hint to avoid a thundering herd. It is never
  relied on for correctness.

`"jit"` is not a representable `StoredToken.source`: a **`jit` token is never stored**, and a `jit`
Connection has no Credential record.

## Authorization cache key

`authorizationCacheKey(input)` returns a stable key for one derived authorization. The nine inputs,
in this fixed order, are encoded as a JSON array (JSON escapes every delimiter, so two distinct
inputs never share an encoding):

| Input | Meaning |
|---|---|
| `tenant` | Owning tenant. |
| `account` | Owning account. |
| `credentialId` | The credential the token derives from. |
| `revision` | The credential's `revision` at derivation. |
| `providerVersion` | The provider's `version`. |
| `bindingRevision` | The Connection's `bindingRevision`. |
| `scopes` | The approved scopes, normalised with `normalizeScopes` first (order and duplicates do not matter). |
| `delegatedUser` | The approved delegated user, or null. |
| `audience` | The intended token audience, or null when the provider has none. |

**Skew.** A token is renewed `TOKEN_SKEW_MS` (60 000 ms) before it expires: it is due when
`expiresAt - TOKEN_SKEW_MS <= now` (`isExpiring`), with `expiresAt` in epoch milliseconds.

A rotation, a binding change, a provider version change or an approval change each alter an input
and therefore the key. The key does not encode Connection identity; see rule 5 of the
[provider contract](#provider-contract) for how isolation is kept.

## Resolution

The host owns the credential source and its refresh. The runtime reaches them through one port,
`CredentialResolver` (`@w6w/runtime`):

```ts
interface CredentialResolver {
  prepare(i: { connection: Connection; authKey: string; purpose: CredentialPurpose }):
    Promise<ResolvedAuthorization>;
}
```

`purpose` is why the host is asking, so a resolver can audit or scope its answer: `"invoke"`,
`"trigger"`, `"fields"`, `"health"`, `"test"`, `"socket"`.

- **Without a resolver, behaviour is unchanged** (D-C2): the runtime uses the Connection's own opaque
  `credential`, with the in-core `needs_refresh` → `refresh` arm. That path serves embedders with no
  host service; it never serves a `serviceAccount` auth, which **fails closed** with
  `provider_unsupported` when no resolver is supplied (for preparation, for every auth hook and for
  health): the stored source must never reach `sign` or a hook.
- **With a resolver**, `prepareAuthorization` applies the Connection lifecycle gates first
  (`pending`, `revoked`, `broken` throw their codes before any resolver is consulted), then calls
  `prepare` **exactly once** for a `connected` or `needs_refresh` Connection. The runtime never reads
  `connection.credential` and never runs the Auth `refresh` hook itself: **one refresher** (D-C2).
  The resolver's arm decides what `sign` receives: nothing for `none`, the credential for
  `legacyOpaque`, and **only the `DerivedToken`** for `derived`.
- A resolver that returns an unknown arm fails `provider_unsupported`.
- **Background runs and `jit`.** A `jit` authorization needs the caller's inbound token. A host
  resolving a `jit` Connection for a run with no inbound token (a workflow, queue, schedule or
  trigger run) MUST fail `jit_unavailable_in_background` (D-C6). The token is never propagated into a
  background run.
- **Derived `test` and `afterConnect`** run in _signed mode_: `credential` is `null` and `ctx.fetch`
  is signed by the auth's `sign` hook from the derived token (D-A3). Their input also carries the
  non-secret `binding` and `credentialDisplay` (for example the service-account email), exactly when
  supplied and never anything else.

## Error codes

These are the resolution-time codes, exactly `CREDENTIAL_ERROR_CODES`. All are phase `auth`. They are
raised by the host's or the runtime's preparation step (and by a provider it calls), **never by hook
code**. They join the closed code set of the [Hook Runtime RFC](./hook-runtime.md#codes).

| Code | When |
|---|---|
| `credential_disabled` | The Connection's credential has `status: "disabled"`. |
| `credential_missing` | The Connection names a credential that does not exist, or has none where one is required. |
| `credential_revoked` | The credential has `status: "revoked"` (terminal). |
| `delegation_rejected` | The vendor refused to issue a token for the approved `delegatedUser`. |
| `provider_unsupported` | No compiled-in provider for the credential's contract, at attach or at use; or a `serviceAccount` auth was run with no resolver; or the resolver returned an unknown arm. |
| `scope_not_approved` | The requested scopes or impersonation are not covered by the approved binding (including after an app upgrade that widened them), or there are no approved scopes. |
| `auth_not_found` | The Connection names an auth `key` the app does not declare. Never falls back to another auth. |
| `jit_unavailable_in_background` | A `jit` authorization was requested in a run that has no inbound token. |
| `credential_invalid` | The source or key is unusable, or the token exchange failed or returned something unusable. |

## Conformance

A host that implements this RFC MUST satisfy:

1. No API surface, record, log, trace or error carries a source, a private key, a signed assertion or
   an upstream error body.
2. Only a compiled-in provider interprets a source, only in the host's realm; an unregistered
   contract fails `provider_unsupported`.
   > **Amended 2026-11-10:** for the three static contracts the host also reads the source, only through the pure `@w6w/types` helper `mapGenericSource`, in the host realm and never in a sandbox or publisher code; rule 2 still holds for derived contracts — see [§Amendment — 2026-11-10](#amendment--2026-11-10-static-credential-contracts-and-derived-compatibility).
3. `sign` receives a `DerivedToken` and never the source for a `serviceAccount` auth; `test` and
   `afterConnect` receive `credential: null`.
4. Approved scopes and delegation are a subset of what the auth declares; a widening app upgrade
   fails `scope_not_approved` until re-approved.
5. Disable, rotation and delete take effect at the next use on every node, cache hits included.
6. A non-handoffable source never leaves the host that holds it.

Reference implementations: `@w6w/runtime` (`prepareAuthorization`, `authFor`, the signed-mode hook
runner) and `@w6w/credential-providers`; the `fixtures/apps/service-account` app exercises the app
side.

## Open questions

1. **Cross-account and multi-owner sharing.** Sharing is within one tenant and account in v1.
2. **Handoffable providers.** `handoffable: false` is the only value `google-service-account.v1` has;
   flipping a future provider is additive but needs a hub/spoke rule for where derivation runs.
3. **More providers.** v1 has one contract. Other service-account and signed-assertion schemes
   (cloud and database vendors) are future contract ids.
4. **Provider revoke.** `revoke?` exists on the provider interface; no v1 provider implements it, and
   issued tokens cannot be retracted regardless.

> **Amended 2026-11-10:** questions 2 and 3 are partly answered: three static providers now ship, all `handoffable: true` — see [§Amendment — 2026-11-10](#amendment--2026-11-10-static-credential-contracts-and-derived-compatibility).

## Status ladder

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze. **This RFC.**
- `Final` — frozen for the current `manifestVersion`. Breaking changes require a new RFC and a
  `manifestVersion` bump.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.

## Amendment — 2026-11-10: static credential contracts and derived compatibility

> **Additive.** This section adds three credential contracts that need no derivation, defines how an
> auth's accepted contracts are derived, and states who may see and attach a credential. It qualifies
> the passages marked `Amended 2026-11-10` above and edits none of them: `google-service-account.v1`
> and the `serviceAccount` auth are unchanged, and `legacy:` credentials stay never-shared.

### Static contracts

A **static** contract is a credential whose source is used as-is: it has no token exchange, no cache
and no refresh. Its provider has `kind: "static"` and no `deriveAuthorization`
(`StaticCredentialProvider` declares `deriveAuthorization?: never`; `DerivedCredentialProvider`
declares `kind: "derived"` and requires it). `CredentialProvider` is the union of the two.

The compiled-in registry holds four providers, in this order:

| contract | kind | source | descriptor label | descriptor fields |
|---|---|---|---|---|
| `google-service-account.v1` | derived | unchanged | `Google service account` | `serviceAccountKey` (secret, multiline) |
| `bearer.v1` | static | `{ token }` | `Bearer token` | `token` (secret) |
| `api-key.v1` | static | `{ key }` | `API key` | `key` (secret) |
| `basic.v1` | static | `{ username, password }` | `Username and password` | `username` (not secret), `password` (secret) |

- Every provider carries a `descriptor` (`{ label, fields: { key, label, secret, multiline? }[] }`);
  a host builds its credential-type listing (`CredentialTypeDescriptor`: `id`, `label`, `fields`) from
  the registry, so there is one source of truth for create and rotate forms.
- Static capabilities are `handoffable: true`, `crossConnectionTokenReuse: false`, `delegation: false`.
- A static `validateSource` accepts a plain object with **exactly** the contract's keys, each a
  non-empty string (trimmed); it refuses `\r`, `\n` and `\0` in any value and, for `basic.v1`, a
  `:` in the username (RFC 7617). Failures are `credential_invalid` with fixed text naming the field,
  never the value (rule 4 of [Provider contract](#provider-contract) holds unchanged).
- `displayOf` is `{}` for `bearer.v1` and `api-key.v1`, and `{ username }` for `basic.v1`; a
  password, token or key is never displayed.
- Because a static source is used as-is, a host MUST NOT run a refresh or write back into a
  credential for a static contract: a hook can never overwrite a shared credential.

### Compatibility is derived from the auth type

A static contract is not named in a manifest. The accepted contracts of an auth are a pure function
of the auth (`acceptedContractsFor`; `genericContractFor` for the static part). A *secret field* is
one with `type: "secret"` or `secret: true`.

| auth | accepted contract |
|---|---|
| `serviceAccount` | `serviceAccount.accepts`, unchanged |
| `bearer` with exactly one field, and it is secret | `bearer.v1` |
| `apiKey` with exactly one field, and it is secret | `api-key.v1` |
| `basic` with exactly two fields, one `credentialRole: "username"` and one `"password"` | `basic.v1` |
| anything else (extra fields, no fields, `oauth2`, `custom`, `tenantAuth`, `jit`) | none |

Matching is **1:1 by type**: an API key is not offered to a `bearer` auth, and an untagged `basic`
auth is not offered a credential at all. The role of a `basic` field is read only from
`Param.credentialRole` (see [Param RFC](./param.md#amendment--2026-11-10-credentialrole)); a field is
never mapped by its key, label or position, so a `basic` auth whose secret and non-secret fields are
named `username` and `password` but carry no roles is not compatible. An auth with extra
region, subdomain or base-URL fields is not compatible either: this version has no way to collect
such a non-secret input at attach time.

At attach the host maps the source onto the auth's own field keys (`mapGenericSource`), by role for
`basic`: `{ [usernameKey]: source.username, [passwordKey]: source.password }` (a crossed pair, role
`password` on the field keyed `username`, maps by role). It maps nothing when the contract is not the
auth's, or when the source lacks a contract field. Compatibility is still not authorization: a static
contract has no scopes or delegation.

### App-scoped and shared credentials

A credential is either **shared** (account-wide, listed and attachable by any compatible app) or
**app-scoped** (private: created inline from one app's connect form and owned by that app's
Connection). A host MUST:

- list **shared credentials only** when the caller asks for credentials by contract or by app and
  auth; an app-scoped credential is never listed for, offered to, or attachable by another app, and
  attaching or resolving it from another app is refused;
- not promote an app-scoped credential to shared: create it again where it should be shared;
- keep `legacy:<appId>#<authKey>` credentials bound to their one app and auth key.

### Authoring surface

An auth declares no top-level `accepts`. The host emits an `accepts` array on each auth in its auth
listing, derived from the auth type as above; a manifest cannot supply one, and a host strips
an inbound top-level `accepts` rather than trusting it (see [Auth RFC](./auth.md#amendment--2026-11-10-host-derived-accepts)).

### The legacy Google normaliser

The legacy-payload normaliser (`normaliseLegacyGoogleServiceAccount`) also accepts the connect form's
wrapper `{ serviceAccountKey: <object or JSON text>, delegatedUser?, scopes?, projectId?, location? }`.
Key fields (`client_email`, `private_key`, `private_key_id`, `client_id`, `project_id`, `type`) are read
from the inner object; `delegatedUser`, `scopes`, `location` and the `projectId` setting stay on the
outer payload and land in the binding. A `serviceAccountKey` that is neither an object nor JSON text of
one is `credential_invalid` with `field: "serviceAccountKey"` and fixed text. The flat payload is
unchanged.
