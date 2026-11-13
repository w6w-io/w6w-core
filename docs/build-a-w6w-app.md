---
id: null
key: "build-a-w6w-app"
title: "Build a w6w app"
section: "build-apps"
order: 0
description: "Agent-ready instructions for authoring a correct w6w App."
format: "markdown"
shared: true
sourceRepo: null
sourcePath: null
sourceSha: null
sourceRefSha: null
sourceUrl: null
syncedAt: null
createdAt: null
updatedAt: null
---

# Build a w6w App — Agent Instructions

> **Audience: an LLM / coding agent building a w6w App.** This file is written to be pasted into an
> agent prompt. It is self-contained: the rules, contracts, and examples an agent needs to author a
> correct App without reading the whole spec. When something here is ambiguous, the RFCs under
> [`../rfcs/`](../rfcs/) and the types in [`@w6w/types`](../packages/types/) are the source of
> truth.

## Start from a template — do not scaffold from scratch

Two official starter templates satisfy the **identical** App contract. Clone one and edit it; the
toolchain is the only difference. Prefer **Deno** unless the user needs Node.

| Template                                                                            | Toolchain                                     | Use when                                                       |
| ----------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| **[w6w-io/w6w-app-template-deno](https://github.com/w6w-io/w6w-app-template-deno)** | Deno + JSR `@w6w/types` + `deno test`         | Default. Zero-install; matches the reference runtime directly. |
| **[w6w-io/w6w-app-template-node](https://github.com/w6w-io/w6w-app-template-node)** | Node 22 + npm `@w6w/types` + `tsx` + `vitest` | The user's stack is Node, or they want `vitest`.               |

Both ship a working app you mutate into the target: bearer-token Auth (`sign` + `test`), a `read` +
a `perform` Action against `httpbin.org`, unit tests with a mocked `HookContext`, and a green CI
workflow. On GitHub, **Use this template**; or `git clone` and strip it down.

**Keep `.ts` extensions in imports** (`import x from "./actions/foo.ts"`). The Node template keeps
them too, so the same source runs unchanged under the Deno runtime.

## Mental model — the five invariants

Everything below follows from these. Violating one is the most common way an app breaks.

1. **An App is an npm-style package.** _Identity_ lives in `package.json` (a `w6w` block reusing
   native fields); _behavior_ lives in an **entry module** (default `./index.ts`) that
   `default`-exports an `AppDefinition` — `{ actions, auth }`.
2. **Code-first, co-located.** Each Action and Auth method is one `.ts` file that `default`-exports
   an object mixing its _config_ (key, title, params) with its _functions_ (`execute`, `sign`,
   `test`). No `.action.json` / `.auth.json` files.
3. **Hooks at the boundaries.** Anything that varies per publisher — calling the service, injecting
   auth, populating a dropdown, validating input — is a hook function the runtime calls. Hooks
   receive `(input, ctx)`.
4. **All network is host-mediated.** Untrusted code runs in a **network-less Deno sandbox**. Reach
   the network _only_ via `ctx.fetch`; the global `fetch` is denied and will throw. Every hostname a
   hook calls must be declared in `w6w.network.allow`.
5. **Credentials are opaque.** Actions never see raw credentials. The Auth **`sign`** hook runs in
   its own network-less worker, so the code that signs requests can't reach the network and the code
   that calls the network has no credential. Neither can leak it. For a `serviceAccount` auth the
   host goes one step further: the stored key is never given to any of your hooks — `sign` gets only
   a short-lived token the host derived from it.

## File layout

```
my-app/
├── package.json            # identity — the `w6w` block (see below)
├── index.ts                # entry: default-exports { actions, auth }
├── actions/
│   └── send-email.ts       # one file per action, default export = ActionDefinition
├── auth/
│   └── api-key.ts          # one file per auth method, default export = AuthDefinition
├── assets/
│   └── icon.svg            # referenced from w6w.appearance.icon
└── (deno.json | tsconfig.json)  # from the template
```

## `package.json` — identity

Native npm fields are reused (`version`, `description`, `author`, `license`, `homepage`,
`repository`, `keywords`). App-specific fields go in the `w6w` block. Only `id`, `displayName`, and
`appearance` are required there; the rest fall back to native fields or defaults.

```jsonc
{
  "name": "@acme/sendgrid",
  "version": "1.0.0",
  "description": "Send transactional email via SendGrid.",
  "license": "MIT",
  "author": { "name": "Acme" },
  "w6w": {
    "id": "io.acme.sendgrid", // reverse-DNS, globally unique, immutable across versions
    "displayName": "SendGrid",
    "categories": ["communication"], // 1–3 from the controlled vocabulary (rfcs/categories.md)
    "appearance": { "icon": { "svg": "./assets/icon.svg" } },
    "network": { "allow": ["api.sendgrid.com", "127.0.0.1"] }, // egress allowlist; add 127.0.0.1 for local tests
    "entry": "./index.ts" // defaults to package `main`, then ./index.ts
  }
}
```

Rules the validator enforces: `id` is reverse-DNS (`^[a-z0-9-]+(\.[a-z0-9-]+)+$`), `version` is
semver, `categories` has 1–3 entries. Run `deno task validate` (the `@w6w/validator` CLI) to check.

## Entry module (`index.ts`)

```ts
import type { AppDefinition } from "@w6w/types";
import sendEmail from "./actions/send-email.ts";
import apiKey from "./auth/api-key.ts";

export default {
  actions: [sendEmail],
  auth: [apiKey], // optional; omit for a no-auth app
} satisfies AppDefinition;
```

## Writing an Action

An Action is `read`, `search`, or `perform`. Type the input/output for safety.

```ts
import type { ActionDefinition } from "@w6w/types";

interface Input {
  to: string;
  subject: string;
  body: string;
  apiBase: string;
}

const sendEmail: ActionDefinition<Input> = {
  key: "send-email", // kebab-case, unique within the app
  type: "perform", // read | search | perform
  title: "Send Email",
  description: "Send a transactional email.",
  idempotent: false, // perform only: is it safe to retry? drives dedupe/retry
  params: [
    { key: "to", label: "To", type: "string", required: true },
    { key: "subject", label: "Subject", type: "string", required: true },
    { key: "body", label: "Body", type: "text", required: true },
    {
      key: "apiBase",
      label: "API base URL",
      type: "string",
      default: "https://api.sendgrid.com",
      hint: "Overridable so tests can point at a local endpoint.",
    },
  ],
  output: [{ key: "status", type: "number", label: "HTTP status" }],

  async execute(input, ctx) {
    ctx.log("info", "sending email", { to: input.to });
    // Use ctx.fetch — NOT global fetch. No Authorization header here: the runtime
    // routes this request through the Auth `sign` hook, which injects the credential.
    const res = await ctx.fetch(`${input.apiBase}/v3/mail/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({/* ... */}),
    });
    return { status: res.status };
  },
};
export default sendEmail;
```

`requiresAuth` defaults to `true` when the app declares Auth, `false` otherwise. Set
`requiresAuth: false` to opt a specific Action out (e.g. a public health check).

## Writing an Auth method

`test` is the only **required** hook. Add `sign` to inject credentials into outbound requests. `key`
is referenced by the stored Connection.

```ts
import type { AuthDefinition } from "@w6w/types";

