# core

The core monorepo for the workflow platform.

**Status:** Source-available under [FSL-1.1-ALv2](./LICENSE) (converts to Apache 2.0).
**Current spec:** `manifestVersion: "1"` — all primitive RFCs are Final.

## Purpose

This monorepo defines the primitives, runtime, and SDKs that power workflows across the platform. It is the source of truth for *what a workflow is* and *how its parts compose*.

It contains two halves: the **specification** (the [`rfcs/`](./rfcs) — what a workflow *is*) and a **Deno workspace of packages** (the reference implementation — code that proves the spec runs).

## Spec status

Every RFC carries one of:

| Status | Meaning |
|---|---|
| `Draft` | Under active design; fields and shape may change without notice. |
| `Review` | Proposal is feature-complete; soliciting feedback before freeze. |
| `Final` | Frozen for the current `manifestVersion`. Breaking changes require a new RFC and a `manifestVersion` bump. |
| `Superseded` | Replaced by another RFC; carries a pointer to its successor. |

`manifestVersion: "1"` covers the seven primitive RFCs listed below plus the Hook Runtime and Categories vocabulary. Trigger, Webhook, Workflow, and Run will land in `manifestVersion: "2"`. New RFCs use the template at [`rfcs/_template.md`](./rfcs/_template.md).

## Packages

| Package | What it is |
|---|---|
| [`@w6w/types`](./packages/types/README.md) | Shared, dependency-free TypeScript logical model + hook contracts. Published to npm + JSR. |
| [`@w6w/runtime`](./packages/runtime/README.md) | Lib core: load an app, describe it, and invoke actions in a least-privilege Deno sandbox. |
| [`@w6w/sources`](./packages/sources/README.md) | Resolve a source reference (`file:`, `github:`) to a local directory for the runtime. |
| [`@w6w/validator`](./packages/validator/README.md) | Validate manifests against the spec rules. Ships a `core validate <path>` CLI (`deno task validate`). |
| [`@w6w/schema`](./packages/schema/README.md) | JSON Schema (Draft 2020-12) for every primitive — structural validation layer. |
| [`@w6w/expr`](./packages/expr/README.md) | JSONLogic engine for Param `showIf` and expression evaluation. |

Each package is transport-free and independently focused; deployment concerns
(an HTTP server, a CLI, credential storage) are wrappers built on top — some
here, some in the host platform. Run `deno task test` (or `npm test`) to exercise
the whole workspace.

## Primitives

The platform is built from a small set of primitives. Each one has (or will have) a dedicated RFC defining its logical schema, a reference serializer/validator, and a reference implementation.

### Top-level primitives

| Primitive | Purpose | RFC |
|---|---|---|
| **App** | Unit of integration — identity, presentation, and provenance of an integrated service. | [`rfcs/app.md`](./rfcs/app.md) — Final |
| **Action** | A single operation a user can perform through an App (`read` / `search` / `perform`). | [`rfcs/action.md`](./rfcs/action.md) — Final |
| **Auth** | How a user connects their account to an App (`oauth2` / `apiKey` / `basic` / `bearer` / `custom`) plus lifecycle hooks. | [`rfcs/auth.md`](./rfcs/auth.md) — Final |
| **Connection** | The stored, per-user result of a completed Auth flow. Holds the opaque credential, display metadata, and lifecycle state. | [`rfcs/connection.md`](./rfcs/connection.md) — Final |
| **Invocation** | The envelope used to call an Action — binds App, Action, Connection, and resolved params. | [`rfcs/invocation.md`](./rfcs/invocation.md) — Final |
| **Registry** | Host-side service: the collection of registered Apps, versioned and lifecycle-managed. Datastore-pluggable; reference impl lives in [`w6w-registry`](../registry/). | [`rfcs/registry.md`](./rfcs/registry.md) — Draft |
| **Webhook** | Inbound event delivery from an App. | TBD |
| **Trigger** | What starts a workflow. | TBD |
| **Workflow** | The graph of steps the platform executes. | TBD |
| **Run** | A single execution of a workflow. | TBD |

### Shared types

Primitives that are reused inside other manifests rather than declared standalone.

