# RFC: Registry

**Status:** Draft **Author:** Segev Shmueli **Date:** 2026-06-30

## Summary

A **Registry** is the host-side service that knows _which apps a host has, at which versions, and
how to load them_. Where the App RFC describes a single unit of integration, this RFC describes the
**collection** — how a host stores, retrieves, versions, and serves those units to its runtime.

The registry is **transport-free and storage-free**: it owns the semantics (register, get, list,
load, lifecycle) and depends on an injected `DataStore` for persistence. A host (e.g. the w6w
server) supplies the data store; the registry library hands back a ready-to-use registry instance.

## Motivation

Every host that runs `@w6w/runtime` ends up reinventing the same four things: an "apps catalog"
table, an import pipeline (`resolve → loadApp → describe →
persist`), a "load it again at invoke
time" path, and a small set of lifecycle operations (deprecate, hide, retire). That logic doesn't
belong to the runtime (which only knows about _one_ `LoadedApp` at a time) and it doesn't belong to
the host (which would re-implement it per database). It belongs in its own primitive that:

- Is specified once and reused by every host (today: the w6w server; tomorrow: internal tools, OSS
  hosts, a hypothetical CLI).
- Pluggable on persistence — Postgres, SQLite, in-memory, JSON-on-disk, or a future federated
  upstream.
- First-class about **version history**, so a host can hold multiple versions of the same app and a
  workflow step can pin to one.
- Leaves room for **federation** (upstream pull, mirroring) without disturbing the local-host
  contract.

## Goals

- A logical `RegisteredApp` shape, format-agnostic like the App manifest.
- A `DataStore` contract with explicit atomicity guarantees.
- **Idempotent registration** keyed by a content digest — re-registering the same source is a no-op.
- **Versioned by default** — apps stored per `(id, version)` with a `latest` pointer per id.
- **Lifecycle overlay** — host policy (deprecate, hide) layered on top of the publisher's manifest
  claim.
- **Load is part of the registry** — `registry.load(id, {version?})` returns a `LoadedApp` ready for
  `@w6w/runtime.invoke`.
- **Federation reserved** — concept and field names baked in; mechanics deferred.

## Non-Goals

- Defining a wire format / HTTP API for the registry (a transport wrapper is a separate concern).
- Defining marketplace UX (discovery, ratings, install flows).
- Defining the federated pull / mirror protocol (reserved for a future RFC).
- Mandating any specific storage engine.

## Concept

A registry is a set of **registered apps**. Each registered app is a sequence of **app versions**,
each of which is one immutable, validated record produced by registering a source reference
(`file:`, `github:`, …) at a moment in time.

A registered app has, at any time, exactly one **latest** version — the one returned by an
unqualified `get(id)` or shown by `list()`. Older versions are preserved and reachable via
`getVersion(id, version)` / `listVersions(id)`.

Identity is the App's reverse-DNS `id`. Within an id, the manifest `version` (SemVer) is the version
key. Content identity is the registered version's `digest` — a sha-256 over the canonicalized
`{ manifest, actions, auth }` produced by `@w6w/runtime.describe()`. Two registrations with the same
digest are the same; the registry deduplicates.

```
                     ┌──────── Registry ─────────┐
register("hello") ─► │  apps["io.w6w.hello"]    │
                     │    ├─ versions:            │
                     │    │    ├─ 1.0.0  (digest X)
                     │    │    └─ 1.1.0  (digest Y)  ← latest
                     │    └─ overlay: { maturity: "deprecated" }
                     └────────────────────────────┘
```

## Shape

The registry surface is intentionally small. Below is a TypeScript rendering; the same logical
shapes map 1:1 to JSON or any other serialization.

### `RegisteredApp` — the public view of an id

```ts
interface RegisteredApp {
  /** The App's reverse-DNS id. */
  id: string;
  /** The version currently marked latest. */
  latest: AppVersion;
  /** Total versions stored for this id. */
  versionCount: number;
  /** Host-side lifecycle overrides (see Lifecycle). */
  overlay: LifecycleOverlay;
  /** Effective classification = overlay ?? manifest.classification. */
  effective: EffectiveClassification;
  /** When `id` was first registered. */
  registeredAt: string; // ISO-8601
  /** When any version under this id was last touched. */
  updatedAt: string; // ISO-8601
}
```

### `AppVersion` — one stored version

```ts
interface AppVersion {
  /** The App's reverse-DNS id. */
  id: string;
  /** The manifest's `version` field. SemVer. */
  version: string;
  /** Content digest: sha-256 of canonical({ manifest, actions, auth }). Hex. */
  digest: string;
  /** Source reference this version was registered from (e.g. file:..., github:owner/repo@ref). */
  sourceRef: string;
  /** Provenance of this version. */
  origin: Origin;
  /** The full manifest as returned by @w6w/runtime.describe(). */
  manifest: AppManifest;
  /** Action definitions exposed by this version. */
  actions: Action[];
  /** Auth methods declared by this version. */
  auth: Auth[];
  /** When this version was first written to the registry. */
  registeredAt: string; // ISO-8601
}
```

### `Origin` — where this version came from

```ts
type Origin =
  | { kind: "local" } // resolved + loaded by this registry (v1)
  | { kind: "federated"; upstream: string }; // reserved; not yet implemented
```

`"federated"` is **reserved** — registries MUST refuse to register an origin other than `"local"`
until the federation RFC lands.

