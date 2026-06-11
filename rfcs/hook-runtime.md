# RFC: Hook Runtime

**Status:** Final
**Author:** Segev Shmueli
**Date:** 2026-06-01

## Summary

A **Hook Runtime** is the contract the platform offers to publisher-authored code. Action `execute`, Param `options.source` and `validation.hook`, Action `output.source`, Auth `sign`/`exchange`/`refresh`/`revoke`/`test`/`preflight`/`afterConnect` — every hook in the spec — runs against the same module format, ambient API, error shape, timeout policy, and sandbox posture.

This RFC defines that runtime once so the other RFCs can reference it instead of redefining the cross-cutting parts per hook.

## Motivation

Action, Auth, and Param each declare hooks. They each leave "how the hook actually executes" to a future runtime RFC. That gap is now load-bearing: the reference implementation has shipped a sandbox, a fetch proxy, a credential-isolation model, and a default error envelope, and every other RFC implicitly depends on those choices. Without a Hook Runtime RFC, hosts that want to claim spec compliance have no testable surface — and publishers writing portable apps have no contract.

A single Hook Runtime RFC means:

- One module format. One ambient API. One error shape. Portable across compliant hosts.
- The per-hook RFCs (Action, Auth, Param) define *what* the hook is for; this RFC defines *how* it runs.
- The reference implementation in `@w6w/runtime` becomes a conformance target, not the de-facto spec.

## Goals

- Define the **module format** a hook file is published as.
- Define the **ambient API** (`HookContext`) every hook receives.
- Define the **per-hook type registry** so publishers get publish-time type-checking.
- Define the **error shape** for hook failures and how phases propagate.
- Define **timeouts**, **cancellation**, and **resource limits**.
- Define the **sandbox posture** — what hooks can and cannot do.
- Define **credential isolation**: which hook ever sees the live credential, and the runtime invariants that guarantee it cannot leak.

## Non-Goals

- Specifying *which* sandbox technology a host uses (Deno Worker, V8 isolate, Wasm, container). The contract is observable behavior, not implementation.
- Specifying the storage of hook source code, transport, signing, or distribution — host concerns.
- Replacing the per-hook semantics defined in Action/Auth/Param/Connection.

## Module format

A hook is a value addressable from an App's entry module. There are two equivalent ways to surface it; a compliant host MUST accept both.

### A. Path reference (declarative manifests)

The legacy form used by the per-RFC examples. Configuration declares a path; the runtime imports the file at that path and uses its default export.

```json
"execute": "./actions/send-message.ts"
```

```ts
// ./actions/send-message.ts
export default async function (input, ctx) { /* ... */ }
```

### B. Co-located function (code-first apps)

The form the reference implementation uses. The hook is a property on an Action/Auth object exported from the app's entry module.

```ts
// ./index.ts — the entry module
import type { AppDefinition } from "@w6w/types";

const app: AppDefinition = {
  actions: [
    {
      key: "send-message",
      type: "perform",
      title: "Send Message",
      params: [/* ... */],
      execute: async (input, ctx) => { /* ... */ },
    },
  ],
};
export default app;
```

Both forms are logically equivalent. The runtime resolves either to a callable of the same signature and invokes it under the same contract.

### Language

A hook MUST be loadable as an **ES module** by the runtime. The reference runtime is Deno-based and accepts TypeScript and JavaScript source modules directly. WASM as a hook target is a non-goal for `manifestVersion: "1"`; it may be layered on later without breaking change because the function signature is data-shaped (plain serializable input/output).

## Ambient API: `HookContext`