| Type | Purpose | RFC |
|---|---|---|
| **Param** | Declarative config for a single form field. Every form surface (Action, Trigger, Auth) is a `Param[]`. | [`rfcs/param.md`](./rfcs/param.md) — Final |
| **ImageObject** | Reusable image reference (icons, screenshots, badges). One container with vector and sized-raster sources. | [`rfcs/image-object.md`](./rfcs/image-object.md) — Final |
| **Hook Runtime** | The contract every publisher-authored hook runs under: module format, ambient API, error shape, timeouts, sandbox posture, credential isolation. | [`rfcs/hook-runtime.md`](./rfcs/hook-runtime.md) — Final |
| **Categories** | Controlled vocabulary for App `categories`. | [`rfcs/categories.md`](./rfcs/categories.md) — Final |

## Build your own app

Two starter templates cover both authoring flows. The app contract they satisfy is identical — pick the toolchain you're comfortable with.

| Template | Toolchain | Notes |
|---|---|---|
| [`w6w-app-template-deno`](https://github.com/w6w-io/w6w-app-template-deno) | Deno + JSR `@w6w/types` + `deno test` | Zero-install, matches the reference runtime directly. |
| [`w6w-app-template-node`](https://github.com/w6w-io/w6w-app-template-node) | Node 22 + npm `@w6w/types` + `tsx` + `vitest` | Node-idiomatic. `.ts` extensions kept in imports so the same source runs under the runtime unchanged. |

Both ship: bearer-token Auth (`sign` + `test`), read + perform Actions against `httpbin.org`, mocked-`HookContext` unit tests, and a green CI workflow. Click **Use this template** on GitHub to start.

Building with an LLM / coding agent? [`docs/build-a-w6w-app.md`](./docs/build-a-w6w-app.md) is a self-contained, prompt-ready instruction set covering the app contract, the hard sandbox rules, and a definition-of-done checklist.

## Design principles

A few invariants that run through every RFC:

- **Serialization-agnostic.** Manifests are logical schemas. The same manifest round-trips losslessly through JSON, YAML, XML, or TOML — the file format is a detail.
- **Forward-compatible.** Every standalone manifest declares a `manifestVersion`.
- **Code-first behavior.** Actions and Auth methods are code modules that co-locate config with their functions (`execute`, `sign`, …), exported from the app's entry module. (The RFCs still describe per-file manifests; reconciling them is a pending backport.)
- **Hooks at the boundaries.** Behavior that varies per publisher (signing requests, populating dropdowns, validating input, exchanging tokens) is exposed as hook files referenced from the manifest.
- **Opaque credentials.** Actions never see raw credentials; Auth's `sign` hook injects auth into outbound requests.

## Structure

```
core/
├── rfcs/                  # The specification (source of truth)
├── packages/
│   ├── types/             # @w6w/types — shared logical model + hook contracts
│   ├── runtime/           # @w6w/runtime — load · describe · invoke (sandboxed)
│   ├── sources/           # @w6w/sources — resolve source refs to a local dir
│   ├── validator/         # @w6w/validator — spec-rule validation
│   ├── schema/            # @w6w/schema — JSON Schemas (Draft 2020-12) per RFC
│   └── expr/              # @w6w/expr — JSONLogic engine
├── fixtures/apps/         # Example apps the runtime is tested against
└── .github/workflows/     # CI (tests) + publish (npm OIDC + JSR, on release)
```

A Deno workspace (`deno.json`). The runtime is transport-free lib core; HTTP and
CLI wrappers will live in their own packages. Run `deno task test` to exercise it.

An **app is an npm-style package**. Its **identity** lives in `package.json` —
native fields (`version`, `description`, `author`, `license`, …) plus a `w6w`
block for the rest (`id`, `displayName`, `categories`, `appearance`, `network`).
Its **behavior** lives in an entry module (`w6w.entry`, default `./index.ts`)
that default-exports an `AppDefinition` — `{ actions, auth }`. Each Action and
Auth method is a code module that co-locates its config with its functions
(`execute`, `sign`, `test`, …), n8n/Zapier-style. No `.action.json`/`.auth.json`
files. `w6w.manifest` can still opt into a standalone identity file.

> **Status:** spec frozen for `manifestVersion: "1"`. Runtime working end-to-end:
> load a packaged app, return its manifest, and invoke an Action in a sandbox
> that denies fs/network escape. Auth — outbound requests are signed by a
> credential-bearing `sign` hook in its own network-less worker, so neither
> sandbox can leak the credential. The Invocation connection-lifecycle gates
> (`pending`/`broken`/`revoked` reject; `needs_refresh` runs `refresh`) are
> enforced. Dynamic Params (`options.source` + the fixpoint resolution loop)
> are next.