### `LifecycleOverlay` — host policy on top of the manifest

```ts
interface LifecycleOverlay {
  maturity?: Maturity; // alpha | beta | stable | deprecated
  visibility?: Visibility; // private | unlisted | public
  successor?: string; // reverse-DNS id
}
```

The manifest's `classification` is the publisher's claim; the overlay is the host's policy. Hosts
MAY want to mark an app deprecated for compliance reasons even if the publisher still ships it as
`stable`. Overlay is stored per id (it applies to all versions of that id).

### `EffectiveClassification` — what the host should display

```ts
interface EffectiveClassification {
  maturity: Maturity; // overlay.maturity ?? manifest.classification.maturity ?? "stable"
  visibility: Visibility; // same precedence
  successor?: string; // overlay.successor ?? manifest.classification.successor
}
```

### `ListQuery` / `Page<T>` — pagination + filters

```ts
interface ListQuery {
  /** Substring against id / name / displayName. */
  q?: string;
  /** Filter by manifest category (one of the controlled vocabulary). */
  category?: string;
  /** Filter by effective maturity. */
  maturity?: Maturity;
  /** Filter by effective visibility. Default: ["public", "unlisted"]. */
  visibility?: Visibility[];
  /** Page size. Default 50, max 200. */
  limit?: number;
  /** Opaque cursor from a previous Page. */
  cursor?: Cursor;
}

type Cursor = string; // opaque to callers

interface Page<T> {
  items: T[];
  nextCursor?: Cursor; // omit when no more pages
}
```

## Operations

| Operation                               | Semantics                                                                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `register(sourceRef)`                   | Resolve → load → describe → upsert one `AppVersion`. Idempotent by `(id, version, digest)`. Returns `{ version, registered }` where `registered=false` when the existing row matched the digest. |
| `get(id)`                               | Returns the `RegisteredApp` (latest + overlay + effective). `undefined` if unknown.                                                                                                              |
| `getVersion(id, version)`               | Returns one specific `AppVersion`. `undefined` if unknown.                                                                                                                                       |
| `list(query)`                           | Pageable list of `RegisteredApp`. Filters apply to the **effective** classification.                                                                                                             |
| `listVersions(id)`                      | All `AppVersion`s for an id, newest first.                                                                                                                                                       |
| `load(id, {version?})`                  | Re-resolve the stored `sourceRef` and return a `LoadedApp` (runnable). Defaults to latest version.                                                                                               |
| `unregister(id, {version?})`            | Remove one version, or all versions (with `{ allVersions: true }`). Refuses to remove the only/last version unless `allVersions: true`.                                                          |
| `setMaturity(id, maturity \| null)`     | Set/clear the overlay's maturity.                                                                                                                                                                |
| `setVisibility(id, visibility \| null)` | Set/clear the overlay's visibility.                                                                                                                                                              |
| `setSuccessor(id, successor \| null)`   | Set/clear the overlay's successor.                                                                                                                                                               |

`load()` is part of the registry (not a host concern) because the registry is the only thing that
knows which `sourceRef` to re-resolve for a given `(id, version)`. Hosts that want a different
resolver inject one at construct time.

## DataStore contract

```ts
interface DataStore {
  /**
   * Insert a new (id, version) row and bind it to its action/auth set.
   * Atomic: either every row lands or none do. If (id, version) already
   * exists with a *different* digest → throw `version_conflict`. If it
   * exists with the *same* digest → return `{ registered: false, ... }`.
   */
  putVersion(input: PutVersionInput): Promise<{ version: AppVersion; registered: boolean }>;

  /** Set/clear the latest pointer for an id. */
  setLatest(id: string, version: string): Promise<void>;

  /** Read latest version + overlay + counts. */
  getLatest(id: string): Promise<RegisteredApp | undefined>;

  /** Read one specific version. */
  getVersion(id: string, version: string): Promise<AppVersion | undefined>;

  /** List apps (paged, filtered, by *effective* classification). */
  listLatest(query: ListQuery): Promise<Page<RegisteredApp>>;

  /** All versions for an id, newest first. */
  listVersions(id: string): Promise<AppVersion[]>;

  /** Remove one or all versions. Returns the number of versions removed. */
  remove(id: string, opts: { version?: string; allVersions?: boolean }): Promise<number>;

  /** Read-modify-write of the lifecycle overlay. Atomic. */
  patchOverlay(id: string, patch: Partial<LifecycleOverlay>): Promise<LifecycleOverlay>;
}
```

**Atomicity guarantees the data store MUST provide:**

- `putVersion` is a single transactional unit: actions and the version row land together or not at
  all.
- `remove` cascades to `app_actions` (or the equivalent action rows).
- `patchOverlay` is a single read-modify-write — concurrent callers MUST NOT see a torn overlay.

What the data store MAY do freely: caching, indexing, eventual indexing of search fields. The
registry never reaches around the data store.

## Idempotency

`register(sourceRef)` is content-addressable:

1. Resolve the ref → local dir; load + describe → `{ manifest, actions, auth }`.
2. Compute `digest = sha-256(canonical_json({manifest, actions, auth}))`.
3. Call `store.putVersion(...)`.
4. The store keys on `(id, version, digest)`:
   - **Same `(id, version)`, same digest** → no-op insert, `registered: false`.
   - **Same `(id, version)`, different digest** → `version_conflict` (publisher SHOULD bump
     `version` to publish changes).
   - **New `(id, version)`** → inserted; latest pointer SHOULD advance if the new SemVer is greater
     than the current latest, else stays put.

