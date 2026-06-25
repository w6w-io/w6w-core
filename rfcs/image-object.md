# RFC: ImageObject

**Status:** Final
**Author:** Segev Shmueli
**Date:** 2026-04-15 (revised 2026-06-01)

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
  },
  "alt":     "Acme logo",
  "caption": "The Acme logo, used on marketplace cards."
}
```

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `svg` | string (path \| URL) | ⬜ | Vector source. Preferred by renderers that support SVG. |
| `url` | string (URL) | ⬜ | Single raster source used when no specific dimension is requested. |
| `sizes` | object | ⬜ | Map of `{width}x{height}` (pixel integers) → URL. Freeform dimensions: `16x16`, `100x200`, `1200x630` are all valid. |
| `alt` | string | ⬜ | Accessibility text. Hosts SHOULD render it as `alt`/`aria-label` whenever the image is presented. |
| `caption` | string | ⬜ | Optional human-readable caption (used by screenshot strips, marketplace detail pages, etc.). |

At least one of `svg`, `url`, or `sizes` MUST be present. Any combination is allowed.

MIME type is inferred from the URL extension (`.svg`, `.png`, `.webp`, …). Publishers do not declare it explicitly.

## Prior art

- **HTML `<link rel="icon" sizes="...">`** — per-size icon references.
- **Web App Manifest `icons[]`** — `{ src, sizes, type }` array.
- **Apple `AppIcon.appiconset` / Android `mipmap-*`** — size-keyed raster sets.
- **Open Graph / Twitter Cards** — fixed-dimension marketing images (`1200x630`, etc.).

## Resolved questions

| Question | Resolution |
|---|---|
| Alt text / caption | Both **added** as optional. Accessibility shouldn't be deferred. |
| MIME / format hint | **Inferred from extension.** No explicit `type` field for `manifestVersion: "1"`; can be added without breakage if a real ambiguity surfaces. |
| Density / DPR | **Deferred.** Explicit pixel dimensions in `sizes` (`32x32`, `64x64`) are enough for `v1`. `@2x`-style naming may be layered on later. |
| Placeholder / blurhash | **Deferred.** Add only when host renderers actually need it. |