const apiKey: AuthDefinition = {
  key: "api-key",
  type: "apiKey", // oauth2 | apiKey | basic | bearer | custom | tenantAuth | jit | serviceAccount
  displayName: "API Key",
  apiKey: { in: "header", name: "Authorization", prefix: "Bearer " },
  fields: [ // collected at connect time; Param[]
    { key: "apiKey", label: "API Key", type: "secret", required: true },
  ],

  // Gets the stored credential on this (apiKey) path. Runs network-less: it stamps auth
  // onto the request and returns it, but cannot itself reach the network.
  sign({ request, credential }) {
    const { apiKey } = credential as { apiKey: string };
    request.headers["authorization"] = `Bearer ${apiKey}`;
    return request;
  },

  // Required. Validate the credential is live at connect time.
  test() {
    return { ok: true };
  },
};
export default apiKey;
```

Full Auth hook lifecycle (all optional except `test`): `preflight` → `exchange` (auth code / form →
opaque credential; the host stores only its output) → `test` → `afterConnect` (fetch label data) →
`sign` (per request) → `refresh` (renew expired credential) → `revoke` (on disconnect). For OAuth2,
set `type: "oauth2"` and the `oauth2` config (`authorizationUrl`, `tokenUrl`, `scopes`, `pkce`); see
[`rfcs/auth.md`](../rfcs/auth.md). An OAuth2 auth gets token refresh **without** a `refresh` hook —
see [Refresh & keep-alive](#refresh--keep-alive).

**Host-sourced credentials (no user fields).** Two auth types carry no `fields` and no connect flow
— the host supplies the credential and hands it to `sign` as a bearer. Use them for an App that
fronts the tenant/partner's own API:

- **`tenantAuth`** — the host _mints_ a live, per-subject token from a per-tenant app link
  (partner's token endpoint). Zero per-user setup; works in background runs. Set
  `tenantAuth: { link, resourcePrefix? }`.
- **`jit`** — the host _forwards the caller's own inbound token_ (the JWT the tenant minted for this
  request) verbatim. No app link, nothing to configure; but it only works when the API accepts that
  token and only for user-driven (not background) runs. Set `jit: { resourcePrefix? }`.

Both `sign` hooks just stamp `Authorization: Bearer ${credential.token}` — the provenance difference
is entirely host-side. An App can declare **several** auth methods (e.g. `jit` for the tenant's base
creds _and_ `oauth2` for a separate account); the user picks one per Connection.

**Service accounts (`serviceAccount`).** For an API that authenticates a service account (e.g. a
Google service-account key) the user stores the key **once** as a credential, and the host derives
short-lived tokens from it through a compiled-in provider. Your App declares only which credential
contracts it accepts, the scopes it asks for and whether it impersonates a user; it never declares a
token URL. The key is never given to any of your hooks:

```ts
import type { AuthDefinition } from "@w6w/types";

