# RFC: Function

**Status:** Draft
**Author:** Segev Shmueli
**Date:** 2026-07-19

## Summary

A **Function** is a named, reusable, **vendor-abstracted single operation** — "Send Email",
"Create Contact", "Charge Card" — that declares a *stable canonical interface* and binds to **one
concrete app [Action](./action.md)** through a *swappable implementation*. The interface
(`inputs`/`output`) reuses core [`Param`](./param.md)`[]`/`Output`; the implementation (`impl`) reuses
the exact `{ uses, with }` shape a workflow [Step](./workflow.md#step) already has. Callers bind to the
interface, never the vendor: switching the underlying provider replaces only `impl` and never breaks a
caller. A Function is usable directly (a single invoke) or as a step inside a
[Workflow](./workflow.md). It sits one level above `Action` — the rebindable indirection the type
system previously had no name for.

## Motivation

The platform has two invocation surfaces and a gap between them:

1. **Ad-hoc single Action** — a caller names *this app's* action with *that app's* param shape
   (e.g. `brevo` / `send-email` with `recipientEmail`/`subjectLine`). This is **vendor-specific**:
   switching to SendGrid forces the caller to change `app`, `action`, and every param key.
2. **Workflow** — a whole DAG of Steps (see the [Workflow RFC](./workflow.md)).

There is no stable, reusable, vendor-independent unit between "one raw app action" and "a whole
workflow." A Function fills exactly that gap:

- A publisher or host operator defines "Send Email" **once**, with a clean canonical param set.
- Every caller — a direct invoke, or a workflow step — binds to that canonical interface.
- When the provider changes (Brevo → SendGrid, or a pricing/deliverability migration), the operator
  swaps `impl` and every caller keeps working unchanged. That vendor-swap durability is the whole
  point: the interface is a contract, the vendor is an implementation detail.

## Goals

- Declare a **canonical interface** — `inputs: Param[]` and an optional `output: Output` — that is
  stable across a vendor swap and reuses the [Param](./param.md) and [Action `output`](./action.md#output)
  primitives verbatim.
- Bind that interface to **one** concrete app Action via a **swappable `impl`** that reuses the
  workflow [Step](./workflow.md#step)'s `{ uses, with }` shape (`impl.uses`, `impl.with`) plus an
  `impl.outputMap` that maps the action's output back to the canonical `output`.
- Pin the **adapter**: `impl.with` / `impl.outputMap` are resolved by **`resolveWith`** from
  `@w6w/workflow` against a **widened [`RunScope`](./workflow.md#expression-markers)** carrying
  `inputs` (and `inputs` + `output` for `outputMap`) — *not* by `@w6w/expr` directly.
- State the **vendor-swap invariant**: swapping `impl` preserves `id`, `key`, and `inputs`.
- Define the **workflow-composition hook**: a Step may target a Function via `Step.uses.function`,
  classified as [`NodeKind: "function"`](./node-types.md).
- Be **serialization-agnostic** — JSON renderings are illustrative, not the format.

## Non-Goals

The following are explicit v0 boundaries. Each is modeled so it can grow later without a breaking
change.

- **Multiple implementations.** v0 carries a **single active `impl`** per Function. Primary + fallback
  or A/B routing is deferred; the shape is chosen so `impl` can become a list later without breaking
  existing definitions. (See [Open questions](#open-questions).)
- **Nesting.** `impl` targets an **app Action only** — never another Function or a Workflow. Cross-
  Callable indirection is an [Endpoint](./endpoint.md) concern, not a Function one.
- **Function-run history.** There is **no `function_runs` record** in v0. A Function invocation is a
  single Action call already metered and logged by the host's `invokeAction` choke point; Function-
  level replay/observability parity with workflow runs is deferred.
  This description is the **action arm**'s metering path (see the
  [Amendment — 2026-08-20](#amendment--2026-08-20-impl-may-target-a-function-or-a-workflow-d-8)
  below). A callable arm's invocation is metered by whatever choke point the invoked Function or
  Workflow itself already goes through — no separate `function_runs` record is added for either arm.
- **Execution runtime, credentials, and the sandbox** — owned by the [Invocation](./invocation.md) /
  runtime path the adapter funnels into. A Function never sees raw credentials.
- **The expression language itself** — operators, coercion, path semantics — is specified by
  `@w6w/expr` (JSONLogic-based). This RFC pins only the two-marker convention and the scope shape it
  resolves against.
- **Endpoints, exposure, and the `Callable` contract** — the callable entry point that may front a
  Function or a Workflow lives in the [Endpoint RFC](./endpoint.md).

## Concept

A Function is a **canonical interface bound to one swappable implementation**. Two halves:

1. **The stable interface** — `inputs` (a [`Param`](./param.md)`[]`) and an optional `output` (an
   [Action-style `Output`](./action.md#output)). This is what a caller sees and binds to. It uses the
   platform's existing form/output primitives so every tool that renders an Action's params can render
   a Function's `inputs` with no new machinery.

2. **The swappable implementation** (`impl`) — names one concrete app Action (`impl.uses`), maps the
   canonical `inputs` onto that action's params (`impl.with`), and maps the action's output back onto
   the canonical `output` (`impl.outputMap`). `impl.uses` is exactly the workflow
   [Step](./workflow.md#step)'s `{ app, action, connection? }` triple.

```
caller ── binds to ──►  inputs / output   (STABLE — survives a vendor swap)
                              │
                          impl (SWAPPABLE)
                              │
              impl.with ──► app Action params ──► invoke ──► action output ──► impl.outputMap
```

### The vendor-swap invariant

Switching provider = **replace only `impl`** (a new `uses`, a new `with`, a new `outputMap`). The
Function's `id`, `key`, `inputs`, and `output` are unchanged. Because callers reference the Function by
`id` and bind to `inputs`/`output`, every caller — the direct-invoke path and any workflow step that
references the Function — is untouched by the swap. A conforming host MUST reject a swap (or version it)
if it would alter `id`, `key`, or the `inputs` contract, since that would break existing callers; a
provider migration only ever rewrites `impl`.

### Invocation

*(This section describes the **action arm**'s invocation flow. See
["Invocation — the callable arm"](#invocation--the-callable-arm) below for the Function/Workflow
arms added by [Amendment — 2026-08-20](#amendment--2026-08-20-impl-may-target-a-function-or-a-workflow-d-8).)*

A Function invocation is a **single Action call** wrapped by two expression adapters — inbound
(`impl.with`) and outbound (`impl.outputMap`). The host resolves the definition, maps the caller's
canonical `inputs` to the action's params, calls the existing single-Action invoke path, then maps the
result back to the canonical `output`:

```
invokeFunction(functionId, inputs):
  fn      = load(functionId)
  params  = resolveWith(fn.impl.with, scopeWith(inputs))              // canonical inputs → action params
  output  = invokeAction({ app: fn.impl.uses.app,
                           action: fn.impl.uses.action,
                           connection: fn.impl.uses.connection,
                           params })                                  // the existing single-Action path
  return  fn.impl.outputMap
            ? resolveWith(fn.impl.outputMap, scopeWith(inputs, output))
            : output
```

No credentials, source refs, or sandbox are touched here — the underlying single-Action invoke path
already owns connection resolution, entitlement, credential injection ([Auth](./auth.md) `sign`),
metering, and the runtime sandbox (see the [Invocation RFC](./invocation.md)). A Function is
**composition, not a new engine**.

### Invocation — the callable arm

*(Added by [Amendment — 2026-08-20](#amendment--2026-08-20-impl-may-target-a-function-or-a-workflow-d-8);
the action-arm flow above is unchanged.)*

When `impl` is a callable arm (`kind: "function"` or `"workflow"`; `isCallableImpl(fn.impl)` is
`true`), invocation never calls `invokeAction`. Instead the host invokes the referenced Callable
through the same machinery
[`ctx.invokeCallable`](./invocation.md#amendment--2026-07-23-the-ctxinvokecallable-seam-f-3) funnels
into for the [`@w6w/call` node](./node-types.md#amendment--2026-07-23-the-w6wcall-host-node-f-3): a
`{kind:"function"}` target resolves synchronously via a nested `invokeFunction` call; a
`{kind:"workflow"}` target is driven to a terminal result via the Workflow run path. That result
becomes this Function's raw `output`, passed through `impl.outputMap` (when present) exactly as the
action arm's raw Action output is. See [Conformance](#conformance) for the binding MUST.

## Shape

```jsonc
{
  "manifestVersion": "2",
  "id": "fn_send-email",
  "key": "send-email",
  "displayName": "Send Email",
  "description": "Send a transactional email through the configured provider.",

  // ── The STABLE interface. Callers bind to this; it survives a vendor swap. Reuses core Param[]. ──
  "inputs": [
    { "key": "to",      "label": "To",      "type": "string", "required": true },
    { "key": "subject", "label": "Subject", "type": "string", "required": true },
    { "key": "body",    "label": "Body",    "type": "text",   "required": true }
  ],
  "output": [
    { "key": "messageId", "type": "string", "label": "Message ID" }
  ],

  // ── The SWAPPABLE implementation. Same `{ uses, with }` shape as a workflow Step. ──
  "impl": {
    "uses": { "app": "io.w6w.brevo", "action": "send-email", "connection": "conn_01H…" },
    "with": {                                     // canonical inputs → Brevo's action params
      "recipientEmail": { "$": "inputs.to" },
      "subjectLine":    { "$": "inputs.subject" },
      "htmlContent":    { "$": "inputs.body" }
    },
    "outputMap": { "messageId": { "$": "output.id" } }   // Brevo's action output → canonical output
  }
}
```

**Switching Brevo → SendGrid** replaces only `impl`:

```jsonc
"impl": {
  "uses": { "app": "io.w6w.sendgrid", "action": "send-mail", "connection": "conn_02K…" },
  "with": {
    "personalizations": [ { "to": [ { "email": { "$": "inputs.to" } } ] } ],
    "subject": { "$": "inputs.subject" },
    "content": [ { "type": "text/html", "value": { "$": "inputs.body" } } ]
  },
  "outputMap": { "messageId": { "$": "output.headers.x-message-id" } }
}
```

`inputs`, `output`, `id`, and `key` are identical across both. Every caller is untouched.

### Field reference

#### Fn

| Field | Type | Required | Description |
|---|---|---|---|
| `manifestVersion` | string | ✅ | Core spec version. `"2"`, aligned with the [Workflow RFC](./workflow.md). |
| `id` | string | ✅ | Host-issued opaque id (`fn_…`). Stable across renames **and vendor swaps**. |
| `key` | string | ✅ | Machine name. Matches `/^[a-z][a-z0-9-]{2,38}/` (lowercase-first, then lowercase letters/digits/hyphens, no `--` anywhere, no trailing `-`; `_` illegal). Unique per `(account, key)`, enforced by a **total** unique index (a Function always has a `key`). Validated against the grammar only on the Function's first save (the row is new); never re-checked on a later save. Lowercase, kebab-case. Preserved across a swap. See [Amendment — 2026-09-02: the `key` field's grammar, uniqueness scope, and validation timing](#amendment--2026-09-02-the-key-fields-grammar-uniqueness-scope-and-validation-timing). |
| `displayName` | string | ⬜ | Human-facing name (e.g. "Send Email"). Falls back to `key`. |
| `description` | string | ⬜ | One-line summary. |
| `inputs` | [`Param`](./param.md)`[]` | ✅ | The **canonical interface**. Reuses the Param RFC verbatim — same types, hooks, validation. Preserved across a swap. |
| `output` | [`Output`](./action.md#output) | ⬜ | Canonical output shape (`OutputField[]` or a dynamic `{ source }` hook), reusing the Action RFC's `output`. Downstream callers map fields from it. |
| `impl` | [`FnImpl`](#fnimpl) | ✅ | The **swappable implementation**. The only part a vendor swap rewrites. |

> **Naming note.** `Function` shadows the JS global, so the code-level type is exported as **`Fn`**
> (aliased in the barrel); the word "Function" surfaces only in UI, DB, and this RFC. The logical
> primitive's name is *Function*.

#### FnImpl

| Field | Type | Required | Description |
|---|---|---|---|
| `uses` | object | ✅ | `{ app, action, connection? }` — the same triple a workflow [Step](./workflow.md#step) uses to name an [Invocation](./invocation.md) target. |
| `uses.app` | string | ✅ | App id (registry-resolved). |
| `uses.action` | string | ✅ | Action `key` within the app. |
| `uses.connection` | string \| null | ⬜ | Connection id. Required when the action's app declares auth and the action doesn't opt out with `requiresAuth: false`. |
| `with` | object | ⬜ | Maps canonical `inputs` → the action's params. Each value is a literal or an expression marker (see [Adapter](#adapter)). Resolved against a scope carrying `inputs`. |
| `outputMap` | object | ⬜ | Maps the action's output → the canonical `output`. Same marker syntax, resolved against a scope carrying `inputs` **and** `output`. Omitted ⇒ the action's raw output is returned as-is. |

> **Note:** "Required" (✅) above describes what a **valid, runnable** FnImpl needs — it is not a
> storage-time constraint. A host may persist a FnImpl (and a Function containing it) as an
> incomplete draft, e.g. with `uses.app`/`uses.action` unset. A separate computed validity signal
> or a publish/invoke-time gate is what enforces runnability, not storage rejection.

## Adapter

`impl.with` and `impl.outputMap` are resolved by **`resolveWith`** exported from **`@w6w/workflow`**
(the engine's `{ "$": … }` / `{ "$expr": … }` object-walker) — **not** by `@w6w/expr` directly.

This distinction is load-bearing. `@w6w/expr` is a pure **JSONLogic** evaluator (`evaluate(logic,
data)`); it does *not* understand the `{ "$": "inputs.to" }` / `{ "$expr": … }` **mapping-node**
syntax and has no object-walker. The walker that resolves a whole `with` block is the engine's
`resolveWith` / `resolveValue`, which calls `@w6w/expr`'s `evaluate` under the hood for each marker.
A host that called `@w6w/expr.evaluate` on `impl.with` directly would **not** get the mapping
semantics this RFC specifies. The adapter is therefore a `@w6w/workflow` concern.

### The widened `RunScope`

`resolveWith(withBlock, scope)` is typed `scope: RunScope`, where the workflow
[`RunScope`](./workflow.md#expression-markers) is `{ vars, steps, trigger, … }`. Path sugar
`{ "$": "inputs.to" }` resolves against the scope root, so it returns `undefined` unless **`inputs`
is a top-level key of that root**. The base `RunScope` has no `inputs` (nor `output`) key.

To serve the Function adapter, `RunScope` is **widened** with two optional roots:

```ts
interface RunScope {
  vars:    Record<string, unknown>;
  steps:   Record<string, { output: unknown }>;
  trigger: { type: string; event?: unknown };
  inputs?: Record<string, unknown>;   // NEW — the Function's canonical inputs
  output?: unknown;                    // NEW — the bound action's raw output (outputMap only)
}
```

The two adapter passes therefore resolve against:

| Pass | Scope roots populated | Resolves |
|---|---|---|
| `impl.with` | `{ inputs }` | canonical `inputs` → the action's params |
| `impl.outputMap` | `{ inputs, output }` | the action's raw `output` (and `inputs`) → the canonical `output` |

`{ "$": "inputs.subject" }` reads the caller's canonical input; `{ "$": "output.id" }` in `outputMap`
reads the bound action's return value. The widening lives in `@w6w/workflow` so `resolveWith` stays a
single shared adapter across workflow steps and Functions. **No ambient `secrets` / `connection`
access** is exposed to the adapter in v0 — the scope carries only `inputs` (and `output`).

## Workflow composition

A workflow [Step](./workflow.md#step) may target a Function instead of a raw app Action. `Step.uses`
becomes a discriminated union:

```ts
type StepUses =
  | { app: string; action: string; connection?: string | null }   // existing — a raw Action
  | { function: string };                                          // NEW — invoke a Function (fn_…)
```

Such a **function-step** is classified as [`NodeKind: "function"`](./node-types.md) (a new kind
alongside `"app"`, `"control"`, `"internal"`, `"trigger"`), and `classifyNode` gains the `"function"`
branch. Execution:

1. The engine resolves `step.with` against the workflow run scope `{ vars, steps, trigger }` → the
   Function's **canonical inputs**.
2. It calls a new host capability **`ctx.invokeFunction({ function, inputs, stepId })`** — a sibling
   of `ctx.invoke` on [`WorkflowContext`](./workflow.md#host-contract--workflowcontext) — wired
   host-side to the Function invoke choke point.
3. The returned canonical output becomes the step's `output`, visible to downstream
   `{ "$": "steps.<id>.output.…" }` expressions.

The engine stays **host-free**: it never loads a Function, resolves a connection, or touches the
sandbox — it asks `ctx`. This mirrors how a normal step never sees credentials and asks `ctx.invoke`.

## Conformance

A host that implements Functions MUST:

- Preserve `id`, `key`, and `inputs` across an `impl` swap — a swap that would alter any of them is
  rejected (or forces a new Function), so existing callers never break.
- Resolve `impl.with` with **`resolveWith`** (`@w6w/workflow`) against a `RunScope` whose `inputs`
  root is the caller's canonical inputs, and resolve `impl.outputMap` (when present) against a scope
  whose `inputs` and `output` roots are the canonical inputs and the bound action's raw output.
- Route the resolved params through the same single-Action invoke path used for ad-hoc Action calls —
  no parallel credential, source, or sandbox path.
- **The bullet above is scoped to the action arm** (`kind` absent or `"action"`; `FnActionImpl`) —
  see [Amendment — 2026-08-20](#amendment--2026-08-20-impl-may-target-a-function-or-a-workflow-d-8).
  For a callable arm (`kind: "function"` or `"workflow"`; `FnCallableImpl`), a host MUST instead
  invoke the referenced Callable through the machinery
  [`ctx.invokeCallable`](./invocation.md#amendment--2026-07-23-the-ctxinvokecallable-seam-f-3) funnels
  into — a nested `invokeFunction` call for a `{kind:"function"}` target, or a Workflow run driven to
  a terminal result for a `{kind:"workflow"}` target — and MUST NOT call `invokeAction` for this arm.
  No parallel credential, source, or sandbox path for the callable arm either; see
  ["Invocation — the callable arm"](#invocation--the-callable-arm).
- Classify a `Step` whose `uses` is `{ function }` as `NodeKind: "function"` and execute it via
  `ctx.invokeFunction`, never by loading the Function inside the engine.

## Open questions

1. **Multi-impl.** Should `impl` become a list (primary + fallback, or A/B) instead of a single active
   implementation? v0 is single; the shape is chosen to allow a list later without a breaking change.
2. **Function observability.** Rely on the underlying Action's metering, or add a `function_runs`
   record for history/replay parity with workflow runs? v0 relies on Action-level metering.
3. **Upstream to `core` `manifestVersion: "2"`.** Function is a clean OSS spec primitive like
   [Action](./action.md); the code-level types start in `@w6w/workflow-types` and are extraction
   candidates for `@w6w/types` once stable — the path Workflow/Run took.
4. **Nesting.** Should `impl` ever target another Function or a Workflow rather than only an app
   Action? v0 says no — use an [Endpoint](./endpoint.md) for cross-Callable indirection.

## Status ladder

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze.
- `Final` — frozen for the current `manifestVersion`. Breaking changes require a new RFC and a
  `manifestVersion` bump.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.

## Amendment — 2026-08-20: `impl` may target a Function or a Workflow (D-8)

> **This section REVERSES two passages of this RFC, by name: Non-Goal "Nesting" (`:61-62`) and
> Open question 4 "Nesting" (`:338-339`). Both said `impl` targets an app Action only — never
> another Function or a Workflow — and that v0's answer to nesting was no. D-8 changes that answer:
> `impl` may now target a Function or a Workflow, exactly as `Endpoint.target` already does, via the
> same [`Callable`](./endpoint.md#callable) union.**
>
> **Round 2 addendum.** Three further passages stated the reversed rule **as fact**, not merely
> descriptively, and are RECONCILED below (each per-arm, by appending — no deletion): the
> Function-run-history Non-Goal's justification clause (`:63-64`), the "Invocation" section's topic
> sentence (`:115`, originally `:107` before this addendum's own insertions shifted it), and the
> Conformance section's "Route the resolved params…" MUST bullet (`:315-316`, originally `:292-293`
> — the most severe, being normative). Each is marked RECONCILED in the list below, distinct from
> the DESCRIPTIVE entries, which needed no change because they never asserted the rule as
> universally true — see each entry for what was added and where.
>
> The enumeration is a grep, not memory:
> `/usr/bin/grep -n -i "app Action only\|never another Function\|Nesting\|only an app Action\|one
> concrete app Action" rfcs/function.md` finds exactly three hits **on the base tree / pre-amendment
> text**: `:61` (the Non-Goal reversed above), `:83` (Concept item 2, "names one concrete app Action"
> — descriptive, see below), and `:306` (the Open question reversed above — now at `:338` in the
> current file, shifted by this amendment's own prior insertions; see the Round 2 addendum above).
> Every other passage that still *reads* action-only, but wasn't caught by that literal-phrase grep,
> is enumerated here too. Most are
> **descriptive of the action arm**, not a rule this amendment repeals — before this amendment there
> was only one arm, so a sentence describing "the implementation" was necessarily describing the
> action arm; it was never a statement that ruled out other arms, because at the time there were
> none to rule out. Three (marked RECONCILED) stated it as an unconditional fact and needed an
> explicit per-arm qualification, appended below their original text:
> - `:11-12` — DESCRIPTIVE. Summary: "binds to **one concrete app [Action]** … through a swappable
>   implementation."
> - `:34` — DESCRIPTIVE. Motivation: the provider-swap sentence ("the operator swaps `impl`…").
> - `:42-44` — DESCRIPTIVE. Goals: "Bind that interface to **one** concrete app Action via a
>   swappable `impl`…"
> - `:63-64` — **RECONCILED.** Non-Goals, "Function-run history": "A Function invocation is a
>   single Action call already metered…" A qualifying continuation is appended directly below
>   (`:66-69`): the action arm's metering path is unchanged; a callable arm is metered by whatever
>   choke point the invoked Function or Workflow already goes through.
> - `:87-89` (originally `:83-85`) — DESCRIPTIVE. Concept item 2: "names one concrete app
>   Action (`impl.uses`)…"
> - `:92-107` (originally `:91-103`) — DESCRIPTIVE. the composition diagram and "The vendor-swap
>   invariant" section (both talk in terms of `uses`/`with`/`outputMap`, the action arm's own
>   field names).
> - `:115` (originally `:107`) — **RECONCILED.** "Invocation"'s topic sentence: "A Function
>   invocation is a **single Action call**…" A scoping note is appended immediately above it
>   (`:111-113`) pointing at the new ["Invocation — the callable arm"](#invocation--the-callable-arm)
>   subsection appended after the pseudocode, which states the callable arm's own flow.
> - `:116-136` (originally `:108-121`, extended) — DESCRIPTIVE. "Invocation"'s pseudocode (which
>   calls `invokeAction` unconditionally) plus its trailing "No credentials, source refs, or sandbox
>   are touched here — the underlying single-Action invoke path…" paragraph (`:133-136`, also
>   hyphenated `single-Action` at `:117`/`:127`/`:133`, same grep family). Both remain the action
>   arm's own flow, unedited — covered end-to-end by the `:111-113` scoping note above the whole
>   "### Invocation" section, not individually qualified line-by-line.
> - `:173-189` (originally `:150-166`) — DESCRIPTIVE. the Shape example's
>   `"impl": { "uses": …, "with": …, "outputMap": … }` block.
> - `:215` (originally `:192`) — DESCRIPTIVE. the `Fn` field-reference table's `impl` row.
> - `:221-236` (originally `:198-213`) — DESCRIPTIVE. the `FnImpl` field-reference table (now
>   `FnActionImpl`'s table — see below).
> - `:272-273` (originally `:249-250`) — DESCRIPTIVE. the adapter-pass table (`impl.with` /
>   `impl.outputMap`).
> - `:308-314` (originally `:285-291`) — DESCRIPTIVE. Conformance's `impl.with`/`impl.outputMap`
>   bullets (the `id`/`key`/`inputs`-preservation and `resolveWith`-resolution bullets).
> - `:315-316` (originally `:292-293`) — **RECONCILED, most severe (normative).** Conformance:
>   "Route the resolved params through the same single-Action invoke path… no parallel credential,
>   source, or sandbox path." A new bullet is appended directly below (`:317-325`) scoping this one
>   to the action arm by name and stating the callable arm's own MUST: invoke the referenced
>   Callable through the `ctx.invokeCallable` machinery, never `invokeAction`.
>
> Every DESCRIPTIVE entry continues to hold **for the action arm**, unedited, and none is excluded
> from that reading. Every RECONCILED entry keeps its original text byte-for-byte (0 deletions) and
> gains an adjacent per-arm qualification. The rest of this RFC, outside the passages enumerated
> above and this amendment, stands unedited.

### The reversal

`impl` is no longer bound to a single arm. It becomes a **`kind`-discriminated union** with three
arms: the historical app-Action arm (now named `FnActionImpl`), plus two new arms reusing the
[Endpoint RFC's `Callable`](./endpoint.md#callable) union **verbatim** — the same reference
`Endpoint.target` and [`@w6w/call`'s `target`](./node-types.md#amendment--2026-07-23-the-w6wcall-host-node-f-3)
already use:

```ts
/** The app-Action arm — the historical shape. `kind` is ABSENT on every Function stored before
 *  this union existed, and absent MEANS "action". */
interface FnActionImpl {
  kind?: "action";
  uses: { app: string; action: string; connection?: string | null };
  with?: Record<string, unknown>;
  outputMap?: Record<string, unknown>;
}

/** The Function / Workflow arms — `Callable` reused verbatim, carrying the same two adapter maps
 *  the action arm has. */
type FnCallableImpl = Callable & {
  with?: Record<string, unknown>;
  outputMap?: Record<string, unknown>;
};

type FnImpl = FnActionImpl | FnCallableImpl;
```

- **`kind` is optional on the action arm, and its absence MEANS `"action"`.** Every Function stored
  before this union existed has `impl: { uses: {...} }` with no `kind` at all. Making `kind`
  required on that arm would need a data migration over every stored `definition` blob; this
  amendment ships without one, so `kind` stays optional and absence resolves to `"action"`.
- **`outputMap` survives on the action arm, unchanged.** `FnImpl` is deliberately NOT written as
  `Callable | ActionTarget`: `Callable` (the union `Endpoint.target`'s Function/Workflow arms use)
  never carried `outputMap`, so folding the action arm into it verbatim would drop the field. The
  historical `uses`/`with`/`outputMap` shape stays its own arm, `FnActionImpl`.
- **A Function arm resolves synchronously; a Workflow arm is driven to a terminal result.** A
  Function's contract is "always returns a value" (see [Concept](#concept)), so there is no `wait`
  toggle here the way `@w6w/call`'s `target` has one — the invocation mode is fixed by `kind`, not
  chosen per-call.
- The discriminator every consumer branches on is one helper, `isCallableImpl(impl): impl is
  FnCallableImpl`, returning `true` iff `impl.kind === "function" || impl.kind === "workflow"` —
  never a hand re-derived check.

## Amendment — 2026-08-20b: `retry`, `onError`, and `reroute`

> The [Field reference](#field-reference) `Fn` table above is **silent** on failure handling — no
> row states what a caller sees when the bound implementation throws. This section fills that gap,
> additively: three new optional fields on `Fn`, none of them removing or retyping a row already in
> that table.

`Fn` gains:

| Field | Type | Required | Description |
|---|---|---|---|
| `retry` | `RetryPolicy` | ⬜ | Attempt policy for this call. Absent ⇒ one attempt. Reuses the workflow [Step](./workflow.md#step)'s `RetryPolicy` verbatim (`maxAttempts`, `backoff?`, `delayMs?`). |
| `onError` | `"fail" \| "continue"` | ⬜ | Applied only after `retry` and `reroute` are exhausted. Absent ⇒ `"fail"`. Deliberately **narrower** than a workflow step's `OnError`: `continue-record` has no meaning without a run's `stepErrors` state. |
| `reroute` | `ErrorReroute` | ⬜ | Failure re-dispatch: `{ target: Callable, with? }`. Absent ⇒ none. `target` is a [`Callable`](./endpoint.md#callable) reference — never an `Edge.when: "error"`, because a Function has no graph to carry an edge on. |

**Execution order**, the sequence a conforming host (and the engine, T1.x) implements:

1. Attempt the call, up to `retry.maxAttempts` times (default `1` — no retry).
2. On final failure, if `reroute` is present: invoke `reroute.target` — mapping `{ inputs, error }`
   onto its inputs through `reroute.with` if given, or passing `inputs` through unchanged otherwise
   — and return **that** target's output as the call's own output. `retry` is not re-applied to the
   reroute target itself.
3. Otherwise, apply `onError`: `"fail"` (the default) propagates the error, exactly as today;
   `"continue"` resolves the call with a `null` output instead of throwing.

This same shape and order is added to [`Endpoint`](./endpoint.md#field-reference) by the companion
amendment there, since an Endpoint has the identical no-graph constraint on `reroute`.

## Amendment — 2026-09-02: the `key` field's grammar, uniqueness scope, and validation timing

> This section is **additive** to the [Fn](#fn) field table above; it introduces no breaking
> change, no new field, and no change to `key`'s requiredness. It replaces the stale "Unique per
> project/tenant" scope the `key` row (`:210`) carried, with the grammar and validation-timing rules
> the implementation has always followed but this RFC never wrote down. It is the companion to
> [Workflow's own `key`
> amendment](./workflow.md#amendment--2026-09-02-the-workflow-key-field) (D-4): the two RFCs state
> the same three rules — grammar, `(account, key)` uniqueness, first-assignment-only validation — so
> a reader of either comes away with the same rule at the same fidelity. The one difference between
> them is `key`'s **requiredness**, which this amendment does not change: a Function's `key` is
> required (unchanged, above), because a Function is always addressed by it; a Workflow's `key` is
> optional, because a Workflow is addressed by neither `name` nor `key`.

**Grammar.** `key` matches `/^[a-z][a-z0-9-]{2,38}/` — a lowercase letter first, lowercase
letters/digits/hyphens after, 3 to 39 characters — plus two rules the regex alone does not express:
no `--` anywhere, and no trailing `-`. `_` is deliberately illegal; it is not a legal DNS label
character. This is the same `isAccountSlug` grammar [Workflow's optional
`key`](./workflow.md#amendment--2026-09-02-the-workflow-key-field) uses.

**Uniqueness — `(account, key)`, total.** A host MUST enforce uniqueness on `(account, key)`,
exactly as [Endpoint's `(account, key)` rule](./endpoint.md#an-endpoint-belongs-to-the-account)
does, and refuse a colliding save as a caller-visible conflict. Because a Function always has a
`key` — unlike Workflow's optional one — the enforcing index is **total**, not partial: no row is
ever exempt.

**Validated once, on the Function's first save.** The grammar is checked only when the Function row
is first created (`!previous` — there is no earlier row to have already validated), never re-checked
on a later save. A value that is already stored can never be made un-saveable by a later tightening
of the grammar. This differs in *mechanism*, not in *rule*, from Workflow's own timing: a Function's
creation and its first `key`-assignment are the same moment (a Function always has a `key`), so
gating on "the row is new" and gating on "the stored key is null" pick out the identical instant for
a Function. Workflow needs the null-check specifically because its two moments can differ — `key`
starts absent and may be assigned later.

### Conformance (additive)

A host that implements this amendment MUST:

- Enforce `key`'s grammar — `/^[a-z][a-z0-9-]{2,38}/`, no `--`, no trailing `-` — only on the
  Function's first save.
- Enforce `(account, key)` uniqueness with a **total** unique index, refusing a colliding save as a
  caller-visible conflict.
- Never re-validate a stored `key` against the grammar on a later save that does not itself change
  `key`.