Canonicalization for the digest is: keys sorted lexicographically at every object level; `undefined`
omitted; arrays preserved in source order; numbers in their JSON form; strings as-is.

## Lifecycle

Lifecycle ops mutate the **overlay**, not the manifest. The manifest of every stored version stays
bit-identical to what `@w6w/runtime.describe()` produced. Effective values are computed at read
time:

```
effective.maturity   = overlay.maturity   ?? manifest.classification?.maturity   ?? "stable"
effective.visibility = overlay.visibility ?? manifest.classification?.visibility ?? "public"
effective.successor  = overlay.successor  ?? manifest.classification?.successor
```

Overlay applies per id (all versions). This matches the semantic intent — "this app is deprecated"
rarely means "this particular version is deprecated"; it means the publisher has moved on (or the
host has). Per-version policy can be layered later if needed.

## Federation (reserved)

The shape is designed so a future RFC can specify federated registries — a local registry that pulls
from an upstream and serves the cached copy — without breaking the local-host contract.

Reserved field names hosts MUST NOT repurpose:

- `AppVersion.origin.kind === "federated"` — provenance from an upstream.
- `RegisteredApp.overlay` — already specified; federation will add upstream-pin and mirror-policy
  fields under it in a future RFC.

V1 implementations:

- MUST write `origin: { kind: "local" }` on every registered version.
- MUST reject `register({ origin: "federated", ... })` with `unsupported_origin`.

## Reserved

- `signature` / `attestations` on `AppVersion` — provenance attestations. A later RFC will define
  their shape. The registry MUST preserve these fields on round-trip if present in the manifest, but
  MUST NOT interpret them.

## Resolved questions

| Question           | Resolution                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Storage layout     | Datastore-agnostic. Registry holds the contract; hosts implement persistence.                                                 |
| Versioning         | `(id, version)` PK; `latest` pointer per id; full history retained.                                                           |
| Idempotency        | Content digest over canonical `{ manifest, actions, auth }`. Same digest → no-op; same version + different digest → conflict. |
| Lifecycle          | Overlay on top of the manifest; effective values computed at read time.                                                       |
| `load()` ownership | In the registry — it owns the `sourceRef → LoadedApp` pipeline because it owns the `sourceRef`.                               |
| Federation         | Reserved (`origin`, future overlay fields). v1 is local-only.                                                                 |
| Provenance         | `signature` / `attestations` are reserved at the version level; manifest's reservations carry through.                        |

---

## Amendment: owner-scoped registration (2026-07-14)

> Adds per-**tenant** and per-**account** private apps alongside the global catalog. Motivated by
> embedded-tenant onboarding (a partner installs its own apps tenant-wide; the people working in it
> bring their own). Companion design + rollout: `.claude/docs/app-install-scoping.md`.
> Reconciled 2026-11-14: the personal tier is an **account** tier. The owner of an app is always a
> tenant or an account, never a user.

### Owner scope

A registered app gains an **owner scope** — the principal that installed it:

```ts
interface OwnerScope {
  tenant?: string;   // absent / "" → not tenant-owned
  account?: string;  // absent / "" → not account-owned
}
```

Three tiers, by which fields are set:

- **Global** — neither set. Operator-published; the existing behavior. Available to every tenant
  (subject to the host's tenant allowlist / entitlement policy, which is out of scope for this RFC).
- **Tenant** — `tenant` set, `account` unset. Installed by a tenant admin; available to every
  account in that tenant.
- **Account** — both set. Installed for one account inside a tenant; visible to every member of
  that account and to no foreign account in the same tenant.

`OwnerScope` carries `tenant` and `account` only: there is no subject slot, and no tier is ever
addressed to one person. The person who imported, published or edited a row is **attribution**
(`published_by`, `created_by`), which grants and limits nothing. Storage mirrors the scope: the
account tier is the `owner_account` column next to `owner_tenant`, and an empty pair is the global
tier. The wire token `personal`, where a host still accepts it as a management target, scope or app
class, is a **deprecated alias** for account-owned; it never means "visible to one subject".

Ownership is availability, never an exemption from policy: a deny list still filters an owned row, and
a host's credential and connection ownership is unchanged by the tier a row sits in.

### Identity

The reverse-DNS `id` stays **globally unique** — version identity remains `(id, version)`, and `owner`
is a **visibility/ownership attribute**, not part of the key. An `id` therefore belongs to exactly one
owner scope. `register(sourceRef, { owner })` MUST be rejected (`id_taken`) if that `id` already
exists under a **different** owner scope. Uniqueness spans the whole catalog rather than a tier or a
tenant: two accounts of the same tenant that register the same id collide with `id_taken`. This
keeps a workflow's app reference unambiguous and makes shadowing structurally impossible — a private
app can never reuse (and so never silently substitute) a global one.

> This global-uniqueness choice is deliberate: it avoids per-scope key surgery in datastores and their
> inbound foreign keys. A host MAY later relax `id` to be unique only *within* an owner scope, at the
> cost of composite keys; that is out of scope here.

### Registration & resolution

- `register(sourceRef, opts?: { owner?: OwnerScope })` — installs into `opts.owner` (default global).
  Idempotency (digest over `{ manifest, actions, auth }`) is evaluated **within the owner scope**.
- `list(query, opts?: { caller?: OwnerScope })` — returns the **union** for the caller: global ∪
  tenant-owned (`caller.tenant`) ∪ account-owned (`caller.tenant, caller.account`). Most-specific
  tier wins on `id`; absent `caller` → global only (back-compat).
- `get(id, opts?: { caller?: OwnerScope })` — resolves `id` **most-specific-first** (account →
  tenant → global) within the caller's scope.

Hosts MUST resolve an executing step's app against the **caller's** owner scope, and MUST treat an app
owned by the caller's scope as implicitly authorized (a host's tenant entitlement/allowlist governs
**global** apps only — an owner can always run what it installed).

