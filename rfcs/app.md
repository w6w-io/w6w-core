# RFC: App

**Status:** Final
**Author:** Segev Shmueli
**Date:** 2026-04-15 (revised 2026-06-01)

## Summary

An **App** is the unit of integration on the platform. This RFC defines the App manifest — a declarative, format-agnostic description that any publisher (first-party or third-party) can author to register their service. The manifest is the source of truth for an app's identity, presentation, and provenance.

## Motivation

Integration platforms today each invent their own manifest shape — Slack apps, Zapier apps, n8n nodes, Shopify apps, VS Code extensions, Chrome extensions — all describe roughly the same thing in incompatible ways. We want a **single, open specification** that:

- Lets a publisher describe an app once and have it understood by any compliant host.
- Is **portable across serialization formats** (JSON, YAML, XML, TOML). The manifest is a logical model; the file format is a detail.
- Borrows the best parts of established ecosystems (npm, Chrome extensions, Apple/Google app stores, Slack manifest, JetBrains plugin descriptors).
- Covers *metadata* only. Behavior (Actions, Triggers, Webhooks, Auth) will be defined in later RFCs and wired into this manifest once their shapes are settled.

## Goals

- Describe an app's **identity, presentation, and provenance** completely in a single manifest.
- Globally unique identity via **reverse-DNS IDs** (`com.example.app-name`).
- **Serialization-agnostic** — the same logical manifest round-trips losslessly through JSON, YAML, or XML.
- **Forward-compatible** via an explicit `manifestVersion`.
- **Localization-ready** from day one.
- **Third-party friendly** — nothing here requires platform insider knowledge.

## Non-Goals

- Defining Actions, Triggers, Webhooks, or Auth schemas (separate RFCs).
- Specifying a runtime execution model.
- Mandating hosting, distribution, or signing mechanics (may be layered on later).

## Concept

An App represents any service the platform can integrate with — Slack, Stripe, Postgres, an internal CRM, a hardware device. The manifest makes an app:

- **Discoverable** — categories, keywords, description, icon, and screenshots enable marketplace search and browse.
- **Trustworthy** — publisher, license, privacy policy, and support channels give operators what they need to adopt it.

Every App has a stable, globally unique `id` in reverse-DNS form. Every other field is a property of that identity at a given `version`.

## Shape

Below is a JSON rendering. The same logical structure maps 1:1 to YAML, XML, or TOML.

```json
{
  "manifestVersion": "1",
  "id": "com.acme.slack",
  "name": "slack",
  "displayName": "Slack",
  "version": "1.4.2",
  "appVersion": "2024-10-22",

  "classification": {
    "maturity": "beta",
    "visibility": "public",
    "successor": "com.acme.slack-next"
  },

  "assetsRoot": "./assets",

  "description": "Send messages and react to events in Slack workspaces.",
  "longDescription": "./README.md",

  "categories": ["communication", "productivity"],
  "keywords": ["chat", "messaging", "team"],

  "appearance": {
    "icon": {
      "svg": "./assets/icon.svg",
      "sizes": {
        "16x16":   "./assets/icon-16.png",
        "128x128": "./assets/icon-128.png",
        "512x512": "./assets/icon-512.png"
      }
    },
    "brandColor": "#4A154B",
    "darkMode": {
      "icon": { "svg": "./assets/icon-dark.svg" },
      "brandColor": "#611F69"
    }
  },
  "screenshots": [
    { "url": "./assets/shot-1.png" },
    { "url": "./assets/shot-2.png" }
  ],

  "author": {
    "name":  "Acme Integrations",
    "email": "support@acme.example",
    "url":   "https://acme.example"
  },
  "publisher": "acme",

  "homepage":      "https://acme.example/apps/slack",
  "repository":    "https://github.com/acme/slack-app",
  "documentation": "https://docs.acme.example/slack",
  "support":       "https://acme.example/support",
  "bugs":          "https://github.com/acme/slack-app/issues",

  "license":        "MIT",
  "privacyPolicy":  "https://acme.example/privacy",
  "termsOfService": "https://acme.example/terms",

  "defaultLocale": "en",
  "localizations": {
    "es": { "displayName": "Slack", "description": "Envía mensajes..." }
  },

  "engines": { "platform": ">=2.0.0" }
}
```