const serviceAccount: AuthDefinition = {
  key: "service-account",
  type: "serviceAccount",
  displayName: "Service account",
  fields: [ // the credential-source input: by convention exactly one field
    {
      key: "serviceAccountKey",
      label: "Service account key",
      type: "json",
      secret: true,
      required: true,
      ui: "textarea",
    },
  ],
  serviceAccount: {
    accepts: ["google-service-account.v1"], // the contract ids you take
    scopes: ["https://www.googleapis.com/auth/cloud-platform"], // the ceiling you may ask for
    impersonation: "none", // none | optional | required
  },

  // `credential` here is the derived token, never the stored key.
  sign({ request, credential }) {
    const { accessToken } = credential as { accessToken: string };
    request.headers["authorization"] = `Bearer ${accessToken}`;
    return request;
  },

  // `credential` is null: do not read it. ctx.fetch is signed for you by the host.
  async test(_input, ctx) {
    const res = await ctx.fetch("https://api.example.com/whoami");
    return { ok: res.ok };
  },
};
export default serviceAccount;
```

`afterConnect` is the same: no `credential`, a signed `ctx.fetch`. Both also receive the
Connection's non-secret `binding` and `credentialDisplay` (such as the service-account email), never
key material. A host that supplies no credential resolver refuses a `serviceAccount` auth with
`provider_unsupported`. See [`rfcs/credential.md`](../rfcs/credential.md) and the working example
[`fixtures/apps/service-account`](../fixtures/apps/service-account/).

## Refresh & keep-alive

The host keeps a Connection's credential alive for two kinds of auth:

- a **`type: "oauth2"`** auth: the host refreshes the token itself with the standard grant. You do
  **not** write a `refresh` hook for a standard OAuth2 vendor;
- **any auth with a `refresh` hook** (`bearer`, `custom`, `apiKey`, `basic`, or a non-standard
  `oauth2`): the host runs your hook.

Either way your job is to describe the credential's lifetimes so the host can schedule it. The spec
is
[`rfcs/auth.md` §Amendment — 2026-11-13](../rfcs/auth.md#amendment--2026-11-13-refresh-lifecycle).
`jit`, `tenantAuth` and `serviceAccount` auths have no stored credential to refresh and are never
kept alive.

**What the host does.**

- **Refresh on use.** When a call needs the credential and its `expiresAt` is within 60 s, the host
  refreshes it first.
- **Keep-alive.** A background sweep also refreshes a Connection nobody is using, to stop its
  **refresh token** from lapsing: when the longest allowed gap between refreshes has passed (a third
  of the refresh token's lifetime, at most 7 days, counted from the last refresh or from connect),
  or when the refresh token expires within an hour. The access token's expiry does not trigger it; a
  short-lived access token is refreshed on use. An idle Connection with 1-hour access tokens is
  refreshed about once a week, not hourly.
- **Built-in grant** (`oauth2` without a hook). The host POSTs `grant_type=refresh_token` and the
  stored `refresh_token` to `oauth2.refreshUrl`, or to `tokenUrl` when `refreshUrl` is not set. It
  authenticates with the same OAuth client and method as the code exchange (`tokenAuthMethod`), and
  encodes the body per `tokenBodyFormat`.
- **Rotation.** If the grant's response has a new `refresh_token`, the host stores it. If not, it
  keeps the old one. `expiresAt` comes from `expires_in`. A `refresh_token_expires_in` in the
  response (at connect time or on refresh) is stored too, and outranks `refreshTokenTtlSeconds` for
  the cadence. A hook does its own rotation: see the hook contract below.
- **Failures.** A Connection whose refreshes keep failing is retried hourly. After 72 hours, and
  once one more attempt past that mark has failed too, it is marked `broken` and the user is asked
  to reconnect. If the host itself was down, it tries again before giving up.
- **Permanent failures** skip that wait: the Connection is marked `broken` on the first one. That
  happens when your `refresh` hook throws `ReauthRequiredError` (below), and when the built-in grant
  gets `invalid_grant` (the refresh token is invalid, expired or revoked). It never happens when a
  concurrent refresher had already rotated the token: the host re-reads the stored credential first.
  Every other failure (`5xx`, network, `invalid_client`, a plain throw) is transient.
- **Revoke on delete.** Deleting a Connection runs the auth's `revoke` hook with its credential,
  best-effort.

The user can turn keep-alive off per Connection ("Keep connected"); it is on by default.

**What to declare.** The two lifetimes sit on the **auth itself** (next to `type`), because they
describe the credential, whatever its type. The other two fields are `oauth2`-only:

| Field                          | When                                                                                      | Value                                                                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refreshTokenTtlSeconds`       | The refresh token (or whatever the hook renews from) expires                              | Its lifetime in seconds. This sets how often keep-alive refreshes. A stated expiry takes precedence: `refresh_token_expires_in` in an OAuth2 response, or `refreshTokenExpiresAt` from your hook. Omit when it never expires. |
| `accessTokenTtlSeconds`        | A new credential states no expiry (no `expires_in`, or a hook result with no `expiresAt`) | The access-token lifetime in seconds. The host sets `expiresAt = now + this` at connect and after each refresh. Without it such a token is never treated as expiring on use, and is only refreshed on the keep-alive cadence. |
| `oauth2.refreshUrl`            | The refresh endpoint is **not** the `tokenUrl`                                            | The refresh endpoint. Leave it unset otherwise.                                                                                                                                                                               |
| `oauth2.builtinRefresh: false` | The vendor has **no** refresh grant (tokens never expire, or the user must reconnect)     | Turns the built-in refresh off. Without a hook the Connection is then never refreshed and keep-alive skips it.                                                                                                                |