### Trust

Privileged host capabilities (`ctx.host.*`, see the Hook-Runtime RFC) MUST NOT be granted to any
non-global (tenant- or account-owned) app. Owner-scoped apps run in the same least-privilege sandbox
as any third-party app; ownership conveys *availability*, never elevated trust.

### Back-compat

The owner scope is additive and defaults to global. A datastore that stores every app with an empty
owner scope, and a caller that passes none, reproduce the pre-amendment single-global-catalog behavior
exactly. A host migrating from the earlier `owner_subject` layout maps each row once — the user's
sole active membership, else the tenant's default account, else the tenant tier — and keeps the old
subject as attribution (`published_by`); the row itself is never dropped, and applying the migration
is a host task described in that host's own runbook. `origin`/federation reservations are unchanged and
orthogonal to ownership.

## Amendment: id-set lookup (2026-10-04)

> The original text above does not yet describe id-set lookup, `sort`, or `interface` — four spots
> are each incomplete on these points: `registry.md:163-187` (the `ListQuery`/`Page<T>` block omits
> `ids`, `sort` and `interface` entirely), `:196` (the `list(query)` operations-table row), `:230`
> (`listLatest(query)` in the `DataStore` contract — missing both the `ids` field and the `opts?`
> argument), and `:364` (`list(query, opts?)` in the owner-scoped registration amendment — correct on
> `opts?`, silent on `ids`). Everything else in those sections, and in the file as a whole, otherwise
> stands as written.

`ListQuery` gains an optional `ids` field, honored by every `DataStore` implementation
(`listLatest`) and by `Registry#list`, which forwards it unchanged:

```ts
interface ListQuery {
  // … q / category / maturity / visibility / limit / cursor unchanged …

  /** Ordering. Defaults to `"name"` — display name, A→Z. (Already shipped; was missing above.) */
  sort?: AppSort; // "name" | "-name" | "recent" | "-recent"

  /** Filter by declared Interface id. (Already shipped; was missing above.) */
  interface?: string;

  /**
   * Resolve exactly this set of ids instead of a page. When present:
   *  - the result is the **union with the caller's owner scope** — the same
   *    rule `list`/`listLatest` already apply (global ∪ `caller.tenant`-owned
   *    ∪ `caller.tenant,caller.account`-owned); an id outside that union, or
   *    one that does not exist, is silently omitted — never reported as an
   *    error, the same as a page simply not containing it.
   *  - the effective-visibility default is UNCHANGED (`["public",
   *    "unlisted"]` unless the caller passes its own `visibility`), and every
   *    other filter (`q`, `category`, `maturity`, `visibility`, `interface`)
   *    still ANDs with the set.
   *  - `limit`, `cursor` and `sort` are ignored: every visible member of the
   *    set returns in ONE page; `nextCursor` is never set.
   *  - an **empty array is itself a request** (`ids: []` → an empty page) —
   *    never treated as "no id filter."
   *  - capped at `MAX_IDS_PER_QUERY` (100) distinct ids, exported alongside
   *    `MAX_PAGE_SIZE`; a datastore MAY assume a caller already enforced the
   *    cap (the host enforces it at the wire, `GET /apps?ids=a,b,c` → 400
   *    `too_many_ids` over the limit) but MUST still behave correctly if
   *    handed more.
   */
  ids?: string[];
}
```

`listLatest`/`list` both take an optional second argument, `opts?: ReadOpts` (`{ caller?:
OwnerScope; unscoped?: boolean }`) — the owner-scope amendment above already defines its semantics
in full; the two earlier sections' signatures (`listLatest(query)`, `list(query)`) predate that
argument and are completed the same way here: `listLatest(query, opts?)`, `list(query, opts?)`.

## Amendment: pinned pagination (2026-10-16)

> This amendment re-reads `Page<T>` and the `cursor` / `nextCursor` contract (`registry.md:176`,
> `registry.md:177`, `registry.md:178`, `registry.md:181`, `registry.md:183`, `registry.md:185`),
> the `list` operation row (`registry.md:196`), the `DataStore#listLatest` signature
> (`registry.md:230`), the host-policy out-of-scope line (`registry.md:342`), the `ids` arm's
> "one page" rule (`registry.md:401`, `registry.md:420`, `registry.md:421`) and the `ReadOpts`
> argument (`registry.md:434`). Everything else above stands as written.

Pagination so far promised only an opaque `Cursor` and a `nextCursor` that is omitted on the last
page. A host that lists a changing catalog needs more: a page boundary that does not move while a
client is paging, and a way to say "page 7 of 12". This amendment adds both as **optional** fields
and shared cursor forms. A store that does none of it (the in-memory store, a CLI host) remains a
valid implementation.

