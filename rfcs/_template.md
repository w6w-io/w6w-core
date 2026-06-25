# RFC: <Name>

**Status:** Draft
**Author:** <Your Name>
**Date:** YYYY-MM-DD

## Summary

One paragraph: what this RFC defines and where it sits in the platform.

## Motivation

Why this RFC exists. The concrete pain a host or publisher hits today without it. Reference prior art if it informs the shape.

## Goals

- Bullet list of the outcomes a reader should be able to verify against the spec.

## Non-Goals

- Bullet list of things this RFC explicitly does not cover, with a pointer to where they live (other RFC, host concern, deferred).

## Concept

Prose explanation of the central idea, the invariants, and the lifecycle (if any). Diagrams allowed.

## Shape

The logical schema. Show one or more JSON renderings. Remember: the spec is serialization-agnostic — JSON is illustrative, not the format.

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `foo` | string | ✅ | What it is, what the value space is. |

## <Domain-specific sections>

Lifecycle tables, resolution algorithms, error code lists, etc. Whatever this primitive needs to be implementable.

## Conformance (optional)

If this RFC introduces behavior a host implements, name the observable contract a host MUST satisfy. Point at the fixtures that prove it.

## Open questions

Numbered list. Adjudicate them before promoting to Final. Replace this section with **Resolved questions** when you do — a table mapping the question to its decision.

## Status ladder

Use the project-wide ladder:

- `Draft` — under active design; fields and shape may change without notice.
- `Review` — proposal is feature-complete; soliciting feedback before freeze.
- `Final` — frozen for the current `manifestVersion`. Breaking changes require a new RFC and a `manifestVersion` bump.
- `Superseded` — replaced by another RFC; carry a pointer to its successor.