Leave `builtinRefresh` unset in every other case; it defaults to `true`.

**Find the lifetimes in the vendor's docs** (search "refresh token expiration", "token lifetime",
"offline access"). Record three facts in a comment next to the fields:

1. The access-token lifetime, and whether the token response includes `expires_in`.
2. The refresh-token lifetime, or "does not expire".
3. Whether that lifetime is **sliding** (each refresh issues a new refresh token, or restarts the
   clock) or **absolute** (counted from the user's consent, and no refresh extends it). Keep-alive
   only helps a sliding token. With an absolute lifetime the user has to reconnect when it ends, so
   say so in the auth's `description`.

If the docs don't say, test it: connect, refresh twice with a sandbox account, and check whether the
`refresh_token` changes.

**Worked example 1: OAuth2.** Access tokens live 7 days, and the token response has no `expires_in`.
Refresh tokens live 30 days and are sliding: every refresh issues a new one.

```ts
import type { AuthDefinition } from "@w6w/types";

const oauth2: AuthDefinition = {
  key: "oauth2",
  type: "oauth2",
  displayName: "Sign in with Example",
  // Vendor docs: access token 7 d (no expires_in); refresh token 30 d, rotated on refresh.
  accessTokenTtlSeconds: 604_800,
  refreshTokenTtlSeconds: 2_592_000,
  oauth2: {
    authorizationUrl: "https://vendor.example/oauth/authorize",
    tokenUrl: "https://vendor.example/oauth/token", // also used for refresh: no refreshUrl
    scopes: ["events:read"],
  },
  sign({ request, credential }) {
    const { accessToken } = credential as { accessToken: string };
    request.headers["authorization"] = `Bearer ${accessToken}`;
    return request;
  },
  async test({ credential }, ctx) {
    const { accessToken } = credential as { accessToken: string };
    const res = await ctx.fetch("https://vendor.example/api/me", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return { ok: res.ok };
  },
};
export default oauth2;
```

Max idle is `min(30 d / 3, 7 d) = 7 d`, so keep-alive refreshes at day 7, 14, 21, … Each refresh
issues a new 30-day refresh token, so a Connection with no activity for months stays connected. (The
URLs above are placeholders; use the vendor's real ones.)

**Worked example 2: a session login (bearer) with exchange, refresh and revoke.** The vendor is not
OAuth2. The user signs in with email and password; the app turns them into a session and keeps only
the session. The vendor (`vendor.example`):

- `POST /partner-login` `{ email, password }` returns
  `{ data: { token, refreshToken, expiresIn, refreshTokenExpiresIn, refreshTokenExpiresAt, user } }`.
  The access token lives 7 days (`expiresIn: 604800`), the refresh token 30 days.
- `POST /partner-refresh-token` `{ refreshToken }` (no `Authorization` header) returns the same
  shape. **Both** tokens rotate on every refresh, and the 30-day refresh lifetime is **sliding**.
  For 5 minutes after a refresh the old refresh token replays the same new pair (lifetimes as they
  remain at that moment); after that it is `401 refresh_token_reused`.
- `401 invalid_refresh_token` / `refresh_token_reused` / `refresh_token_expired` and
  `403 account_disabled` / `org_access_revoked` mean the user must sign in again. Per the vendor,
  any refresh failure other than `400` means that.
- `POST /partner-revoke-token` `{ refreshToken }` ends the session; `401 invalid_refresh_token`
  means it already ended.

```ts
import { type AuthDefinition, ReauthRequiredError } from "@w6w/types";

const API = "https://vendor.example";

interface Session {
  token: string;
  refreshToken: string;
  expiresAt: string;
  refreshTokenExpiresAt: string;
}

interface VendorSession {
  token: string;
  refreshToken: string;
  expiresIn: number;
  refreshTokenExpiresIn: number;
}

/** The vendor's reply → the credential to store. Expiries are computed at RESPONSE time. */
function toSession(d: VendorSession): Session {
  const now = Date.now();
  return {
    token: d.token,
    refreshToken: d.refreshToken,
    // `expiresIn` is the REMAINING lifetime, so this is right for a replayed response too.
    expiresAt: new Date(now + d.expiresIn * 1000).toISOString(),
    refreshTokenExpiresAt: new Date(now + d.refreshTokenExpiresIn * 1000).toISOString(),
  };
}

/** Refusals after which only a new sign-in helps. */
const SIGN_IN_AGAIN = new Set([
  "invalid_refresh_token",
  "refresh_token_reused",
  "refresh_token_expired",
  "account_disabled",
  "org_access_revoked",
]);

async function errorCode(res: Response): Promise<string | undefined> {
  // Read only the code. Never log the body or a token.
  const body = await res.json().catch(() => undefined) as { error?: unknown } | undefined;
  return typeof body?.error === "string" ? body.error : undefined;
}

const session: AuthDefinition = {
  key: "session",
  type: "bearer",
  displayName: "Email and password",
  // Vendor docs: access token 7 d; refresh token 30 d, sliding, both rotate on every refresh.
  // The responses state both expiries, which outrank these; these are the fallback.
  accessTokenTtlSeconds: 604_800,
  refreshTokenTtlSeconds: 2_592_000,
  fields: [
    { key: "email", label: "Email", type: "string", required: true },
    { key: "password", label: "Password", type: "secret", required: true },
  ],

  // Connect: the host runs this with what the user typed and stores ONLY what it returns.
  // The password is used once and never stored.
  async exchange({ fields }, ctx) {
    const { email, password } = fields as { email: string; password: string };
    const res = await ctx.fetch(`${API}/partner-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      // `code` reaches the connect response; the message never does.
      throw Object.assign(new Error("sign-in rejected"), {
        code: (await errorCode(res)) ?? "login_failed",
      });
    }
    return toSession((await res.json() as { data: VendorSession }).data);
  },

  sign({ request, credential }) {
    request.headers["authorization"] = `Bearer ${(credential as Session).token}`;
    return request;
  },

  async refresh({ credential }, ctx) {
    const prev = credential as Session;
    const res = await ctx.fetch(`${API}/partner-refresh-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: prev.refreshToken }),
    });
    if (res.ok) return toSession((await res.json() as { data: VendorSession }).data);
    const code = await errorCode(res);
    if (res.status === 401 || res.status === 403) {
      // Permanent: the host marks the Connection broken now and asks the user to reconnect.
      throw new ReauthRequiredError(code && SIGN_IN_AGAIN.has(code) ? code : undefined);
    }
    // 400, 5xx, network: transient. The host retries hourly and keeps the stored session.
    throw new Error(`refresh failed (${res.status})`);
  },

  // Disconnect: the host runs this after deleting the Connection. Best-effort.
  async revoke({ credential }, ctx) {
    const res = await ctx.fetch(`${API}/partner-revoke-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: (credential as Session).refreshToken }),
    });
    if (res.ok || (res.status === 401 && await errorCode(res) === "invalid_refresh_token")) return;
    throw new Error(`revoke failed (${res.status})`);
  },

  async test({ credential }, ctx) {
    const res = await ctx.fetch(`${API}/api/me`, {
      headers: { authorization: `Bearer ${(credential as Session).token}` },
    });
    return { ok: res.ok };
  },
};
export default session;
```

`network.allow` must list `vendor.example`. What the host does with this auth:

- **Connect** runs `exchange` → `test` → `afterConnect`, and stores the returned session:
  `{ token, refreshToken, expiresAt, refreshTokenExpiresAt }`, no password. A failed `exchange` is a
  `422` carrying your error's `code` (`hookCode`); nothing is saved. Re-entering the sign-in form (a
  reconnect) runs `exchange` again and replaces the session.
- **Keep-alive** runs `refresh` at day 7, 14, 21, … (max idle `min(30 d / 3, 7 d)`). Each call
  rotates both tokens and slides the 30-day lifetime forward, so an idle Connection never lapses.
- **Concurrent refreshes** are safe: two refreshers that present the same refresh token within the
  vendor's 5-minute window both get the same pair, and the host keeps one write.
- **`ReauthRequiredError`** marks the Connection `broken` at once, on use or in the background, with
  no retries. Any other throw is retried hourly, for up to 72 hours.
- **Delete** runs `revoke` with the stored session. A failing `revoke` never blocks the delete.

The `exchange` contract: input `{ fields }` (what the user typed), output the complete credential to
store as a non-empty plain object. Only the output is stored. A throw fails the connect; put a short
machine code (`[a-z][a-z0-9_]*`) on the error's `code` to tell the user why, and never put secrets
in the message.

**When to write a `refresh` hook for an `oauth2` auth.** Only when the built-in grant cannot work,
because the vendor's refresh is non-standard:

- the refresh is not `grant_type=refresh_token` (a custom grant or a different endpoint shape);
- it needs extra parameters or headers the built-in grant does not send;
- the response is not the standard `{ access_token, refresh_token?, expires_in? }` JSON (for example
  nested, or with a different field name).

If the auth defines a hook, the host runs it and never runs the built-in refresh.

**The `refresh` hook contract** (every auth type):

- **Input:** `{ credential }`, the whole stored credential. For the host's own OAuth exchange that
  is `{ accessToken, refreshToken?, expiresAt?, refreshTokenExpiresAt?, scope?, tokenType? }`; for
  any other auth it is what the user entered in `fields`, plus the `expiresAt` the host set.
- **Context:** `ctx.fetch`, allowed to reach the hosts in `network.allow` (and an `oauth2` auth's
  `tokenUrl` / `refreshUrl`). The hook does **not** receive the OAuth client id or secret, so a hook
  works only for a vendor whose refresh does not need them.
- **Output:** the **complete** new credential as a non-empty plain object. It **replaces** the
  stored one; nothing is merged back. Carry forward everything you still need, and keep the old
  `refreshToken` when the vendor did not send a new one.
- **`expiresAt`** (epoch ms or ISO 8601): the new token's expiry. Return it when the vendor states
  one. When you return none (or the old value unchanged, as a `{ ...prev }` spread does), the host
  sets `now + accessTokenTtlSeconds`, or no expiry when that is not declared.
- **`refreshTokenExpiresAt`** (optional, epoch ms or ISO 8601): when the vendor states when the new
  refresh token expires. It outranks `refreshTokenTtlSeconds` for the cadence. A value carried over
  unchanged while `refreshToken` changed is dropped, because it described the old token.
- **Errors:** throw. The host keeps the old credential, and never surfaces your message to users. A
  plain throw is transient: retried hourly, for up to 72 hours.
- **Sign in again:** when the vendor says the credential can never be renewed (the refresh token is
  invalid, reused or expired, or the account is disabled), throw `ReauthRequiredError` from
  `@w6w/types`, optionally with the vendor's code:
  `throw new ReauthRequiredError("account_disabled")`. An `Error` with `code: "reauth_required"`
  (and an optional `reason`) is the same signal. The host marks the Connection `broken` at once and
  records the reason when it is a short code (`[a-z][a-z0-9_]*`). Only `code` and `reason` cross the
  sandbox, so never put vendor text in them.

An `oauth2` hook for a vendor whose refresh answers `{ data: { token, renew, ttl } }`:

```ts
async refresh({ credential }, ctx) {
  const prev = credential as { accessToken: string; refreshToken: string };
  const res = await ctx.fetch("https://vendor.example/oauth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: prev.refreshToken }),
  });
  if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
  const body = await res.json() as { data: { token: string; renew: string; ttl: number } };
  return {
    ...prev,
    accessToken: body.data.token,
    refreshToken: body.data.renew || prev.refreshToken,
    expiresAt: Date.now() + body.data.ttl * 1000,
  };
},
```

## `HookContext` (`ctx`) — the ambient API

Injected into every hook. **This is the entire surface a hook may use for I/O.**

| Member                       | Use                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ctx.fetch`                  | Host-mediated network. The ONLY way to make requests. Same signature as `fetch`.                                                                                                     |
| `ctx.log(level, msg, data?)` | Structured logging. `level`: `"debug" \| "info" \| "warn" \| "error"`.                                                                                                               |
| `ctx.connection?`            | The **redacted** Connection (display metadata only). **Never contains the credential.**                                                                                              |
| `ctx.invocation?`            | Read-only call metadata: `invocationId` (use as idempotency key for `perform`), `runId`, `stepId`, `trigger` (skip real side-effects when `"editor"`/`"test"`). Data, not authority. |
| `ctx.host?`                  | Non-portable host capabilities. Reading it ties the app to that host — avoid in portable apps.                                                                                       |

