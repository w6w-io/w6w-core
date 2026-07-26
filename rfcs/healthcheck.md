# RFC: Health Check

**Status:** Draft
**Author:** Segev Shmueli
**Date:** 2026-07-26

## Summary

A **Health Check** is a declared, side-effect-free probe an App publishes so a host can
answer "is this working?" without guessing. This RFC makes health a first-class part of an
App's manifest: an App declares zero or more checks, each tagged with what it tells you
(`kind`), what it is about (`scope`), and which parts of the App it speaks for (`covers`).
A single check may report several components at once, so one call to a vendor's status API
can light up `api`, `webhooks` and `dashboard` independently.

It supersedes nothing. `Auth.test` keeps its contract and is *reframed* as an
automatically-derived credential check, so every App that exists today gains a health
surface without changing a line.

## Motivation

Three different questions get conflated today, and only one of them is modelled:

| Question | Modelled today | Where the answer actually lives |
|---|---|---|
| Is the vendor up? | ❌ nothing | An out-of-band status service, on a host the App is not allowed to call |
| Is this credential live? | ✅ `Auth.test` | Per auth method |
| Do we have quota left? | ❌ nothing | Usually response headers; occasionally an endpoint |

Two concrete failures follow from that gap.

**Hosts invent a probe, badly.** With no declared check beyond `Auth.test`, a host that
wants to verify a Connection reaches for a heuristic. The reference host currently picks
*the first `read` Action with no required params* and invokes it with `{}`. That is
arbitrary — it depends on array order in `index.ts` — and it is wrong in both directions:
for 9 of the 35 first-party Apps no such Action exists, so the check silently passes
without testing anything; and where one does exist it may be an expensive listing, or one
that needs a scope the credential legitimately lacks. An App scoped to deals but not
contacts should not be reported broken because the probe happened to read contacts.

**Health is not one bit.** A survey of 35 first-party integrations found the real shape is
plural:

- **Stripe** publishes `api`, `webhooks`, `dashboard` and `checkout` separately — the API
  can be healthy while webhooks are degraded, and a single boolean erases exactly the
  distinction an operator needs.
- **GitHub**'s `/rate_limit` returns five independent buckets (`core`, `search`, `graphql`,
  …) in one response.
- **Salesforce** reports status per *instance*, not per platform, and its `/limits` call
  answers "is the credential live" and "is there quota" simultaneously.
- **Jira**'s two auth methods must probe *different hosts*, because an OAuth connection has
  no site URL until its token resolves one.
- **Telegram** publishes no status service at all, so an App must be able to declare that
  honestly rather than fake a check.

A model that cannot express "one probe, many components" or "many probes, different
scopes" cannot describe any of these.

## Goals

- An App can declare **any number** of health checks, each independently addressable.
- A check states **what it covers** — the whole App, a named component, a set of Actions,
  or one endpoint — so a host can attribute a failure precisely.
- A **single check may report several components**, because that is how vendor status APIs
  are actually shaped.
- Checks that need no credential run **once per App**, not once per Connection.
- `Auth.test` keeps working unchanged and appears in the same uniform list.
- A host has a defined algorithm for **rolling many checks up** into one verdict.
- An App can declare that **no check exists** for something, and have that be a first-class
  answer rather than an omission.

## Non-Goals

- **Deciding cadence.** How often a host runs a check is host policy, as it already is for
  `Auth.test` (see [`auth.md`](./auth.md)). This RFC supplies hints, not a schedule.
- **Storing or alerting on history.** Time series, incident correlation and paging are host
  concerns.
- **Gating execution.** Whether a degraded check blocks a run is left as an open question;
  the default in this RFC is advisory.
- **Replacing `Auth.test`.** It stays required and keeps its contract.
- **Uptime measurement.** A check reports what it observes right now; synthesizing
  availability from that is the host's business.

## Concept

A health check is an ordinary hook — same sandbox, same `ctx.fetch`, same credential
isolation as an Action (see [`hook-runtime.md`](./hook-runtime.md)). What makes it a health
check is the metadata around it, along three orthogonal axes.

### The three axes

**`kind` — what the answer tells you.**

