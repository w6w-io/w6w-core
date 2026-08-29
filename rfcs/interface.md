# RFC: Interface

**Status:** Draft
**Author:** Segev Shmueli
**Date:** 2026-08-28

## Summary

An **Interface** is a named, versioned **method contract** — "blob-store", "secrets-reader" — that
zero, one, or many Apps may each *conform to* by binding some or all of the contract's methods to
their own Actions. Where a [Function](./function.md) binds a single canonical operation to one
swappable Action, an Interface generalises the same idea to a **named bundle of methods**: instead
of one caller depending on one App's Action, a caller can depend on the *contract*, and any App that
declares conformance can stand in for it. `io.w6w.github` conforming to `blob-store@1` is the worked
case this RFC pins throughout — a future GitLab or S3 App conforming to the same contract is the
point of building it this way.

An Interface is not a new kind of entity. It is a **property an App carries** — `AppDefinition`
grows one new optional field, `interfaces?: InterfaceConformance[]`, exactly as it already grew
`healthChecks?` and `triggers?`. There is no `Connector` type introduced anywhere by this document.

## Motivation

`26-08-22-01-repo-sync` shipped a GitHub-specific Documents↔repo sync: Studio's connection picker is
hardcoded to one App id, and the server's repo-sync service is written narrowly enough that a GitLab
or Gitea implementation is "a mapping table, not new code" — but nothing in the spec **names** that
mapping as a first-class thing the platform understands. Nothing today lets a caller say "give me
whatever connection can read/write blobs" and have that resolve against more than one App.

[Function](./function.md) already solved the adjacent, smaller problem — one canonical operation,
one swappable Action — and its `impl` shape (`{ uses, with, outputMap }`, resolved by
`resolveWith`) is exactly the machinery this RFC reuses rather than reinvents. What Function does
not give you is a **bundle**: "blob-store" is five related operations (`headRef`, `list`, `get`,
`put`, `delete`), and an App that wants to offer blob-store semantics needs to declare all five at
once, against its own Actions, as one conformance statement — not five independent Functions with no
relationship to one another. An Interface is that bundle, named once and satisfiable by any App.

## Goals