## Params — form field types

Every form surface (Action `params`, Auth `fields`) is an ordered `Param[]`. Types: `string`,
`text`, `number`, `boolean`, `select`, `multiselect`, `date`, `datetime`, `secret`, `file`, `json`,
`code`, `group`, `section`.

Common fields: `key`, `label`, `type`, `required`, `default`, `hint`, `placeholder`, `secret`
(masked + encrypted; implicit for `type: "secret"`), `options` (for `select`/`multiselect`),
`validation` (`pattern`, `min`/`max`, `minLength`/`maxLength`, `integer`, `enum`), `dependsOn`,
`showIf` (JSONLogic), `children` (for `type: "group"` and `type: "section"`). Dynamic dropdowns use
`options: { source: "./path/to/hook.ts" }` returning `Option[]`. `section` is a layout-only
container of `children` — `section: "collapsible"` for a titled, collapsed-by-default group (e.g.
advanced fields), `section: "group"` with `layout: "row" | "stack"` for side-by-side clusters (e.g.
sender email + name). Unlike `group` (which nests its value under its `key`), a section's children
keep their own top-level keys. See [`rfcs/param.md`](../rfcs/param.md).

**Accept what users paste — `parse`.** An Action or Trigger param may carry `parse(value)`, a
function the sandbox runs on that param's value before `execute` (or before a trigger hook that
receives `params`). Use it so a field takes the form users actually have: a Google Sheets param
accepts the spreadsheet id **or** its URL (`https://docs.google.com/spreadsheets/d/<id>/edit`) and
`parse` reduces the URL to the id. It sees the resolved value (expressions already evaluated), may
be async, and throws to reject. Declare a shared param once (`lib/params.ts`) and reuse it in every
action. `parse` never reaches the manifest. Type the param as `ParamDefinition` (from `@w6w/types`).