| `kind` | Answers | Typically needs a credential |
|---|---|---|
| `service` | Is the vendor's platform up? | no |
| `credential` | Is this stored credential live? | yes |
| `quota` | Is there headroom left before throttling? | yes |
| `dependency` | Is a thing this App depends on reachable? (a tenant's own host, a self-hosted install) | varies |

**`scope` — what the answer is about.**

| `scope` | Meaning | Host behaviour |
|---|---|---|
| `app` | True for every user of this App | Run once; **share the result** across all Connections |
| `connection` | True only for one stored credential | Run per Connection |

The distinction is load-bearing. A vendor status check is `scope: "app"`: running it per
Connection would multiply one useful call by the number of users, which is both wasteful
and a good way to get rate-limited by a status page.

**`covers` — what the answer speaks for.** A list of selectors binding the check to the
surface it validates, so a host can attribute a failure rather than greying out the whole
App:

- `"*"` — the entire App (the default).
- `"action:<key>"` — one Action.
- `"resource:<name>"` — every Action sharing that `resource`.
- `"auth:<key>"` — one auth method.
- `"component:<id>"` — a vendor-named component the check reports on.

### One probe, many components

A check returns a **report**, not a boolean. The report carries an overall `state` and,
optionally, a `components` map. This is what lets one call to Stripe's status API light up
four components, or one call to GitHub's `/rate_limit` report five quota buckets — without
declaring four or five separate checks that would each cost a request.

The rule is: **declare a check per *call* you must make; report a component per *thing* that
call tells you about.**

### Derived checks

Every `Auth.test` hook is projected into the health surface as a check with:

```
key    = "auth:<authMethodKey>"
kind   = "credential"
scope  = "connection"
covers = ["auth:<authMethodKey>"]
```

No App changes. An App that wants richer credential reporting may declare its own
`kind: "credential"` check, which supplements rather than replaces the derived one.

### Promoting an Action

Some Actions are already the right probe — Salesforce's `limits-get` reads the org's quota
and is useful both as a workflow step and as a health check. Rather than duplicate it, an
Action may be **tagged** with a `healthCheck` block; the loader projects it into
`healthChecks` at load time. A tagged Action MUST be safe to invoke with `{}`: `type` is
`read`, and no param is `required` without a `default`. Validators reject a tag that
violates this, because the whole point is that a host can call it unattended.

### Declaring absence

`healthChecks` may contain an entry with `unavailable` set and no `check` hook. That states
"this vendor publishes nothing for this" as a positive fact — Telegram runs no status
service, and an App should be able to say so rather than leave a host to conclude the
publisher forgot.

## Shape

```jsonc
{
  "healthChecks": [
    {
      "key": "service",
      "title": "Stripe platform status",
      "kind": "service",
      "scope": "app",                        // one call serves every connection
      "covers": ["*"],
      "network": { "allow": ["status.stripe.com"] },   // widened for THIS hook only
      "minIntervalSeconds": 60,
      "severity": "degraded",
      "check": "./health/service.ts"
    },
    {
      "key": "quota",
      "title": "API quota",
      "kind": "quota",
      "scope": "connection",
      "covers": ["*"],
      "minIntervalSeconds": 300,
      "severity": "informational",
      "check": "./health/quota.ts"
    }
  ]
}
```

In the code-first authoring model the `check` value is the hook function itself, exactly as
`execute` is on an Action:

```ts
const serviceHealth: HealthCheckDefinition = {
  key: "service",
  title: "Stripe platform status",
  kind: "service",
  scope: "app",
  network: { allow: ["status.stripe.com"] },
  minIntervalSeconds: 60,

  async check(_input, ctx) {
    const res = await ctx.fetch("https://status.stripe.com/current");
    if (!res.ok) return { state: "unknown", message: `status API returned ${res.status}` };
    const body = await res.json() as {
      largestatus: string;
      statuses: Record<string, string>;
    };
    // One call, four components — the API can be up while webhooks are degraded.
    const map = (v: string) => v === "up" ? "ok" : v === "down" ? "down" : "degraded";
    return {
      state: map(body.largestatus),
      components: Object.fromEntries(
        Object.entries(body.statuses).map(([id, v]) => [id, { state: map(v) }]),
      ),
      ttlSeconds: 60,
    };
  },
};
```

### Field reference — `HealthCheck`

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✅ | Machine name, unique within the App. Lowercase kebab-case, or the reserved derived form `auth:<key>`. |
| `title` | string | ✅ | Human label for a status UI. |
| `description` | string | ⬜ | What it probes and why that endpoint was chosen. |
| `kind` | enum | ✅ | `service` \| `credential` \| `quota` \| `dependency`. |
| `scope` | enum | ⬜ | `app` \| `connection`. Defaults to `app` for `service`, `connection` otherwise. |
| `covers` | string[] | ⬜ | Selectors this check speaks for. Defaults to `["*"]`. |
| `requiresAuth` | boolean | ⬜ | Defaults to `false` when `scope` is `app`, `true` otherwise. |
| `network` | object | ⬜ | `{ allow: string[] }` — hosts this check may reach, **in addition to** the App's allowlist and **only** inside this hook's worker. |
| `minIntervalSeconds` | number | ⬜ | Publisher's floor on how often a host should run it. A host MUST NOT run it more often. |
| `severity` | enum | ⬜ | `fatal` \| `degraded` \| `informational`. Defaults to `fatal` for `credential`, `degraded` otherwise. |
| `unavailable` | object | ⬜ | `{ reason: string }`. Declares that no check exists. Mutually exclusive with `check`. |
| `check` | hook | ✅¹ | The probe. ¹Required unless `unavailable` is set. |

### Field reference — `HealthReport` (the hook's return)

| Field | Type | Required | Description |
|---|---|---|---|
| `state` | enum | ✅ | `ok` \| `degraded` \| `down` \| `unknown`. |
| `message` | string | ⬜ | Human explanation. Shown verbatim; MUST NOT contain credential material. |
| `components` | object | ⬜ | Map of component id → `{ state, message? }`. Lets one probe report many things. |
| `quota` | array | ⬜ | `{ id?, limit?, remaining?, resetAt?, unit? }[]`. Populated by `kind: "quota"` checks. |
| `ttlSeconds` | number | ⬜ | How long the host may serve this result from cache. |
| `latencyMs` | number | ⬜ | Host-stamped if the hook omits it. |

`unknown` is deliberately distinct from `down`: a status API that itself 500s tells you
nothing about the vendor, and reporting that as an outage would be a lie.

## Roll-up algorithm

A host that needs a single verdict for a target (an App, a Connection, an Action) MUST:

1. Select every check whose `covers` matches the target, plus every derived `auth:*` check
   when the target is a Connection.
2. Discard results older than their `ttlSeconds`, treating them as `unknown`.
3. Map each result through its `severity`:
   - `fatal` — a `down` result makes the target `down`.
   - `degraded` — a `down` or `degraded` result makes the target at worst `degraded`.
   - `informational` — never worsens the verdict; carried for display only.
4. Take the worst surviving state, ordering `ok` < `unknown` < `degraded` < `down`.
5. Attribute the verdict to the specific check keys that produced it, so a UI can say
   *which* thing is broken.

`unknown` ranks above `ok` so an unverifiable target is never presented as healthy, and
below `degraded` so a broken status page never masquerades as a vendor outage.

## Egress

Status endpoints live on hosts an App has no business calling from an Action —
`status.stripe.com` is not `api.stripe.com`. Adding them to `w6w.network.allow` would widen
egress for *all* the App's code to satisfy one hook.

A health check therefore carries its own `network.allow`, and the host composes the
allowlist per worker:

| Hook | Allowlist |
|---|---|
| Action `execute`, Trigger hooks | `w6w.network.allow` + OAuth endpoint hosts |
| Health `check` | the above **+** that check's own `network.allow` |

This follows the precedent already set for OAuth endpoint hosts, which are allowed
implicitly rather than restated by every publisher. The narrowing is the point: a status
host becomes reachable by the one hook that needs it and by nothing else.

## Conformance

A host claiming support MUST:

1. **Not invent a probe.** A host MUST NOT synthesize a health check by selecting an
   arbitrary Action. If an App declares no check of the required `kind`, the host reports
   `unknown` with a reason — never `ok`.
2. **Honour `scope`.** A `scope: "app"` check is executed once and its result shared across
   Connections of that App.
3. **Honour `minIntervalSeconds`** as a floor, and `ttlSeconds` as a cache lifetime.
4. **Expose every check** — declared, derived and `unavailable` — through `describe()`, so a
   UI can render what is and is not knowable.
5. **Isolate credentials** exactly as for Actions: a `check` hook reaches the network only
   through `ctx.fetch`, and never receives the raw credential — `sign` still injects it.
6. **Never worsen a verdict on an `informational` check.**

Fixtures: `fixtures/apps/*/health/` and the conformance cases under
`packages/validator/tests/fixtures/{valid,invalid}/health/`.

## Migration

Staged, and non-breaking at every step.

| Step | Change | Breaks anything? |
|---|---|---|
| 1 | Add the types; derive `auth:*` checks from existing `Auth.test` hooks | No — every App gains a credential check for free |
| 2 | Host replaces its arbitrary-Action probe with the derived checks | No — strictly more correct |
| 3 | Publishers add `kind: "service"` / `"quota"` checks where the vendor supports one | No — additive |
| 4 | Validator warns when an App declares neither a check nor `unavailable` for `service` | Warning only |

The 35 first-party Apps already carry the research this needs: each documents its vendor
status endpoint, its credential probe and its quota mechanism, so step 3 is transcription
rather than discovery.

## Open questions

1. **Should a `fatal` check gate execution?** The default here is advisory — a `down`
   credential check marks the Connection broken (as `Auth.test` failure already does) but
   does not pre-empt a run. A `gate: true` opt-in would let a publisher say "do not even
   try". Risk: a flaky status page blocks working traffic.
2. **Are `covers` selectors enough?** `action:` / `resource:` / `auth:` / `component:` cover
   the observed cases, but per-*region* health (Salesforce instances, Zendesk pods) is a
   Connection attribute, not an Action one. Possibly a `region:` selector, or leave it to
   `components`.
3. **Should `quota` be a `kind` at all,** or a field every check may populate? Salesforce's
   `/limits` is genuinely both, and today it would be declared twice or arbitrarily typed.
4. **Who owns the status-host allowlist?** Per-check `network.allow` is proposed here. The
   alternative is a host-side registry of known status hosts, which centralises trust but
   makes the App less self-describing.
5. **Cadence for `scope: "app"` checks across tenants** — one result per App globally, or
   per tenant? Globally is cheaper; per tenant matters if a host proxies egress differently
   per tenant.

## Status ladder

Use the project-wide ladder:

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze.
- `Final` — frozen for the current `manifestVersion`. Breaking changes require a new RFC and
  a `manifestVersion` bump.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.