- Declare a **canonical, versioned method contract** — `InterfaceSpec`, a list of
  `InterfaceMethod`s, each with its own `inputs`/`output` — reusing core
  [`Param`](./param.md)`[]`/[`Output`](./action.md#output) **verbatim**, exactly as
  [Function](./function.md) does, rather than inventing a second schema language.
- Let an App **assert** conformance to an Interface's methods, in whole or in part, via
  `InterfaceConformance` on its `AppDefinition` — the same file `healthChecks` and `triggers`
  already live on.
- Bind each method an App conforms to via an `InterfaceMethodImpl` that mirrors
  [Function](./function.md)'s `FnActionImpl` — same `{ uses, with?, outputMap? }` shape, same
  `resolveWith` adapter — **minus `uses.app`**: the invoked App id is never part of the mapping.
- Extend [F-6](../../../.ai/projects/.work/26-08-27-00-connectors/intake.md)'s consumer checklist
  (Workflow step / Function / Endpoint / Alias / Health / MCP) with a row stating exactly what an
  Interface does and does not present to each consumer today.
- Record every limitation this design deliberately leaves open, with its reason, rather than let it
  surface later as an undocumented gap.

## Non-Goals

- **Introducing `Connector` as a type.** F-1 (this project's own naming decision) ratified that a
  connector *is* an App; nothing here revisits that. See [Concept](#concept).
- **Host-verified conformance.** v0 conformance is **asserted**, not checked against the declared
  method shapes at import time. See [Conformance](#conformance).
- **Binding an Interface anywhere `Step.uses`, `EndpointTarget`, or an Alias target is resolved.**
  None of the three gains a new arm in this run. See [Consumers](#consumers).
- **A registration mechanism for new interface ids.** The vocabulary is closed and host-curated for
  now — see [Governance](#governance-the-interface-id-vocabulary).
- **A generic host invocation primitive for Interfaces**, analogous to Function's
  `ctx.invokeFunction`. Because `InterfaceMethodImpl` is byte-for-byte the same shape as
  [Function](./function.md)'s `FnActionImpl` minus `uses.app`, a consuming host resolves it with the
  **identical** `resolveWith` adapter a Function's `impl` already uses — it does not need a new
  engine seam to do so. This run's one consumer (the pilot repo-file transport) resolves
  `InterfaceMethodImpl` directly in host code; adding an engine-level `ctx.invoke*` for Interfaces is
  deferred until a second consumer needs one.
- **The adapter language growing new primitives** (binary transforms, shape assertions, string
  split/join). See [Deferred limitations](#deferred-limitations).

## Concept

### Interface, not Connector

F-1 already settled this project's naming question: a connector *is* an App, not a second type
beside it. This RFC does not reopen that. An **Interface is a property an App carries** — one App
may declare conformance to zero, one, or several Interfaces, on top of its ordinary Actions, Auth
and Health surface, exactly as it already carries `healthChecks` and `triggers`. There is no
`Connector` entity, no `Connector` table, and no new top-level primitive alongside App, Action, and
Function. Reading "Interface" as "the spec Connectors implement" is correct informally; reading it
as introducing a `Connector` type is not.

### The generalisation from Function

A Function is a **canonical interface bound to one swappable implementation** — one method, one App,
one Action. An Interface generalises the same shape to a **named, versioned bundle of methods**
that **more than one App can each satisfy independently**:

```
                    InterfaceSpec (the contract — canonical, versioned, shared)
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
     App A conforms  App B conforms  App C declares no
     (all methods)   (some methods)  conformance at all
```

Each App's conformance is its own `InterfaceConformance` entry: an `interfaceId` plus a
`Record<methodKey, InterfaceMethodImpl>` naming, per method it satisfies, which of *its own* Actions
implements it and how the canonical inputs/output map onto that Action's own params/output. The
per-method binding shape (`{ uses: { action }, with?, outputMap? }`) is Function's `FnActionImpl`
with exactly one field removed — see [The security reason `uses.app` is absent](#the-security-reason-usesapp-is-absent).

Two Apps conforming to the same Interface never share code or a connection; each conforms
independently, against its own Actions. There is no cross-App dispatch here — only a shared,
named contract that lets a caller stop depending on which App answered.

## Shape

```ts
// packages/core/packages/types/src/interface.ts
import type { Param } from "./param.ts";
import type { Output } from "./action.ts";        // Output = OutputField[] | DynamicOutput (action.ts:27)

/** One method on an Interface's canonical, vendor-neutral contract. */
export interface InterfaceMethod {
  key: string;
  title?: string;
  description?: string;
  inputs: Param[];
  output?: Output;
}

/** A named, versioned method contract that multiple Apps may each satisfy. */
export interface InterfaceSpec {
  id: string;               // `<name>@<major>` — e.g. "blob-store@1"
  displayName: string;
  description?: string;
  methods: InterfaceMethod[];
}

/**
 * How ONE Interface method binds to one of the DECLARING app's own Actions.
 * Structurally Function's `FnActionImpl` MINUS `uses.app`.
 * The omission is a security boundary, not a convenience — see below.
 */
export interface InterfaceMethodImpl {
  uses: { action: string };
  with?: Record<string, unknown>;
  outputMap?: Record<string, unknown>;
}

/** An App's ASSERTION that its own Actions satisfy an Interface. Conformance is asserted, not
 *  host-verified — see Conformance. */
export interface InterfaceConformance {
  interfaceId: string;
  /** Interface method key → this app's binding for it. */
  methods: Record<string, InterfaceMethodImpl>;
}
```

`InterfaceSpec` itself — the canonical contract text — is not a runtime-loaded artifact in v0; it is
**this document**. `blob-store@1`'s five methods are pinned below as the worked, canonical example,
and are the vocabulary [Governance](#governance-the-interface-id-vocabulary) refers to as "this
document's own list."

### `blob-store@1` — the worked example

```
id: "blob-store@1"
methods (canonical inputs use the {owner, repository} coordinate shape — GitHub/Gitea's own shape):
  headRef { owner, repository, branch }                          → { sha }
  list    { owner, repository, path, ref? }                      → [{ path, sha, type, url? }]
  get     { owner, repository, path, ref? }                      → { path, sha, content, encoding, url? }
  put     { owner, repository, path, content, expectedSha? }     → { sha }
  delete  { owner, repository, path, expectedSha }               → { ok }
```

`get`'s `content` travels as base64, exactly as the vendor returned it — see
[Deferred limitations](#deferred-limitations) item (i). `delete` requires `expectedSha`
unconditionally — see item (iii).

`io.w6w.github`'s conformance declaration on its own `AppDefinition` — `list` and `get` both bind
the *same* Action (`file-get`) with identical `with`, because the divergence between "one file" and
"a directory listing" is an array-vs-object shape distinction the declarative adapter cannot express
(item (i)); two method entries pointing at one Action is legal and deliberate:

```ts
interfaces: [{
  interfaceId: "blob-store@1",
  methods: {
    headRef: { uses: { action: "ref-get" },
               outputMap: { sha: { "$": "output.object.sha" } } },
    list:    { uses: { action: "file-get" },
               with: { owner: { "$": "inputs.owner" }, repository: { "$": "inputs.repository" },
                       filePath: { "$": "inputs.path" }, ref: { "$": "inputs.ref" } } },
    get:     { uses: { action: "file-get" },
               with: { owner: { "$": "inputs.owner" }, repository: { "$": "inputs.repository" },
                       filePath: { "$": "inputs.path" }, ref: { "$": "inputs.ref" } } },
    put:     { uses: { action: "file-create-or-update" },
               with: { owner: { "$": "inputs.owner" }, repository: { "$": "inputs.repository" },
                       filePath: { "$": "inputs.path" }, content: { "$": "inputs.content" },
                       sha: { "$": "inputs.expectedSha" },
                       commitMessage: "w6w interface sync" },          // a LITERAL — see item (iv)
               outputMap: { sha: { "$": "output.content.sha" } } },
    delete:  { uses: { action: "file-delete" },
               with: { owner: { "$": "inputs.owner" }, repository: { "$": "inputs.repository" },
                       filePath: { "$": "inputs.path" }, sha: { "$": "inputs.expectedSha" },
                       commitMessage: "w6w interface sync" },
               outputMap: { ok: true } },
  },
}],
```

### The security reason `uses.app` is absent

`InterfaceMethodImpl.uses` carries an Action **key** and nothing else — no App id. This is a
boundary, not tidiness: the App a method's Action gets invoked *on* is resolved from the
**connection** a caller supplied, never from the manifest. A manifest can therefore never redirect
an invoke at another App's credentials, no matter what it declares — there is no field to redirect
with. If a future revision ever adds an `app` field to `InterfaceMethodImpl`, this property is gone;
any change to this shape MUST be re-justified against this paragraph, not merely against convenience.

### Field reference

#### InterfaceSpec

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | ✅ | `<name>@<major>` (e.g. `"blob-store@1"`). Globally unique within the closed vocabulary this RFC documents — see [Governance](#governance-the-interface-id-vocabulary). |
| `displayName` | string | ✅ | Human-facing name. |
| `description` | string | ⬜ | One-line summary of what conforming to this contract means. |
| `methods` | [`InterfaceMethod`](#interfacemethod)`[]` | ✅ | The canonical method list. |

#### InterfaceMethod

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✅ | Machine name, unique within the Interface. |
| `title` | string | ⬜ | Human-facing name. |
| `description` | string | ⬜ | One-line summary. |
| `inputs` | [`Param`](./param.md)`[]` | ✅ | The canonical, vendor-neutral input shape. Reuses the Param RFC verbatim, exactly as `Fn.inputs` does. |
| `output` | [`Output`](./action.md#output) | ⬜ | Canonical output shape, reusing the Action RFC's `output` verbatim. |

#### InterfaceConformance

| Field | Type | Required | Description |
|---|---|---|---|
| `interfaceId` | string | ✅ | The `InterfaceSpec.id` this entry conforms to. |
| `methods` | `Record<string, InterfaceMethodImpl>` | ✅ | Method key → this App's binding for it. May be a **subset** of the Interface's methods — partial conformance is legal; there is no requirement to bind every method. |

#### InterfaceMethodImpl

| Field | Type | Required | Description |
|---|---|---|---|
| `uses` | object | ✅ | `{ action }` — the Action **key** on this App's own `AppDefinition`. No `app` field — see [above](#the-security-reason-usesapp-is-absent). |
| `uses.action` | string | ✅ | Action key within the declaring App. |
| `with` | object | ⬜ | Maps the method's canonical `inputs` → the Action's params. Same marker syntax as `Fn.impl.with`. |
| `outputMap` | object | ⬜ | Maps the Action's output → the method's canonical `output`. Same marker syntax as `Fn.impl.outputMap`. Omitted ⇒ the Action's raw output is returned as-is. |

### AppDefinition update

Apps grow one new optional field, sibling of `healthChecks` and `triggers`:

```ts
export interface AppDefinition {
  actions:       AnyActionDefinition[];
  auth?:         AuthDefinition[];
  triggers?:     AnyTriggerDefinition[];
  healthChecks?: HealthCheckDefinition[];
  interfaces?:   InterfaceConformance[];       // new
}
```

An app author declares conformance in **`index.ts`**'s `AppDefinition` export — the same file
`healthChecks` and `triggers` are declared in — never in `package.json`'s `w6w` block. That block is
pure identity/presentation data ([`app.md`](./app.md), `Status: Final`, unedited by this document);
an `InterfaceMethodImpl.uses.action` names an Action `key` that exists only on `AppDefinition`, so
there is nowhere else it could live.

## Adapter

`InterfaceMethodImpl.with` and `.outputMap` are resolved by the **identical** mechanism
[Function](./function.md#adapter) specifies: **`resolveWith`**, exported from `@w6w/workflow`, the
`{ "$": … }` / `{ "$expr": … }` object-walker — never `@w6w/expr`'s `evaluate` directly, for the same
reason Function's Adapter section gives (`@w6w/expr` has no mapping-node syntax). A method's
resolution scope carries the same widened roots Function's does — `{ inputs }` for the `with` pass,
`{ inputs, output }` for the `outputMap` pass — populated per-**method** rather than per-Function:
`inputs` is the canonical `InterfaceMethod.inputs` values the caller supplied for that method, and
`output` (on the `outputMap` pass) is the bound Action's raw return value. No new scope root is
introduced; no new marker syntax is introduced.

What the adapter **cannot** express is the same set Function's Adapter section is silent on because
it never needed it: a binary transform (base64 decode/encode) and a shape assertion (is this value
an array or a single object). Both stay a host-transport concern, exactly where the pilot's shipped
`repo-transport.ts` already puts an equivalent `Array.isArray` guard today — see
[Deferred limitations](#deferred-limitations) item (i).

## Consumers

[F-6](../../../.ai/projects/.work/26-08-27-00-connectors/intake.md) already states, precisely, what
each existing consumer binds to and what a new reach kind must present to satisfy it. This section
turns that table into a normative checklist, extended with an **Interface** row: a reach kind is
complete only when every row below is either satisfied or named as a deliberately deferred gap.

| Consumer | What it binds to | Interface status |
|---|---|---|
| **Workflow step** | `Step.uses` — an app Action on a connection, a Function (`{ function: "fn_…" }`), or (via `@w6w/call`) another Callable | **Cannot bind an Interface today.** `Step.uses` has no third arm for an interface method; none is added by this run. This is a named, deferred gap — not an omission. |
| **Function** | exactly one Action via `impl.uses` + `impl.with`, adapted by `resolveWith` | **Trivially satisfied.** `InterfaceMethod.inputs`/`output` already *are* `Param[]`/`Output` — the exact typing `Fn.inputs`/`Fn.output` uses — so nothing new is required for a Function's shape to describe an Interface method; the two are structurally the same contract at different granularities (one method vs. one bundle). |
| **Endpoint** | a `Callable` (`EndpointTarget = Callable \| ActionTarget`) — action / function / workflow | **Cannot bind an Interface today**, for the same structural reason as Workflow step: `EndpointTarget` has no interface arm. Deferred, not omitted. |
| **Alias** | the same target union, plus the `endpoint` arm | **Cannot bind an Interface today** — inherits Endpoint's gap; no alias-level workaround exists. |
| **Health** | `HealthCheck[]` with `covers` selectors | **Free.** An Interface-conforming App still declares its own `healthChecks` exactly as any App does; nothing about conforming to an Interface changes what Health requires or provides. See [Mechanism notes](#mechanism-notes-verified-in-code) for a future `covers` selector this leaves available but unbuilt. |
| **MCP** | the generated tier's R1–R5 rules over apps/actions | **Free.** Every Action an `InterfaceMethodImpl.uses.action` names is an ordinary, already-declared Action on the App — already visible to the generated MCP tier on its own terms. Conforming to an Interface adds no new surface for MCP to reason about. |

The consequence worth stating plainly: **v0 makes Interface a manifest-level and discovery-level
concept only.** A caller can find "which Apps conform to `blob-store@1`" (the registry's
`ListQuery.interface` filter), and a host-side transport can resolve a method binding directly (as
the pilot's repo-file transport does), but no engine-level consumer — Workflow, Endpoint, Alias —
can *target* an Interface method generically yet. Closing that gap is future work, not silently
dropped scope.

## Conformance

A host that implements Interfaces MUST:

- Treat `InterfaceConformance` as an **assertion**, not a verified fact. v0 performs **no**
  structural check — at import time or otherwise — that a declared `InterfaceMethodImpl`'s
  `with`/`outputMap` actually produce the method's declared `inputs`/`output` shape. See
  [Validator posture](#validator-posture) below.
- Resolve `InterfaceMethodImpl.with`/`.outputMap` with `resolveWith` (`@w6w/workflow`), exactly as
  specified in [Adapter](#adapter) — no parallel resolution mechanism.
- Never resolve the invoked App from `InterfaceMethodImpl` — the App is always the one the caller's
  connection names. See [The security reason `uses.app` is absent](#the-security-reason-usesapp-is-absent).
- Permit **partial conformance**: an `InterfaceConformance.methods` map naming a subset of the
  Interface's declared methods is valid; a host MUST NOT require every method to be bound.

### Why conformance is asserted, not host-verified

The concrete case that makes this a considered choice rather than a default: `io.w6w.github`'s
`list` method maps to the `file-get` Action, whose **declared** `output` is unambiguously
single-object-shaped — but GitHub's Contents API actually returns an **array** when the path names a
directory. A host that tried to verify `list`'s `InterfaceMethodImpl` against `file-get`'s declared
output type at import time would have to **reject** this exact, already-shipped, already-correct
mapping. That is not a reason to give up on verification everywhere — it is one vendor's wrinkle
(an Action whose real output shape is conditional on its input, which its own static `output`
declaration cannot express), and this RFC records it as exactly that rather than generalising to "an
Interface can never be verified." A future revision could verify conformance for methods whose bound
Action's output genuinely is static; `list` (and any Action like it) would stay an explicit
exception, not the rule.

### Governance: the interface-id vocabulary

Interface ids are a **closed, host-curated vocabulary** for now. This document's own list —
currently just `blob-store@1` — **is** that vocabulary; there is no registration mechanism, no
submission process, and no code that lets a third-party publisher mint a new interface id into
existence. Flipping to an open namespace later costs a **documentation change**, not a schema or
code change: nothing in this design enforces closedness mechanically (the import-time validator has
no whitelist check against a fixed interface-id list — the same permissiveness described in
[Validator posture](#validator-posture) applies here too). This mirrors `categories`' own closed-list
precedent for a nascent primitive with no registration UX yet, and it is the cheapest thing to
overturn in this whole document if it turns out to be wrong.

### Deferred limitations

Each of the following is a named, considered limitation this run leaves open — not an omission
discovered later:

(i) **The adapter language cannot express binary transforms or shape assertions.** There is no
    base64 decode/encode primitive and no "is this an array or an object" assertion in the
    declarative `with`/`outputMap` marker language. Both therefore stay a **host-transport**
    concern: `get`'s `content` crosses the adapter as base64, exactly as the vendor returned it, and
    `list`'s array-vs-object divergence from `get` (both bind the same Action) is resolved in host
    code, not in the declarative mapping — mirroring the shipped `Array.isArray` guard the pilot's
    transport already performs today, just relocated to the same layer that already had to make that
    call.

(ii) **No string split/join primitive, so a second implementer's coordinate shape is not free.**
     `blob-store@1`'s canonical coordinates are `{ owner, repository }` — GitHub and Gitea's own
     shape, chosen so `io.w6w.github`'s every mapping is a plain field rename. GitLab's REST API
     instead addresses a repository by a single `projectId`. Deriving that from `{ owner,
     repository }` (or the reverse) needs a string-join/split step the adapter language has no
     primitive for. A GitLab implementer therefore needs either a coordinate-normalisation step this
     pilot does not build, or a future adapter-language extension — explicitly out of scope this run,
     not silently glossed over.

(iii) **`delete` requires `expectedSha` unconditionally.** GitHub's Contents API has no
      delete-without-sha operation — it is inherently compare-and-set. Rather than carry a canonical
      signature the one shipped implementer cannot fully satisfy, `blob-store@1`'s `delete` method
      makes `expectedSha` **required**, which is arguably the safer default for any future
      implementer too (an unconditional delete is a sharper footgun than a CAS-guarded one).

(iv) **`put`/`delete` source `commitMessage` from a literal `with` value**, not from any canonical
     input — the contract has no counterpart field (a blob store with no notion of commits has
     nothing to map). `io.w6w.github`'s declaration supplies a constant literal
     (`"w6w interface sync"`), exactly the mechanism `Fn.impl.with` already uses for vendor-specific
     required fields with no canonical source — an ordinary use of the existing mapping mechanism,
     not a new one. Neither `put` nor `delete` is invoked by anything this run's reference consumer
     builds; both are declared on the manifest and stop there.

### Mechanism notes (verified in code)

Two facts about how the existing codebase would need to extend, if a future revision wires an
Interface into either surface below — recorded now so they are found by design, not by surprise:

- **`HealthCheck.covers`'s `resource:` prefix is a validated closed prefix with a free-form
  suffix**, not an open string (`core/packages/validator/src/validate.ts:45,266` —
  `COVERS_PREFIXES = ["action", "resource", "auth", "component"]`, enforced by a `startsWith`
  check). A future `interface:<id>` selector — letting a Health check state "I cover this Interface's
  conformance" — would need `COVERS_PREFIXES` extended with one new entry. Available, unbuilt; not
  needed by anything this run ships (see [Consumers](#consumers)'s Health row).
- **`identityViolations` (`server/packages/api/app-identity.ts`) walks only `manifest.id`, every
  Action's `key`, and every Action's `Param` tree** — it does not walk `interfaces` at all. Any
  future surface that echoes an interface id or a method key back to a caller (an error message, a
  log line, a rendered UI label) **must** extend that walk to cover them, exactly as it already
  covers Action keys and param paths. This is a MUST for whoever builds that surface, not a nicety —
  the whole reason `identityViolations` exists is that these are the only fields a publisher's
  manifest controls the byte content of, and the walk is the one place their safety is enforced.

### Validator posture

The import-time validator (`@w6w/validator`) is **permissive by construction** for this field: it
performs **no** structural check on a `InterfaceConformance` declaration today — not on
`interfaceId`'s value against a known list, not on `methods`' keys against a real `InterfaceSpec`,
not on `with`/`outputMap`'s markers. A malformed declaration — an unknown `interfaceId`, a method key
that doesn't exist on the target Interface, a mapping that resolves to `undefined` at runtime —
registers **silently**. A `validateInterfaces()` pass, mirroring the validator's existing health and
trigger checks, is named here as follow-up work this run does not build.

## Open questions

1. **Should `InterfaceSpec` itself become a loaded, versioned artifact** (like an App manifest) with
   its own registry entry, rather than living only as this document's prose? v0 treats the contract
   text as authoritative and out-of-band; a schema-first `InterfaceSpec` would let a host validate
   conformance structurally instead of asserting it (see [Conformance](#conformance)).
2. **Should `Step.uses`, `EndpointTarget`, and an Alias target each grow an interface arm** — "bind
   to *any* connection satisfying `blob-store@1`" — the way `Step.uses` grew a `{ function }` arm for
   Function? See [Consumers](#consumers). This is the single largest deferred gap in this document.
3. **Should conformance ever be host-verified for the subset of methods whose bound Action has a
   genuinely static output shape**, carving out only the conditional-output case (like `list`) as an
   explicit exception, rather than leaving verification off entirely? See
   [Why conformance is asserted, not host-verified](#why-conformance-is-asserted-not-host-verified).
4. **Should the interface-id vocabulary open up**, and if so, what does a registration process look
   like? See [Governance](#governance-the-interface-id-vocabulary) — pinned closed for now, cheap to
   revisit.
5. **Should a second, GitLab-shaped coordinate convention be added to `blob-store@1`**, or should the
   adapter language grow a split/join primitive instead? See
   [Deferred limitations](#deferred-limitations) item (ii).

## Status ladder

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze.
- `Final` — frozen for the current `manifestVersion`. Breaking changes require a new RFC and a
  `manifestVersion` bump.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.

## Amendment — 2026-08-29: optional `url` on blob-store@1's `get`/`list` output (D-2)

> This section is **additive** to `blob-store@1`'s worked example above; it introduces no breaking
> change. It adds one optional field, `url`, to the two output shapes that name a blob's binary
> content — nothing else about the Interface, the adapter, or `io.w6w.github`'s conformance
> declaration changes. Grepping every passage in this file that states a `get`/`list` output shape
> (`grep -n "encoding\|path, sha\|sha, type" rfcs/interface.md`) finds exactly two hits, both edited
> by this amendment: `:168` (`list` → `[{ path, sha, type, url? }]`) and `:169` (`get` → `{ path,
> sha, content, encoding, url? }`). The rest of the document, including every passage this blockquote
> enumerates, stands unedited.

`url` is **optional** on both `list`'s per-entry shape and `get`'s shape: an implementation with no
natural web URL for a blob simply omits the field, exactly as vendor-neutrality already required for
every other field before this amendment. No App loses conformance by leaving `url` out, and no caller
may assume its presence. A host consuming either output MUST treat `url` as possibly absent —
whatever a host does when it is missing (persist it, fall back, drop it) is that host's own concern,
not this Interface's; see T1.1.1 for the one shipped consumer's handling.

`io.w6w.github` needs **no** change to its conformance declaration (`:183-208`) to supply `url`: it
maps `url` to GitHub's own `html_url` for free, because `list` and `get` both bind `file-get` with no
output field-mapping declared — the raw vendor object, `html_url` included, already passes through
unmapped, exactly as `:178-181`'s prose already explains for the rest of that object's fields.