## Hard rules (the sandbox will enforce these)

- ✅ **Use `ctx.fetch`.** ❌ Global `fetch`, `Deno.*`, `node:*` net/fs, `XMLHttpRequest` are denied
  in the action sandbox and throw. The action worker has `read` scoped to the app dir and nothing
  else.
- ✅ **Declare every host** a hook calls in `w6w.network.allow`. Undeclared egress is blocked.
  (OAuth endpoint hosts are allowed implicitly.) Entries are exact hostnames; two wildcard forms
  cover APIs addressed by a per-tenant host a manifest cannot enumerate — `"*.zendesk.com"` matches
  any subdomain at any depth (**not** the apex), and `"*"` disables egress restriction entirely and
  is only appropriate when the endpoint is a user-supplied URL (a self-hosted install). Prefer the
  narrowest form that works.
- ❌ **Never put credentials in an Action.** No `Authorization` headers in `execute`; let `sign`
  inject them. Actions cannot read the credential and must not try.
- ✅ **`sign` is credential-only and network-less** — mutate `request` and return it; don't call
  `ctx.fetch` from `sign`.
- ✅ **Mark `perform` actions `idempotent` honestly.** Use `ctx.invocation.invocationId` as the
  idempotency key when calling the service.
- ✅ **Keep hooks pure of ambient state** — no module-level mutable singletons; a hook may run in a
  fresh worker each call.

