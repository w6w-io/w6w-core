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
| `key` | string | ✅ | Machine name. Unique per project/tenant. Lowercase, kebab-case. Preserved across a swap. |
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
