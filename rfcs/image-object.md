# RFC: ImageObject

**Status:** Draft
**Author:** TBD
**Date:** 2026-04-15

## Summary

`ImageObject` is a reusable primitive for any image reference across manifests — app icons, screenshots, brand assets, badges, etc. One type with a small set of optional source fields lets any manifest declare `ImageObject` or `ImageObject[]` without re-inventing an image shape each time.

## Motivation

Icons, thumbnails, and marketing imagery appear in nearly every manifest we plan to define (App, Action, Trigger, …). If each defines its own image shape we get fragmented tooling and subtle drift. A single `ImageObject`:

- Lets any field that needs an image declare `ImageObject` or `ImageObject[]`.
- Keeps vector (SVG) and raster (sized URLs) delivery side-by-side in one place.
- Allows a single-URL fallback for cases where dimensions don't matter.
- Is additive — new sources (WebP-only, blurhash, etc.) can be layered in later without a breaking change.

## Goals

- Support **vector** delivery via `svg`.
- Support **raster** delivery via `sizes`, keyed by explicit pixel dimensions.
- Support a **single-URL fallback** via `url`.
- Be **serialization-agnostic** — round-trips through JSON, YAML, XML, TOML.

## Non-Goals

- Mandating which representation must be provided — at least one source MUST exist, but which one is the publisher's choice.
- Image transformation, CDN, or hosting logic.
- Binary/inline encoding. `ImageObject` always references an external resource by path or URL.

## Concept

An `ImageObject` is a **container of sources** that all point to the same logical image. Consumers pick the best source for the context:

- Vector-capable surface (web, SVG-aware renderer): prefer `svg`.
- Fixed-dimension slot: prefer the matching entry in `sizes`; otherwise the nearest larger size; otherwise `url`; otherwise `svg`.
- Unknown dimension: prefer `url`; otherwise `svg`; otherwise the largest entry in `sizes`.

At least one of `svg`, `url`, or `sizes` MUST be present.

## Shape

```json
{
  "svg": "./assets/icon.svg",
  "url": "https://cdn.example.com/icon.png",
  "sizes": {
    "16x16":    "./assets/icon-16.png",
    "128x128":  "./assets/icon-128.png",
    "512x512":  "./assets/icon-512.png",
    "1200x630": "https://cdn.example.com/og.png"
  }
}
```

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `svg` | string (path \| URL) | ⬜ | Vector source. Preferred by renderers that support SVG. |
| `url` | string (URL) | ⬜ | Single raster source used when no specific dimension is requested. |
| `sizes` | object | ⬜ | Map of `{width}x{height}` (pixel integers) → URL. Freeform dimensions: `16x16`, `100x200`, `1200x630` are all valid. |

At least one of `svg`, `url`, or `sizes` MUST be present. Any combination is allowed.

## Prior art

- **HTML `<link rel="icon" sizes="...">`** — per-size icon references.
- **Web App Manifest `icons[]`** — `{ src, sizes, type }` array.
- **Apple `AppIcon.appiconset` / Android `mipmap-*`** — size-keyed raster sets.
- **Open Graph / Twitter Cards** — fixed-dimension marketing images (`1200x630`, etc.).

## Open questions

1. **Alt text / caption.** Accessibility needs `alt`; marketing surfaces need `caption`. Include both as optional fields on `ImageObject`, or leave text annotations to the enclosing field (e.g., a screenshot wrapper)?
2. **MIME / format hint.** Do we need explicit `type` per source, or is MIME inferred from the URL extension?
3. **Density / DPR.** `{w}x{h}@2x` naming convention in `sizes`, or a dedicated field?
4. **Placeholder / blurhash.** Low-quality preview for loading states — worth a field now, or layer on later?