## Test, validate, run

Templates ship unit tests that call hooks with a **mocked `HookContext`** (a fake `ctx.fetch`, a
no-op `ctx.log`). Test the hook functions directly — no server needed.

```ts
// Deno template
const ctx = { fetch: fakeFetch, log: () => {} } as unknown as HookContext;
const out = await sendEmail.execute({
  to: "a@b.com",
  subject: "hi",
  body: "…",
  apiBase: "http://127.0.0.1:8080",
}, ctx);
assertEquals(out.status, 202);
```

Commands (from the template):

- `deno task test` / `npm test` — unit tests.
- `deno task validate` (the `@w6w/validator` CLI) — checks the manifest against spec rules.
- To run against the reference runtime: `loadApp(dir)` → `describe(app)` (public manifest, runs no
  untrusted code) →
  `invoke(app, { manifestVersion: "1", app: "<id>",
  action: "<key>", params: {…} })`. Needs
  `deno run --unstable-worker-options -A`.

## Health checks

An App may declare probes a host runs to answer "is this working?": vendor status, credential
liveness, quota headroom. `Auth.test` already covers the credential case and is derived into that
surface automatically, so **nothing is required of you today** — adding a `service` or `quota` check
is additive. See [`rfcs/healthcheck.md`](../rfcs/healthcheck.md).

Four things to know:

