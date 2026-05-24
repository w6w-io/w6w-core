# core

The core monorepo for the workflow platform.

**Status:** Closed source (will be open sourced later)

## Purpose

This monorepo defines the primitives, runtime, and SDKs that power workflows across the platform. It is the source of truth for *what a workflow is* and *how its parts compose*.

## Primitives

The platform is built from a small set of primitives. Each one has (or will have) a dedicated RFC defining its logical schema, a reference serializer/validator, and a reference implementation.

### Top-level primitives

| Primitive | Purpose | RFC |
|---|---|---|
| **App** | Unit of integration — identity, presentation, and provenance of an integrated service. | [`rfcs/app.md`](./rfcs/app.md) — Draft |
| **Action** | A single operation a user can perform through an App (`read` / `search` / `perform`). | [`rfcs/action.md`](./rfcs/action.md) — Draft |
| **Auth** | How a user connects their account to an App (`oauth2` / `apiKey` / `basic` / `bearer` / `custom`) plus lifecycle hooks. | [`rfcs/auth.md`](./rfcs/auth.md) — Draft |
| **Connection** | The stored, per-user result of a completed Auth flow. Holds the opaque credential, display metadata, and lifecycle state. | [`rfcs/connection.md`](./rfcs/connection.md) — Draft |
| **Invocation** | The envelope used to call an Action — binds App, Action, Connection, and resolved params. | [`rfcs/invocation.md`](./rfcs/invocation.md) — Draft |
| **Webhook** | Inbound event delivery from an App. | TBD |
| **Trigger** | What starts a workflow. | TBD |
| **Workflow** | The graph of steps the platform executes. | TBD |
| **Run** | A single execution of a workflow. | TBD |

### Shared types

Primitives that are reused inside other manifests rather than declared standalone.

| Type | Purpose | RFC |
|---|---|---|
| **Param** | Declarative config for a single form field. Every form surface (Action, Trigger, Auth) is a `Param[]`. | [`rfcs/param.md`](./rfcs/param.md) — Draft |
| **ImageObject** | Reusable image reference (icons, screenshots, badges). One container with vector and sized-raster sources. | [`rfcs/image-object.md`](./rfcs/image-object.md) — Draft |

## Design principles

A few invariants that run through every RFC:

- **Serialization-agnostic.** Manifests are logical schemas. The same manifest round-trips losslessly through JSON, YAML, XML, or TOML — the file format is a detail.
- **Forward-compatible.** Every standalone manifest declares a `manifestVersion`.
- **Standalone manifests, referenced by path.** Actions and Auth methods live in their own files and are referenced from the App manifest.
- **Hooks at the boundaries.** Behavior that varies per publisher (signing requests, populating dropdowns, validating input, exchanging tokens) is exposed as hook files referenced from the manifest.
- **Opaque credentials.** Actions never see raw credentials; Auth's `sign` hook injects auth into outbound requests.

## Structure

```
core/
├── rfcs/                  # The specification (source of truth)
├── packages/
│   ├── types/             # @w6w/types — shared TS logical model (publishable to npm)
│   └── runtime/           # @w6w/runtime — lib core: load an app, describe it, invoke
│                          #   Actions in a least-privilege Deno Worker sandbox
└── fixtures/apps/         # Example apps the runtime is tested against
```

A Deno workspace (`deno.json`). The runtime is transport-free lib core; HTTP and
CLI wrappers will live in their own packages. Run `deno task test` to exercise it.

> **Status:** early. A first vertical slice runs end-to-end — load a packaged app
> (`package.json` + manifest + referenced hooks), return its manifest, and invoke a
> `read` Action inside a sandbox that denies network/filesystem escape. Auth flows,
> dynamic Params, and the full Invocation connection-lifecycle gates are next.