### Types

`ListQuery` gains **no field**. `snapshot` and `offset` are a snapshot host's own wire parameters,
not members of the registry's query type; `limit` is the existing `ListQuery.limit`
(`registry.md:176`), reused unchanged as the page size. The page-addressing state travels in
`cursor` (which already exists) or in the host's own parameters.

`Page<T>` gains four optional fields (shown in full):

```ts
interface Page<T> {
  items: T[];
  nextCursor?: Cursor; // omit when no more pages
  total?: number; // size of the whole filtered result, when known
  snapshot?: string; // token of the snapshot this page was cut from
  offset?: number; // position of items[0] within that result
  expiresAt?: string; // ISO-8601 earliest instant the snapshot stops answering (idle window or absolute cap)
}
```

`total`, when set, counts the whole filtered result (after query fields, owner scope and policy),
never just the current page.

Policy reaches a store as data, never as a callback:

```ts
interface ListPolicySets {
  blocked: readonly string[];
  allowOnly?: readonly string[];
}

interface ReadOpts {
  caller?: OwnerScope;
  unscoped?: boolean;
  policy?: ListPolicySets;
}
```

The `policy` field extends the `{ caller?; unscoped? }` shape described at `registry.md:434`.

The rule, applied identically by every store that is handed `opts.policy`:

- ids in `blocked` are never listed;
- when `allowOnly` is present it restricts the result to those ids, **except** rows owned by the
  caller;
- "owned" means `owner_tenant <> ''` and `owner_tenant = caller.tenant` and (`owner_account = ''`
  or `owner_account = caller.account`), which mirrors the owner-scope amendment's
  `isOwnedByCaller`;
- an owned row is never exempt from `blocked`.

Host policy *decisions* (which ids a tenant may see) stay out of scope, consistent with
`registry.md:342`; the store only applies the sets it is handed.

### Filters before paging

`DataStore#listLatest` and `Registry#list` apply every filter (the query fields, the owner scope and
`opts.policy`) **before** the page boundary is drawn. Pages are full except the last, and `total`
counts the whole filtered result. The `ids` arm is exactly as the id-set amendment defines it: one
page, no `nextCursor`, never snapshotted.

### Cursor

`type Cursor = string` stays opaque to callers. Two forms exist:

- the **legacy offset cursor**, written `o:N` (base64 of `o:<n>`): unpinned and live, the form a
  `DataStore`'s own `listLatest` issues;
- a **snapshot cursor**, issued by a host that paginates with snapshots, encoding (snapshot, offset,
  limit). Its byte layout is not specified.

A snapshot host answers a legacy `o:N` by opening (or reusing) a snapshot for the request's own
filters and serving offset N. A malformed cursor is rejected with `invalid_cursor`; it never
silently restarts at offset 0.

### Snapshot model

This section binds hosts that paginate with snapshots, not every host.

- **Creation.** A request with no token runs the full filtered and sorted query, stores the result,
  and returns page 1 with `snapshot`, `total`, `offset`, the effective `limit`, `expiresAt` and
  `nextCursor`.
- **Navigation.** Two styles address one snapshot: `snapshot` + `offset` + `limit` (random access),
  or `cursor` = the previous `nextCursor` (sequential). `limit` may change between requests.
  Sending `snapshot` and `cursor` together is `invalid_cursor`.
- **Binding.** The token binds the query and the caller scope. Filter and sort parameters sent with
  a token must be absent or identical to the creating query, else `snapshot_query_mismatch`.
- **No existence oracle.** A token that belongs to another caller answers exactly as an unknown one
  (`unknown_snapshot`). The checks run in the order scope, then expiry, then query.
- **Frozen.** Membership, order, `total` and item data do not change after creation. A snapshot
  never grants access: whether an item may be invoked is still decided live.
- **Lifetime.** A snapshot lives for an idle (sliding) window bounded by an absolute cap, both
  chosen by the host. Past either, it answers `snapshot_expired`. A reference host uses 30 minutes
  idle and 2 hours absolute; those values MAY be cited and are not requirements. A client treats
  `snapshot_expired` and `unknown_snapshot` alike and restarts from page 1.
- **End of list.** `nextCursor` is absent if and only if `offset + items.length >= total`. An offset
  past `total` returns an empty page. A short page never by itself signals the end.

A host MAY share one stored snapshot between requests whose query, scope, catalog revision and
policy are equal.

### Where snapshots live

Snapshot storage is a host concern and is not part of `Registry` or `DataStore`. Scope
(tenant, account), lifetime, sweeping and the de-duplication of equal queries (including
policy) exist only in the host, and `Registry` is also a library for in-memory and CLI hosts. The
registry surface gains only the optional `Page<T>` fields, the `ReadOpts.policy` data carrier and
the shared cursor forms above; no method is added to either interface.

---

## Amendment: publishers and namespaces (2026-11-13)

> Opens the registry to third-party publishers. Until now every id in the global catalog was
> published by W6W; an account could only install into its own private tier. Companion roadmap:
> `.claude/docs/app-publishing-roadmap.md` (D-1, D-2, D-8). Reconciled 2026-11-14: a namespace is an
> independent record that decides who may register an id, and a publisher is a facade over the
> namespaces its tenant holds, never their owner.

### Publisher