### Field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `manifestVersion` | string | ✅ | Schema version this manifest targets (`"1"`, `"2"`, ...). Enables forward compatibility. |
| `id` | string | ✅ | Globally unique identifier in reverse-DNS form (`com.example.app-name`). **Immutable** across versions. |
| `name` | string | ✅ | Machine-friendly short name. Lowercase, kebab-case, ASCII. Used in URLs and CLIs. |
| `displayName` | string | ✅ | Human-facing name. Free-form; localizable. |
| `version` | string | ✅ | Semantic version (`MAJOR.MINOR.PATCH`) of this **manifest release**. Bumped on any change to the manifest itself. |
| `appVersion` | string | ⬜ | Free-form version of the **underlying integrated service** this manifest targets (e.g. `"2024-10-22"`, `"v2"`, `"Slack Web API"`). Informational; no SemVer constraint. |
| `classification` | object | ⬜ | Release-status block. Defaults: `{ maturity: "stable", visibility: "public" }`. |
| `classification.maturity` | enum | ⬜ | `"alpha"` \| `"beta"` \| `"stable"` \| `"deprecated"`. Self-declared stability signal shown as a badge in the UI. Default: `"stable"`. |
| `classification.visibility` | enum | ⬜ | `"private"` \| `"unlisted"` \| `"public"`. Publisher's distribution intent. `private` = workspace/team-only, `unlisted` = reachable by direct link but not indexed, `public` = listed in the marketplace. Default: `"public"`. |
| `classification.successor` | string (app id) | ⬜ | When `maturity = "deprecated"`, the reverse-DNS id of the app that replaces this one. Hosts SHOULD surface a "this app is deprecated; use *successor*" notice. |
| `assetsRoot` | string (path) | ⬜ | Base directory for resolving relative paths in `appearance.icon`, `screenshots[].url`, `longDescription`, etc. Defaults to the directory of the manifest file. Absolute URLs are unaffected. |
| `description` | string | ✅ | One-line summary, ≤ 200 chars. Shown in lists. |
| `longDescription` | string \| path | ⬜ | Markdown prose, inline or referenced file. For marketplace detail pages. |
| `categories` | string[] | ✅ | 1–3 entries from the [controlled vocabulary](./categories.md). Hosts MAY accept out-of-vocabulary entries but SHOULD warn. |
| `keywords` | string[] | ⬜ | Free-form tags for search. |
| `appearance` | object | ✅ | Visual identity block — icon, brand color, and optional dark-mode overrides. |
| `appearance.icon` | [ImageObject](./image-object.md) | ✅ | Icon asset. |
| `appearance.brandColor` | string | ⬜ | Hex color used for marketplace styling. |
| `appearance.darkMode` | object | ⬜ | Alternate appearance for dark UI contexts. Any field it declares (`icon`, `brandColor`) overrides the light-mode default. Omit for no dark variant. |
| `screenshots` | [ImageObject](./image-object.md)[] | ⬜ | Marketing screenshots. |
| `author` | object | ✅ | `{ name, email?, url? }`. |
| `publisher` | string | ⬜ | Verified publisher handle assigned by the registry. Enables trust badges. |
| `homepage` | URL | ⬜ | Marketing page. |
| `repository` | URL | ⬜ | Source code. |
| `documentation` | URL | ⬜ | Docs. |
| `support` | URL \| email | ⬜ | Support contact. |
| `bugs` | URL | ⬜ | Issue tracker. |
| `license` | string | ✅ | SPDX identifier (`MIT`, `Apache-2.0`, `UNLICENSED`). |
| `privacyPolicy` | URL | ⬜ | Required for apps that handle user data. |
| `termsOfService` | URL | ⬜ | |
| `defaultLocale` | string | ⬜ | BCP-47 tag. Defaults to `en`. |
| `localizations` | object | ⬜ | Map of BCP-47 tag → partial manifest overrides. |
| `engines` | object | ⬜ | Runtime version constraints, e.g. `{ "platform": ">=2.0.0" }`. |

## Serialization

The manifest defines a **logical schema**, not a wire format. The same manifest MUST round-trip losslessly through:

- **JSON** — canonical form; used in tests, examples, and programmatic exchange.
- **YAML** — for human authoring.
- **XML** — for enterprise tooling.
- **TOML** — optional.

A reference serializer/validator lives in `core/` and validates any input against the logical schema regardless of its source format.

## Reserved fields

These field names are **reserved** by this spec. Hosts MUST NOT repurpose them; a later RFC will define their shape.

- `signature` — manifest-level signature block (provenance / publisher attestation).
- `attestations` — verifiable claims about the manifest or its assets.

## Resolved questions

| Question | Resolution |
|---|---|
| Manifest version vs app version | **Split.** `version` is the manifest release (SemVer); the optional `appVersion` is free-form metadata about the integrated service. |
| Deprecation lifecycle | `classification.maturity: "deprecated"` plus optional `classification.successor` (reverse-DNS id). |
| Asset resolution | Paths resolve **relative to the manifest file** by default; the optional top-level `assetsRoot` overrides the base directory. Absolute URLs are passed through. |
| Signing & provenance | **Deferred** to a follow-up RFC. `signature` and `attestations` are reserved as field names. |
