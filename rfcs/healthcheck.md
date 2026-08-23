# RFC: Health Check

**Status:** Draft — reference implementation landed
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
- A check states **what credential it needs** — none, the Connection's metadata, or the
  credential itself — because those are three different postures, not two.
- Checks that need no Connection at all run **once per App**, and can report before anyone
  has connected.
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
check is the metadata around it, along three orthogonal axes — plus a fourth property,
its credential posture, which is deliberately not folded into any of them.

### The three axes

**`kind` — what the answer tells you.**

| `kind` | Answers | Usual `credential` posture |
|---|---|---|
| `service` | Is the vendor's platform up? | `none` |
| `credential` | Is this stored credential live? | `signed` |
| `quota` | Is there headroom left before throttling? | `signed` |
| `dependency` | Is a thing this App depends on reachable? (a tenant's own host, a self-hosted install) | `context` |

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

### Credential posture

Whether a check needs a credential is **not** the same question as whether it is
per-Connection, and collapsing them into one boolean loses a case that several Apps in this
pack actually have. Three postures, not two:

| `credential` | Connection required | `ctx.connection` | `sign` runs | Use for |
|---|---|---|---|---|
| `none` | no | absent | **no** | Vendor status pages, unauthenticated API pings (`slack.com/api/api.test`, `api.github.com/rate_limit`) |
| `context` | yes | redacted (display only) | **no** | "Is this tenant's host reachable at all" — the Connection supplies the URL, not a credential |
| `signed` | yes | redacted | yes | Credential liveness, quota — anything that needs the credential on the wire |

`context` is the one a boolean would lose. Every App addressed by a per-tenant host —
Zendesk (`acme.zendesk.com`), Shopify (`acme.myshopify.com`), Salesforce (per-org instance),
Jira (per-site), and self-hosted WordPress — has a failure mode that is *not* a credential
failure: the site is gone, DNS is wrong, the REST API has been disabled by a plugin. That
probe needs the Connection's `display` data to know what URL to call, and needs no
credential to interpret the answer. WordPress makes it explicit: `GET /wp-json/` is
unauthenticated and tells you the REST API is alive, while `GET /wp-json/wp/v2/users/me`
requires auth — two genuinely different failures that a host should be able to tell apart.

Because a `none` check needs no Connection at all, a host can render vendor status **before
anyone has connected**, and for an App with no Connections at all.

Note that `scope` and `credential` are independent: `none` + `connection` is exactly the
`context` case, and `signed` + `app` is possible for an App whose credential is
host-supplied (`tenantAuth`). The defaults are conveniences, not a coupling.

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

### Feed-backed checks

Plenty of vendors publish an Atom or RSS status feed instead of — or alongside — a JSON
status API. A check may **declare** one with `feed`, and the host fetches and parses it
*before* running the hook, handing the entries over as `input.feed`:

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

The split is deliberate, and it is the whole reason this is declarative rather than
something each publisher writes by hand: **parsing Atom/RSS is generic and identical for
every publisher; interpreting what an entry means is vendor-specific.** So the host does
the part that is the same everywhere, and the App does the part only it knows. A publisher
never reimplements a feed reader, and therefore never reimplements one subtly wrong.

#### A feed is a log of updates, not a statement of current state

This is the trap the shape exists to prevent, and it is not hypothetical. Mistral's status
feed carries **50 entries describing 26 incidents**: every update to an incident is its own
entry, and the newest entry for a *resolved* incident still carries the incident's original
title.

```xml
<title><![CDATA[Audio API Degraded]]></title>          <!-- still the title … -->
<description><![CDATA[Status: Resolved<br/>…]]></description>   <!-- … but it is fixed -->
```

A check that reads the newest entry's title reports an outage that ended days ago. So the
host supplies both projections and names them so the difference is hard to miss:

- **`entries`** — every entry, newest first, capped at `limit`.
- **`latest`** — the newest entry *per `id`*, i.e. successive updates folded onto the
  incident they describe. This is almost always the one a check wants.

Interpretation still belongs to the App, because only it knows the vendor's vocabulary.
Where a vendor writes a machine-readable status (Mistral prefixes every update body with
`Status: Resolved` / `Status: Investigating`), read it; guessing from prose when a real
field exists is inexcusable. Where a vendor offers nothing like it, report `unknown` rather
than inventing a state.

#### Egress and posture

A feed lives on a status host, which is exactly the kind of host that must never see a
credential. So `feed` carries the same binding as `network.allow`:

> A check declaring `feed` MUST have `credential` of `none` or `context` — never `signed`.
> Validators MUST reject the combination, and a host MUST fetch the feed unsigned.

The feed's host is added to that hook's allowlist **implicitly**, on the same footing as
OAuth endpoint hosts: the URL already says where it is, and making a publisher restate it
in `network.allow` would be redundant bookkeeping that a publisher can only get wrong.

`feed` and `unavailable` are mutually exclusive — an absence has no hook to hand entries to.

#### Choosing Atom over RSS

Where a vendor serves both (Slack publishes `/feed/atom` and `/feed/rss` with identical
content), prefer Atom: its `<updated>` says when an entry last *changed*, where RSS's
`<pubDate>` conflates that with first publication — and "changed lately" is usually the
question. `format` defaults to `auto`, which sniffs the payload rather than trusting the
URL or content-type, because status hosts serve both from paths that do not say which.

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

A `context` check, on an App whose host comes from the Connection:

```ts
const siteReachable: HealthCheckDefinition = {
  key: "site",
  title: "Site reachable",
  kind: "dependency",
  scope: "connection",     // the URL is per-Connection …
  credential: "context",   // … but no credential is needed to ask
  covers: ["*"],
  minIntervalSeconds: 120,

  async check(_input, ctx) {
    // `display` is redacted Connection metadata — never the credential.
    const { siteUrl } = (ctx.connection?.display ?? {}) as { siteUrl?: string };
    if (!siteUrl) return { state: "unknown", message: "connection records no site URL" };

    // Unauthenticated discovery document: proves the site is up AND that the
    // REST API is enabled, which is a different failure from a bad credential.
    const res = await ctx.fetch(`${siteUrl}/wp-json/`);
    if (res.status === 404) {
      return { state: "down", message: "REST API disabled or blocked by a plugin" };
    }
    return res.ok
      ? { state: "ok", ttlSeconds: 120 }
      : { state: "down", message: `site returned ${res.status}` };
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
| `credential` | enum | ⬜ | `none` \| `context` \| `signed`. See [Credential posture](#credential-posture). Defaults to `none` for `service`, `signed` otherwise. |
| `network` | object | ⬜ | `{ allow: string[] }` — hosts this check may reach, **in addition to** the App's allowlist and **only** inside this hook's worker. |
| `feed` | object | ⬜ | `{ url, format?, limit? }` — an Atom/RSS status feed the host fetches and parses before the hook runs, delivered as `input.feed`. Same unsigned-posture binding as `network`; the feed's host is allowed implicitly. See [Feed-backed checks](#feed-backed-checks). |
| `minIntervalSeconds` | number | ⬜ | Publisher's floor on how often a host should run it. A host MUST NOT run it more often. |
| `severity` | enum | ⬜ | `fatal` \| `degraded` \| `informational`. Defaults to `fatal` for `credential`, `degraded` otherwise. |
| `unavailable` | object | ⬜ | `{ reason: string }`. Declares that no check exists. Mutually exclusive with `check`. |
| `check` | hook | ✅¹ | The probe. ¹Required unless `unavailable` is set. |

### Field reference — `input.feed` (present only for a feed-backed check)

| Field | Type | Description |
|---|---|---|
| `entries` | `HealthFeedEntry[]` | Every entry, newest first, capped at `limit` (default 50). |
| `latest` | `HealthFeedEntry[]` | Newest entry **per `id`** — updates folded onto their incident. Usually the one to read. |
| `fetchedAt` | string | ISO 8601, host-stamped. |
| `error` | string | Set when the feed could not be read; both arrays are then empty. Report `unknown`. A fixed, end-user sentence — never the underlying transport reason, since the pattern above renders it verbatim. |

A `HealthFeedEntry` is `{ id?, title, summary, summaryHtml, link?, publishedAt? }`, normalised
across Atom and RSS. `summary` is plain text; `summaryHtml` keeps markup for when the markup
carries meaning (a vendor listing affected components as an `<li>` list). `publishedAt` is an
ISO string, not a `Date` — the value crosses the sandbox boundary.

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

### Extra hosts are never signed

Widening the allowlist without constraining signing would be a credential-exfiltration
path: a check could declare `network.allow: ["collector.example"]`, and a host that signs
health requests the way it signs Action requests would hand that third party the user's
credential. Third-party status hosts are exactly the hosts that must never see one.

So the two are bound together:

> A check that declares its own `network.allow` MUST have `credential` of `none` or
> `context` — never `signed`. Validators MUST reject the combination, and a host MUST NOT
> run `sign` for any request a health check makes to a host outside
> `w6w.network.allow`.

This costs nothing in practice. The observed cases that need an extra host are all vendor
status pages, which are unauthenticated by design; the ones that need a credential
(GitHub's `/rate_limit`, Salesforce's `/limits`) are on the App's own API host and are
already covered by `w6w.network.allow`.

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
   through `ctx.fetch` and never receives the raw credential.
6. **Honour `credential`.** A host MUST NOT run `sign` for a check declared `none` or
   `context`, MUST NOT supply `ctx.connection` to a `none` check, and MUST reject at load
   time any check that pairs its own `network.allow` with `credential: "signed"`.
7. **Never worsen a verdict on an `informational` check.**
8. **Fetch a declared `feed` itself**, unsigned, before invoking the hook, and deliver both
   projections (`entries` and `latest`). A fetch or parse failure MUST become
   `input.feed.error` rather than an exception, so the check can report `unknown`.
9. **Never put its own internals in `message`.** A host generates a `message` in exactly the
   cases where the App could not: the probe threw, timed out, or returned something
   unrecognised. Because `message` is rendered verbatim (see the field reference), whatever the
   host writes there MUST be prose written for an end user — never a transport error, a
   certificate mismatch, a stack, a URL, or a status code. Those are real and belong in the
   host's log, not on a status pill: a broken status page must not read like a broken product.
   The same rule binds `input.feed.error`, which a conforming check echoes into `message`.

Fixtures: [`fixtures/apps/sendgrid/health/`](../fixtures/apps/sendgrid/health/) declares one
check of each credential posture plus an `unavailable`; the conformance cases live under
[`packages/validator/tests/fixtures/{valid,invalid}/health/`](../packages/validator/tests/fixtures/).

### Reference implementation

| Piece | Where |
|---|---|
| Types (`HealthCheck`, `HealthReport`, postures, default resolution) | [`@w6w/types`](../packages/types/src/health.ts) |
| Spec rules, incl. the unsigned-egress rule and the tagged-Action rule | [`@w6w/validator`](../packages/validator/src/validate.ts) |
| Loading, `auth:*` derivation, per-check allowlist composition | [`runtime/src/loader.ts`](../packages/runtime/src/loader.ts) |
| `checkHealth()`, posture enforcement, `rollUpHealth()` | [`runtime/src/health.ts`](../packages/runtime/src/health.ts) |
| Atom/RSS parsing, `latestPerId` fold | [`runtime/src/feed.ts`](../packages/runtime/src/feed.ts) |
| `describe()` exposure, sandbox selector | [`runtime/src/runtime.ts`](../packages/runtime/src/runtime.ts), [`sandbox/`](../packages/runtime/src/sandbox/) |

The posture rules are enforced in two places on purpose. The validator rejects a `signed`
check that widens its egress at author time; `healthAllowlist()` refuses to widen it at load
time regardless. An app that skipped validation still cannot leak a credential to a host
outside its own allowlist.

## Migration

Staged, and non-breaking at every step.

| Step | Change | Breaks anything? |
|---|---|---|
| 1 | Add the types; derive `auth:*` checks from existing `Auth.test` hooks | No — every App gains a credential check for free. **Done** |
| 2 | Host replaces its arbitrary-Action probe with the derived checks | No — strictly more correct. **Pending** — the reference host still probes an arbitrary Action |
| 3 | Publishers add `kind: "service"` / `"quota"` checks where the vendor supports one | No — additive |
| 4 | Validator warns when an App declares neither a check nor `unavailable` for `service` | Warning only |
| 5 | Add `feed` so a vendor's Atom/RSS status feed is declared rather than hand-parsed per App | No — additive; a check without `feed` still receives `{}`. **Done** |

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
4. **Who owns the status-host allowlist?** Per-check `network.allow` is proposed here,
   bound to an unsigned posture so it cannot leak a credential. The alternative is a
   host-side registry of known status hosts, which centralises trust but makes the App less
   self-describing. The binding makes the per-check form safe; the question is now taste
   rather than safety.
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