A **publisher** is the named party that publishes apps. It is a first-class record with a unique,
URL-safe `slug`, a display name, an owning tenant, a `status` (`active` | `suspended`) and a set of
**members**, each with a role (`owner` | `developer`). A publisher MUST always have at least one owner;
removing the last owner MUST be refused (`last_owner`). W6W is itself a publisher (slug `w6w`) and
is the first one: there is one publishing pipeline, not a first-party path and a third-party path.

A publisher holds no namespace of its own: its reach over app ids comes from the namespaces held by
its owning tenant. Publisher membership and listing management are separate from namespace
authority, so a tenant with no publisher still holds namespaces and a publisher gains none by
existing.

### Namespace

A **namespace** is a reverse-DNS id prefix held by an operator, a tenant or (reserved) an account
or a publisher: the domain `zapier.com` is the prefix `com.zapier`; `tables.zapier.com` is
`com.zapier.tables`. The prefix is lowercase, IDNA-ascii only, and has at least two labels. The one
non-DNS form is `@w6w` (below), which matches ids beginning `@w6w/`.

A namespace is a **record in its own table**, independent of publishers, tenants and accounts. One
tenant can hold several namespaces, and no holding is stored on a publisher row, an account row or a
tenant row.

| Field          | Values                                                                                |
| -------------- | ------------------------------------------------------------------------------------- |
| `owner_kind`   | `operator`, `tenant`, `account`, `publisher` (the last two are reserved, not enabled) |
| owner columns  | match `owner_kind`: a `tenant` row carries an owner tenant, an `operator` row none    |
| `status`       | `pending`, `active`, `revoked`                                                        |
| `verification` | `operator`, `dns`, `well_known`, `delegated`                                          |

An **active** namespace matches an app id when the id equals the prefix or begins with the prefix
followed by `.`: `vip.cohost` matches `vip.cohost` and `vip.cohost.flite`, and MUST NOT match
`vip.cohostx.a`. `@w6w` keeps its slash form and matches ids beginning `@w6w/`. When several active
namespaces match one id, the **longest** prefix owns it, so a longer prefix held by another tenant
defeats an own shorter parent.

| Status     | Meaning                                                                 |
| ---------- | ----------------------------------------------------------------------- |
| `pending`  | Claimed; a verification token has been issued; proof not yet seen.      |
| `active`   | Control was proven, or an operator vouched; the holder owns the prefix. |
| `revoked`  | Withdrawn by the holder or an operator.                                 |

Only an `active` namespace confers registration authority; `pending` and `revoked` namespaces MUST
NOT match any id. A prefix is active for at most one holder at a time; a claim on a prefix another
holder has active is refused (`namespace_owned`). An id under no active namespace has no owner at
all (see the allow-list below).

### Verification

A host MUST accept at least one of these proofs of domain control, each carrying the namespace's
token, and records the method on the row:

1. **`dns`** — a TXT record at `_w6w-publisher.<domain>` whose value contains the token.
2. **`well_known`** — `https://<domain>/.well-known/w6w-publisher.txt` whose body contains the
   token.

The host MAY additionally let an operator vouch for a namespace (method `operator`); that is how the
reserved namespaces and operator assignments are seeded. `delegated` is a storage value for a
holding covered by an operator delegation; it has no separate public method and reports as
`operator`. A verification that cannot yet be proven is not an error: it reports `verified: false`
with a reason, and the holder retries.

The existing publisher DNS/well-known proof flow is retained unchanged and writes a **tenant**
holding with `dns` or `well_known`. It does not onboard a new tenant to a top-level domain and never
stores ownership on the publisher.

### Reserved namespaces

`io.w6w` and `@w6w` are reserved to W6W. No other holder may claim them, and an id inside them
(`io.w6w` or `io.w6w.*`, `@w6w/*`) MUST NOT be registered or published by anyone but an operator
acting for the W6W publisher. A host MAY reserve further prefixes; a reserved prefix is
operator-owned, and its refusal is distinct from `namespace_owned`.

### The registration allow-list

Every **non-global** registration must fall under a namespace the target tier holds: import,
refresh, management writes, operator-initiated tenant targets, tenant boot and artifact upload all
pass the same check, and it runs **before** any blob or catalog write, so a refused id leaves
nothing behind. A global operator/CI registration is the only exemption. Given an actor and an app
id, a host decides in order:

1. An operator or CI registration into the **global** catalog is exempt (the operator/CI exception).
   An operator registering into a tenant or account tier is a non-global registration and passes the
   allow-list below like any other actor, so an unclaimed id is refused (`namespace_not_owned`).
2. An id inside a reserved namespace is refused to every other actor.
3. An id under an active namespace is registrable only into that namespace's holder — the holding
   tenant's tenant tier or one of its account tiers. A prefix active for **another** tenant is
   refused (`namespace_owned`); an id with no usable holding of the target is refused
   (`namespace_not_owned`, whose message lists the target's prefixes or says that an operator
   assignment is needed). A publisher actor additionally needs membership of the publisher attached
   to that tenant, and a suspended publisher refuses new publishes (`publisher_suspended`).
4. There is **no private-id fallback**: an id under no active namespace is refused for every
   non-global registration, into any tier. Account namespaces, self-serve claiming and new
   DNS-verified tenant top-level onboarding are deferred; until then a tenant with no holding
   registers nothing non-global, and an operator assigns holdings by hand.

