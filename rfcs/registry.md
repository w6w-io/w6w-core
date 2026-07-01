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