Every hook receives two arguments — a per-hook `input` and an ambient `ctx`. The `input` shape is fixed by the hook kind (see [Hook registry](#hook-registry)). The `ctx` is the same shape for every hook:

```ts
interface HookContext {
  /** Web Fetch, mediated by the host (egress allowlist + signing). */
  fetch: typeof fetch;

  /** Structured log line routed back to the host. */
  log: (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    data?: unknown,
  ) => void;

  /** Redacted Connection projection, when one was supplied. Never carries the credential. */
  connection?: RedactedConnection;

  /** Read-only, host-issued metadata about this call. Pure data, never an authority. */
  invocation?: InvocationContext;

  /** Non-portable, host-provided capabilities. Empty in core; hosts augment it. See [Host extensions](#host-extensions). */
  host?: HostExtensions;
}
```

### `ctx.fetch`

The hook's only network primitive. The host:

1. Resolves the URL's host against the App's `network.allow` allowlist (App RFC). Hosts not on the list reject with `egress_denied`.
2. For action `execute`: passes the request through the App's Auth `sign` hook before the actual fetch. The action never holds the credential.
3. For `refresh` / `exchange` / `preflight`: performs the request without signing (the hook itself is constructing the credential).
4. For `sign` itself: `ctx.fetch` is **not available** — see [Credential isolation](#credential-isolation).

The hook sees a normal `Response`. The credential and the egress check are the host's job.

### `ctx.log`

Lines are structured: `{ level, message, data? }`. Hosts MUST surface these to the operator (typically into the Run's step log, per the future Run RFC). Hooks SHOULD NOT log the credential or any field they were given through `connection`'s redacted projection that would round-trip to a credential — but the runtime cannot enforce this on its own and treats log payloads as untrusted operator-visible text.

### `ctx.connection`

The redacted Connection projection (Connection RFC §Redacted projection). Present when the Invocation supplied one. The `credential` field is always absent. Hooks that need the credential (`sign`, `refresh`, `revoke`) receive it in their `input` instead.

### `ctx.invocation`

The Invocation's `context` ([Invocation RFC](./invocation.md)) — read-only, host-issued metadata, never an authority. `invocationId` is stable per Invocation: use it as an **idempotency key** for `perform` actions (e.g. an `Idempotency-Key` header) so a retried call doesn't double-write. `runId`/`stepId` correlate the hook's `ctx.log` lines and downstream requests back to the Run that drove them. `trigger` (`workflow | editor | api | replay | test`) lets an action soften real side-effects under `editor`/`test` previews. Present for action `execute` (populated from the Invocation's `context`); absent for standalone auth-phase hooks, which are not driven by an Invocation. It carries **no** credential and grants **no** capability, and being plain data it crosses the worker boundary unchanged.

### `ctx.host`

The extension point for **host-specific** capabilities. It is **empty in the reference runtime** — a host adds capabilities to it for its own apps (see [Host extensions](#host-extensions)). Anything a hook reads from `ctx.host` makes the app **non-portable**: it runs only on hosts that provide the same extension. Host extensions are still bound by [credential isolation](#credential-isolation) — they MUST be host-mediated.

### What `ctx` does NOT carry

The runtime intentionally exposes no:

- Environment variables, process info, host config.
- Direct filesystem access. Read-scope is limited to the app directory; in practice hooks should use module imports, not `fs`.
- Cryptographic / random / time primitives beyond what the host language provides natively (`globalThis.crypto`, `Date.now()`).
- Inter-hook persistence. A hook is a pure function over `(input, ctx)`.

The **core** capabilities (`fetch`, `log`, `connection`, `invocation`) are a **closed list**: a new *portable* capability is added only by amending this RFC. A host that needs a capability of its own does not invent a new top-level `ctx` field — it adds it under [`ctx.host`](#host-extensions), where the non-portability is explicit.

## Host extensions

A host MAY expose capabilities beyond the core set to **its own apps** — e.g. a fetch to internal services with the host's own tokens and headers attached. These live under **`ctx.host`** and are governed by three rules:

1. **Namespaced.** Every host capability is reached as `ctx.host.<name>`. The leading `host.` marks, at the call site, code that has left portable territory. A host MUST NOT add top-level `ctx` fields.
2. **Non-portable, and typed as such.** `HostExtensions` is empty in `@w6w/types`; the host augments it via TypeScript declaration merging from its own codebase. An app that reads `ctx.host.x` runs only on a host that provides `x`; on any other host the field is absent. Hosts SHOULD grant `ctx.host` capabilities only to apps they trust (e.g. first-party apps), never to untrusted third-party publishers — a privileged internal fetch in untrusted hands is a pivot onto the host's own services.
3. **Host-mediated — credential isolation still holds.** A host capability that carries a credential MUST perform the privileged work **on the trusted host**, exactly like `ctx.fetch`: the hook calls `ctx.host.cohostFetch(url)`, the call proxies to the host, the host attaches the token and performs it, and the hook receives a plain `Response`. The token MUST NOT be placed into `ctx` (e.g. as a header map) where untrusted sandbox code could read it. A `ctx.host` capability is "`ctx.fetch` with a different egress profile and a host-side signer," not an exception to the [single invariant](#credential-isolation).

Example augmentation (in the host's code, **not** in `@w6w/types`):

```ts
declare module "@w6w/types" {
  interface HostExtensions {
    /** Host-mediated fetch to cohost-internal services; auth injected on the host. */
    cohostFetch: typeof fetch;
  }
}
```

Hosts MAY require an app to **declare** the host capabilities it uses (a manifest field), so the runtime can refuse to load an app that needs a capability the host does not grant — and refuse to grant privileged ones to untrusted apps. The declaration format is a host/manifest concern, out of scope for this RFC.

## Hook registry

The complete set of hook kinds, their input/output shapes, and the lifecycle phase they belong to. The TypeScript signatures are normative; the JSON sketches show what crosses the worker boundary.

| Kind | Defined by | Input | Output | Phase | Sees credential? |
|---|---|---|---|---|---|
| `action.execute` | [Action RFC](./action.md) | resolved `params` | action `output` | `execute` | No |
| `action.output.source` | [Action RFC](./action.md) | `{ form }` | `OutputField[]` | `resolution` | No |
| `param.options.source` | [Param RFC](./param.md) | `{ form, dependsOn }` | `Option[]` | `resolution` | No |
| `param.validation.hook` | [Param RFC](./param.md) | `{ value, form }` | `{ ok, message? }` | `resolution` | No |
| `auth.preflight` | [Auth RFC](./auth.md) | `{ fields? }` | implementation-defined setup data | `auth` | No |
| `auth.exchange` | [Auth RFC](./auth.md) | `{ fields?, code?, redirectUri? }` | opaque credential | `auth` | No (constructs it) |
| `auth.test` | [Auth RFC](./auth.md) | `{ credential }` | `{ ok, message? }` | `auth` | **Yes** |
| `auth.afterConnect` | [Auth RFC](./auth.md) | `{ credential }` | display metadata | `auth` | **Yes** |
| `auth.sign` | [Auth RFC](./auth.md) | `{ request, credential }` | `SignableRequest` | `execute` | **Yes** |
| `auth.refresh` | [Auth RFC](./auth.md) | `{ credential }` | opaque credential | `auth` | **Yes** |
| `auth.revoke` | [Auth RFC](./auth.md) | `{ credential }` | `void` | `auth` | **Yes** |

Inputs and outputs MUST be **structured-cloneable** (the union of plain data, ArrayBuffers, Maps, Sets, Dates — no functions, no DOM nodes, no class instances with private state). This is what makes hooks transportable across worker boundaries and serialization-agnostic.

The full TypeScript declarations live in [`@w6w/types`](../packages/types/src/hooks.ts).

## Credential isolation

The single load-bearing invariant of the runtime:

> No code path may both **(a)** hold the live credential **and** **(b)** make an unmediated network call.

Operationally:

1. The **action sandbox** has no network and never receives the credential.
2. `ctx.fetch` inside the action sandbox proxies to the host. The host, before performing the call, hands the request to `auth.sign` in a **separate sandbox**. That sandbox has the credential but its `ctx.fetch` is removed entirely; it can only return the augmented request.
3. `auth.refresh`, `auth.exchange`, `auth.preflight`, `auth.test`, `auth.afterConnect`, `auth.revoke` all have the credential and a network-capable `ctx.fetch` — but they are gated to the `auth` phase and only run with explicit host orchestration (an Invocation in `needs_refresh`, a connect/test/disconnect flow). They never run during an Action's `execute`.

A host that violates this invariant is not spec-compliant regardless of which sandbox technology it picks.

## Error shape

Hooks signal failure in one of two ways.

### Throw

Any thrown value (`Error` or otherwise) terminates the hook. The runtime converts it into a typed error:

```ts
interface W6WError {
  code: string;         // machine-readable, see Codes table
  phase: ErrorPhase;    // resolution | auth | execute | output
  message: string;      // human-readable
  details?: unknown;    // structured payload, hook-provided when relevant
}
```

The phase is assigned by the runtime based on which call site invoked the hook (see [Invocation RFC §Resolution sequence](./invocation.md#resolution-sequence)). Hooks may not invent phases.

### Result envelope

A small set of hooks return a result envelope instead of throwing — this is the contract, not a convention:

- `param.validation.hook` returns `{ ok: true } | { ok: false; message: string }`.
- `auth.test` returns `{ ok: true } | { ok: false; message?: string }`.

A `false` result is a soft failure: the runtime converts it to a typed error (`param_invalid` or `connection_broken` respectively) and rejects the surrounding operation. A throw from these hooks is unexpected and becomes `hook_threw`.

### Codes

| Code | Phase | When |
|---|---|---|
| `hook_threw` | call-site's | Unexpected throw inside a hook. `details` carries the original message. |
| `hook_timeout` | call-site's | Hook ran past `timeoutMs`. |
| `hook_returned_invalid` | call-site's | Hook returned a value the runtime cannot serialize or that fails the output type check. |
| `param_invalid` | `resolution` | Declarative validation, validation hook `{ ok: false }`, or supplied value not in the resolved option set. |
| `connection_pending` / `connection_broken` / `connection_revoked` | `auth` | Connection lifecycle gates ([Invocation RFC](./invocation.md)). |
| `egress_denied` | `execute` | `ctx.fetch` URL host not in the App's `network.allow`. |
| `invalid_request_url` | `execute` | `ctx.fetch` (or a `sign` hook's return) produced an unparseable URL. |
| `unknown_app` / `unknown_action` / `unknown_connection` | `resolution` / `auth` | Resolution failure ([Invocation RFC](./invocation.md)). |

This table is closed for `manifestVersion: "1"`. New codes require an RFC bump.

## Timeouts and cancellation

Each hook invocation has a timeout in milliseconds. The runtime SHOULD apply a default of **30 000 ms** and MUST allow the host to override per call. When the timeout fires:

1. The hook's sandbox is terminated.
2. The runtime synthesizes a `hook_timeout` error in the current phase.
3. If the hook had produced a partial result, it is discarded.

Cancellation by the caller is OPTIONAL for `manifestVersion: "1"`. A host that supports it MUST use the same termination semantics (terminate the sandbox, treat as `hook_timeout`-equivalent with a host-defined code).

## Resource limits

The reference runtime does not enforce CPU or memory caps — Deno workers don't expose those primitives portably. A spec-compliant host MAY enforce additional limits (memory, CPU time, output size) and MUST report them as `hook_threw` or a host-defined extension code with a clear `message`. Such limits MUST NOT cause silent truncation of a hook's return value.

## Sandbox posture

A compliant host MUST guarantee, for every hook invocation:

| Capability | Action sandbox | Sign sandbox | Other auth hooks |
|---|---|---|---|
| Filesystem read | App dir only | App dir only | App dir only |
| Filesystem write | Denied | Denied | Denied |
| Network (raw) | Denied | Denied | Denied |
| `ctx.fetch` | Available, host-mediated, signed | **Removed** | Available, host-mediated, **unsigned** |
| Environment variables | Denied | Denied | Denied |
| Subprocess / FFI | Denied | Denied | Denied |
| Credential | Absent | Present in `input.credential` | Present in `input.credential` |

The reference implementation in `@w6w/runtime` runs hooks in Deno Web Workers spawned with the corresponding `permissions` map. Other implementations (V8 isolates with embedder hooks, gVisor-wrapped processes, Wasm with capability imports) are valid provided they produce the same observable behavior.

## Conformance

A host claims compliance with the Hook Runtime by passing the conformance suite shipped in `core/`:

- Module-format loaders for both path-reference and co-located function forms.
- `HookContext` exposing exactly the documented surface (no extras).
- The hook registry signatures from [`@w6w/types`](../packages/types/src/hooks.ts).
- The error shape and the closed `code` set.
- The timeout default and override mechanism.
- The sandbox posture matrix, demonstrated by a fixture app that attempts each denied capability and must fail.
- The credential-isolation invariant, demonstrated by `auth.sign` being unable to perform a network call.

The fixtures live in `core/fixtures/` and are runnable against any host as a black-box test.

## Open questions

None at this time. Future capabilities (Wasm targets, explicit cancellation primitives, per-host extension codes, persisted hook state) will be raised as their own RFCs against a later `manifestVersion`.