A host's existing `allow_user_app_import` policy stays a separate per-tenant switch on self-install
into the account tier: it neither grants nor withholds a namespace, and a namespace holding neither
grants nor withholds that self-install.

### Relation to owner scope

This extends the owner scopes of _Amendment: owner-scoped registration_. An id inside an active
namespace may be registered only into the holding tenant's tenant tier or one of that tenant's
account tiers — never into another tenant's tier or a foreign account's. An id outside every active
namespace has no non-global tier at all. The global tier is unchanged and remains reachable only by
operators.

Nothing is promoted automatically: an account-owned app does not become tenant- or
publisher-owned, and a new publisher inherits no app from its tenant's existing namespaces. A row's
owner scope is not rewritten by a publisher change; registering the same id under a different owner
stays refused with `id_taken`.

### Publisher bridge

Publishers are a facade over the namespace records, not their owner. `PublisherService.ownerOfAppId`
and `canPublish` keep their signatures. `ownerOfAppId` resolves the longest active prefix matching
the app id and returns the **oldest** publisher, by `(created_at, id)`, of the tenant holding that
prefix, or `null` when that tenant has no publisher. `canPublish` makes the namespace-first decision
above: an operator is allowed anywhere, a reserved id is refused to everyone else, and an actor may
publish only when the holding namespace is `tenant`-owned by the actor's own tenant. Publisher and
listing membership is separate from namespace authority.

### The manifest `publisher` field

A manifest's `publisher` field is **informational**. The holder of the longest active namespace is
authoritative for who published an app, and a host MUST display and enforce that holder, never the
manifest string. A manifest may therefore claim any publisher without effect.

### Revocation

Revoking a namespace or suspending a publisher stops further publishing into the affected ids. A
revoke is refused with `409 namespace_in_use` while any version of the holding tenant's apps —
including candidates, history and apps under a child prefix the same tenant holds — matches the
prefix on an exact or dot boundary; the response lists up to 50 ids plus the total, and publish and
revoke take the same advisory lock, so a publish cannot slip in between the check and the revoke.
This replaces the older "revoke keeps installed apps" promise for tenant namespaces.

The registry still never deletes a version: a successful revoke withdraws the holding and nothing
else, and removing an app stays a separate, explicit lifecycle action. Suspension is likewise not an
uninstall — versions already registered, and installs of them, keep working.

---

## Amendment: submission, review and listing (2026-11-14)

> Adds the path from a publisher's private app to the global catalog. It records **option (a)** of the
> listing decision: an approved version is registered into the **global tier**, and a separate
> listing record carries the publisher's management rights. Companion roadmap:
> `.claude/docs/app-publishing-roadmap.md` (D-3..D-5). This amendment only adds; nothing above it
> changes meaning.

### Roles

The member roles are `owner` | `developer`. `developer` is the non-owner role, matching
`publisher_members.role`, and a host MUST reject any other value. The last-owner rule is unchanged.
(Earlier drafts of this amendment called the non-owner role `member`; `developer` is the name
everywhere in this document.)

### Listing record

A **listing** is a host record, one per app id, that is separate from the registry's version rows.
It names the publishing `publisher_id`, the listing copy, the id of the version currently listed, and
a `state`: `private`, `in_review`, `changes_requested`, `listed`, `suspended` or `delisted`. A
**submission** is an immutable request that binds an app id, a version and that version's digest to
the checks run on it and the decision made.

Management rights over a listed app (submitting new versions, editing copy, withdrawing) follow
`app_listings.publisher_id` and the publisher's members, **not** the registry row's owner. After
approval the owner of the version row is the global tier (empty owner), which no tenant can write to;
the listing is what still ties the app to its publisher.

### Approval and candidate rows

A registry data store gains one operation, `approveVersion(id, version, { expectedDigest })`. In one
transaction, holding a row lock on the app's latest pointer, it sets the owner of the named version
row to global and advances the latest pointer to it, also global. A digest that no longer matches the
stored row is refused with `stale_submission`; a missing version with `unknown_version`; a refusal
changes nothing. Approval is the **only** way a version enters the global tier on behalf of a
publisher. The `id_taken` refusal for registering under an id another owner holds stays as it is
for every other caller.

Before approval, a submitted version is a **candidate row**: stored under the publisher's own owner
while the id already exists in the global tier. A host enables this by passing an `admitCandidate`
port to the registry; with the port absent or returning false, behaviour is exactly as before
(`id_taken`). A candidate row:

- never advances the latest pointer;
- is returned by `getVersion`, `getLatest`, `listVersions` and the host-internal `load` only to the
  matching `caller`, or when the read passes `includeCandidates: true`. `unscoped: true` alone does
  not reveal it, and neither does a different tenant or a read with no options: those see
  `unknown_version` or absence, as if the version did not exist;
- is never served by an explicit version or a pin to another tenant, because the check sits in the
  store read itself, not only in the latest pointer.

A non-listed private app (every row one owner) and a legacy global app (no listing row) read exactly
as before.

### Visibility is not review

Two things that look alike are kept apart. **Visibility** (`public`, `unlisted`, private) says who may
discover an app and is what the existing policy filter reads. **Review** (the listing `state`) says
whether the host has accepted the app into the global catalog. An app's self-declared classification
never authorizes listing. `unlisted` after approval is a listed app that is hidden from browse and
search but still resolvable and invocable by id. `suspended` hides the app and refuses **new**
connections while existing ones keep running; `delisted` refuses invocation, explicit and pinned
versions included. Tenant allowlist and deny policy still applies on top of a listing and is not
overridden by it.