- **Probe an endpoint the narrowest usable credential can still reach.** A check that needs a scope
  the credential may legitimately lack reports a working App as broken. Prefer a dedicated ping
  (Mailchimp's `/3.0/ping`), else a whoami that needs no scope, else the cheapest read available.
- **Status hosts are not API hosts.** `status.stripe.com` is not `api.stripe.com`, and must not be
  added to `w6w.network.allow` to satisfy a probe — a check gets its own per-hook allowlist via
  `network.allow`, honoured only for an unsigned posture.
- **Say so when a vendor publishes nothing.** An entry with `unavailable: { reason }` and no hook is
  a first-class answer, and a better one than a silent gap. Give it `severity: "informational"`, or
  the permanent `unknown` it reports will pin your App's verdict there forever.
- **Declare a status feed; don't parse one.** If the vendor publishes Atom or RSS, name it with
  `feed` and the host fetches and parses it for you:

  ```ts
  const service: HealthCheckDefinition = {
    key: "service",
    title: "Platform status",
    kind: "service",
    feed: { url: "https://status.example.com/feed.rss" }, // host fetches + parses

    check({ feed }, _ctx) {
      if (feed?.error) return { state: "unknown", message: feed.error };
      const open = feed!.latest.filter((e) => !/^status:\s*resolved/i.test(e.summary));
      return open.length === 0
        ? { state: "ok" }
        : { state: "degraded", message: open.map((e) => e.title).join("; ") };
    },
  };
  ```

  Read `latest`, not `entries`. **A feed is a log of updates, not a statement of current state**:
  most vendors emit one entry per _update_, so the newest entry for a resolved incident still
  carries that incident's original title, and judging by it reports an outage that ended days ago.
  `latest` is the host's fold to one entry per incident. The feed's host is allowlisted implicitly,
  so do not restate it in `network.allow`.

## Triggers

Apps declare `triggers` (what _starts_ a workflow) via `TriggerDefinition`. A trigger is one of two
forms, and the loader derives which (`type`) from the hooks you declare:

- **Webhook** — `onSubscribe` registers with the third party (it receives the `callbackUrl` to hand
  over) and `onUnsubscribe` destroys that registration. They MUST pair: the loader rejects
  `onSubscribe` without `onUnsubscribe` (`invalid_trigger`). The optional `handleIngest` turns the
  whole inbound call (`{ method, path, query, headers, body }`) into 0..N events; without it the
  body is the event. A trigger with no hooks is a plain receiver.
- **Poll** — `poll({ params, state, subscriptionId }, ctx)` returns `{ events, nextState? }` and the
  host calls it on an interval (`minIntervalMs` is your floor; the host may set a higher one).
  Dedupe from your own cursor in `state`. A poll trigger MUST NOT declare `onSubscribe`.

Either form may add `parseOutput`, which reshapes a stored event into the run's `trigger.event`.
That is five hooks in all: `onSubscribe`, `onUnsubscribe`, `handleIngest`, `poll`, `parseOutput`.

**Ship triggers.** When the vendor exposes events (webhooks) or a newest-first list, the app ships
triggers; the only exception is a vendor with neither, and then the README records why. Read
[`rfcs/trigger.md`](../rfcs/trigger.md) first. (The starter templates carry no trigger; add yours.)

- **Poll** — use the poll kit at `apps/_shared/poll/mod.ts`: `pollFromListAction` turns an existing
  list/search action into a `New <record>` trigger, `pollSnapshot` diffs a table-like source
  (added/updated/removed), and `pollToken` follows a vendor change token or cursor. They own the
  versioned cursor `state`, first-check seeding (no events on the first tick) and dedupe.
- **Webhook** — use the webhook kit at `apps/_shared/webhook/` (signature verification) and mirror
  the `eventbrite` app's `lib/triggers.ts`. Never accept unsigned payloads from a vendor that signs.

## Definition-of-done checklist

- [ ] Started from a template ([deno](https://github.com/w6w-io/w6w-app-template-deno) or
      [node](https://github.com/w6w-io/w6w-app-template-node)).
- [ ] `package.json` `w6w` block: reverse-DNS `id`, `displayName`, `appearance.icon`, 1–3
      `categories`, `network.allow` lists every host the hooks call.
- [ ] `index.ts` default-exports `{ actions, auth }` satisfying `AppDefinition`.
- [ ] Every action: unique kebab-case `key`, correct `type`, typed `params`/`output`, uses
      `ctx.fetch`, no credentials.
- [ ] Auth (if any): `test` present; `sign` injects the credential; secret fields use
      `type: "secret"`.
- [ ] Refreshable auth (OAuth2, or any auth with a `refresh` hook): refresh-token lifetime
      (auth-level `refreshTokenTtlSeconds`, sliding vs absolute) checked in the vendor docs,
      `accessTokenTtlSeconds` set if new tokens state no expiry, and no `refresh` hook on an OAuth2
      auth unless the vendor's refresh is non-standard.
- [ ] Unit tests pass (`deno task test` / `npm test`) and the manifest validates
      (`deno task validate`).
- [ ] Imports keep `.ts` extensions.
- [ ] Triggers shipped, or the reason recorded in the README.

## Reference

- Templates: [w6w-app-template-node](https://github.com/w6w-io/w6w-app-template-node) ·
  [w6w-app-template-deno](https://github.com/w6w-io/w6w-app-template-deno)
- Types: [`@w6w/types`](../packages/types/) · Runtime: [`@w6w/runtime`](../packages/runtime/)
- RFCs: [app](../rfcs/app.md) · [action](../rfcs/action.md) · [auth](../rfcs/auth.md) ·
  [param](../rfcs/param.md) · [connection](../rfcs/connection.md) ·
  [invocation](../rfcs/invocation.md) · [hook-runtime](../rfcs/hook-runtime.md) ·
  [credential](../rfcs/credential.md) · [categories](../rfcs/categories.md) ·
  [trigger](../rfcs/trigger.md)
- Working examples: [`fixtures/apps/hello`](../fixtures/apps/hello/) (no-auth) ·
  [`fixtures/apps/sendgrid`](../fixtures/apps/sendgrid/) (apiKey + sign) ·
  [`fixtures/apps/service-account`](../fixtures/apps/service-account/) (serviceAccount + derived
  token)
