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
5. **Credentials are opaque.** Actions never see raw credentials. The Auth **`sign`** hook is the
   _only_ code handed the credential, and it runs in its own network-less worker — so the
   credential-holder can't reach the network and the network-caller has no credential. Neither can
   leak it.

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
  type: "apiKey", // oauth2 | apiKey | basic | bearer | custom | tenantAuth | jit
  displayName: "API Key",
  apiKey: { in: "header", name: "Authorization", prefix: "Bearer " },
  fields: [ // collected at connect time; Param[]
    { key: "apiKey", label: "API Key", type: "secret", required: true },
  ],

  // The ONLY hook given the raw credential. Runs network-less: it stamps auth onto
  // the request and returns it, but cannot itself reach the network.
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
opaque credential) → `test` → `afterConnect` (fetch label data) → `sign` (per request) → `refresh`
(renew expired credential) → `revoke` (on disconnect). For OAuth2, set `type: "oauth2"` and the
`oauth2` config (`authorizationUrl`, `tokenUrl`, `scopes`, `pkce`); see
[`rfcs/auth.md`](../rfcs/auth.md).

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

An App may declare probes a host runs to answer "is this working?": vendor status,
credential liveness, quota headroom. `Auth.test` already covers the credential case and is
derived into that surface automatically, so **nothing is required of you today** — adding a
`service` or `quota` check is additive. See [`rfcs/healthcheck.md`](../rfcs/healthcheck.md).

Four things to know:

- **Probe an endpoint the narrowest usable credential can still reach.** A check that needs
  a scope the credential may legitimately lack reports a working App as broken. Prefer a
  dedicated ping (Mailchimp's `/3.0/ping`), else a whoami that needs no scope, else the
  cheapest read available.
- **Status hosts are not API hosts.** `status.stripe.com` is not `api.stripe.com`, and must
  not be added to `w6w.network.allow` to satisfy a probe — a check gets its own per-hook
  allowlist via `network.allow`, honoured only for an unsigned posture.
- **Say so when a vendor publishes nothing.** An entry with `unavailable: { reason }` and no
  hook is a first-class answer, and a better one than a silent gap. Give it
  `severity: "informational"`, or the permanent `unknown` it reports will pin your App's
  verdict there forever.
- **Declare a status feed; don't parse one.** If the vendor publishes Atom or RSS, name it
  with `feed` and the host fetches and parses it for you:

  ```ts
  const service: HealthCheckDefinition = {
    key: "service",
    title: "Platform status",
    kind: "service",
    feed: { url: "https://status.example.com/feed.rss" },   // host fetches + parses

    check({ feed }, _ctx) {
      if (feed?.error) return { state: "unknown", message: feed.error };
      const open = feed!.latest.filter((e) => !/^status:\s*resolved/i.test(e.summary));
      return open.length === 0
        ? { state: "ok" }
        : { state: "degraded", message: open.map((e) => e.title).join("; ") };
    },
  };
  ```

  Read `latest`, not `entries`. **A feed is a log of updates, not a statement of current
  state**: most vendors emit one entry per *update*, so the newest entry for a resolved
  incident still carries that incident's original title, and judging by it reports an
  outage that ended days ago. `latest` is the host's fold to one entry per incident.
  The feed's host is allowlisted implicitly, so do not restate it in `network.allow`.

## Triggers (advanced / optional)

Apps may also declare `triggers` (what _starts_ a workflow) via `TriggerDefinition` with
`onSubscribe` / `onUnsubscribe` / `handleIngest` hooks. The starter templates do **not** include
triggers; add them only when asked, and read [`rfcs/trigger.md`](../rfcs/trigger.md) first.

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
- [ ] Unit tests pass (`deno task test` / `npm test`) and the manifest validates
      (`deno task validate`).
- [ ] Imports keep `.ts` extensions.

## Reference

- Templates: [w6w-app-template-node](https://github.com/w6w-io/w6w-app-template-node) ·
  [w6w-app-template-deno](https://github.com/w6w-io/w6w-app-template-deno)
- Types: [`@w6w/types`](../packages/types/) · Runtime: [`@w6w/runtime`](../packages/runtime/)
- RFCs: [app](../rfcs/app.md) · [action](../rfcs/action.md) · [auth](../rfcs/auth.md) ·
  [param](../rfcs/param.md) · [connection](../rfcs/connection.md) ·
  [invocation](../rfcs/invocation.md) · [hook-runtime](../rfcs/hook-runtime.md) ·
  [categories](../rfcs/categories.md) · [trigger](../rfcs/trigger.md)
- Working examples: [`fixtures/apps/hello`](../fixtures/apps/hello/) (no-auth) ·
  [`fixtures/apps/sendgrid`](../fixtures/apps/sendgrid/) (apiKey + sign)