### What approval moves

Approval moves **the app row only**: the version row's owner and the latest pointer. Connections,
credentials, and any app-scoped OAuth client configuration stay owned by the tenant that created
them. In particular:

- `app_oauth_config` is keyed by `(app_id, auth_key)` and has no tenant column, but it is written only
  through operator routes (`PUT /apps/:id/oauth-config/:authKey`, scope `operator:apps`), and the
  per-tenant override (`tenant_oauth_app`) only through operator tenant routes. A publisher's tenant
  therefore has no way to store an app-scoped OAuth client secret for its private app, and nothing of
  that kind becomes reachable by other tenants when the app is approved. A row an operator created
  for the id already belonged to the operator.
- Connections are keyed by the owning tenant and stay with it; another tenant's connection to the
  same app is its own.

A host that later lets a tenant write app-scoped OAuth configuration MUST re-examine this rule
before approval can move such a row.

### Read paths and why each stays correct

Every place a host reads the app catalog, under option (a):

| Read path | Why it stays correct |
| --- | --- |
| Registry foundation (`getLatest`, `getVersion`, list) | The approved row and the latest pointer are both global, so every scope resolves them as it does any global app. Candidate rows are filtered inside the store read (above), so other scopes never see an unapproved version. |
| Invoke (including explicit version, pins, model entitlement) | A global app resolves for every tenant and still passes the tenant allowlist/deny decision. Explicit and pinned versions go through the same candidate filter, so pointer-only approval is not what protects them. A `delisted` listing is refused at load. |
| Connections (create, test, MCP connect) | A global id resolves across tenants as before. A `suspended` or `delisted` listing refuses a **new** connection; existing connections are untouched. |
| Health, HTTP and MCP | Scope resolution finds the global app; an explicit-version health load honours the candidate rule. |
| MCP search | A listed app enters the candidate set through the ordinary registry list; suspension and `unlisted` remove it from discovery without removing it from resolution. |
| System-ops catalog | The existing predicate (both owner columns empty on both tables) is satisfied by an approved version, so no query changes; the listing state is checked in addition. |
| Apps-catalog list (ids arm and paged snapshot arm) | Both arms read global rows that now include approved apps; the snapshot list counts only rows owned by the record's owner, so candidate rows do not inflate it. Browse additionally filters on listing state. |
| Visibility and policy filter | The existing deny-versus-hide separation is reused: `suspended` and `unlisted` hide, `delisted` denies. Listing state is read from the listing record, never from the manifest. |
| Publish-index (digest feed) | It reads global latest digest facts; an approved version appears there as any global version does, and first-party hash and no-op semantics are unchanged. |
| Tenant operator catalog | The operator view opens the tenant snapshot with all visibilities, so suspended and delisted apps stay inspectable; only public browse is filtered. |

### Failure of the listing record

A global app with no listing row is a legacy or first-party app and is treated as listed. An app that
has a listing row is governed by its `state`. Neither case changes how the registry stores versions.


## Pack ownership (2026-11-13)

> Names each per-repo app index and makes its app ids owned by that pack. Companion roadmap:
> `.claude/docs/app-publishing-roadmap.md` (D-1, D-7).

A **pack** is a named app index: one repository publishing its own index at
`apps/<pack>/index.json`. `POST /system-ops/apps/publish-index` takes an optional `pack` next to
`indexSha256`. A pack name matches `^[a-z0-9][a-z0-9-]{0,62}$` — lowercase letters, digits and `-`,
starting with a letter or digit; any other name is `400 invalid_body`.

A pack **owns an app id's index entry**: the owner is the pack whose index registered it, recorded
as a row `app_packs(app_id, pack, claimed_at, updated_at)` with at most one owner per id. This is
index ownership for the publish-index feed, not authority to register the id — registration
authority is the namespace rule above, and the two are recorded separately. Ownership is
**claimed on first publish**: publishing an id that has no owner asserts the publishing pack as its
owner, with `from_pack = null`. A publish into a named pack registers only the ids in that pack's own
index and never touches another pack's apps or ownership rows. An id already owned by a different
pack P is reported `failed` with `owned_by_pack:<P>`, and its row is unchanged.

Ownership is decided at the start of a publish, before it registers anything — claim before publish:
an id another pack owns is dropped from the publish, and the ids a publish may own are claimed for its
pack with an insert-if-absent write. The one **residual window** is a `pack-move` landing while a
publish is in flight: that publish never sees the move, finishes under its starting ownership, and may
register one last set of versions for the previous pack; a re-run of the move reconciles the two.

Ownership moves only by an explicit, audited operation: `POST /system-ops/apps/pack-move`
(`{appId, toPack, reason}`, ops scope `apps:publish`). It updates the owner and appends a row to the
`app_pack_moves` audit table — `app_id`, `from_pack` (null when the app was unowned), `to_pack`,
`reason`, `actor`, `at` — in one transaction. An unknown app id is `404`.

A publish with **no `pack`** is the global-index behaviour and is exactly unchanged: it neither
claims nor consults pack ownership. Publishing never unregisters an app: an id that leaves an index
keeps its registered versions, and removal stays a separate, explicit lifecycle action.
