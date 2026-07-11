# RFC: Param

**Status:** Final
**Author:** Segev Shmueli
**Date:** 2026-04-15 (revised 2026-06-01)

## Summary

A `Param` is the declarative config for a single form field. It describes the value's **type**, the **render metadata** (label, placeholder, hint, required), optional **hooks** (populate options, validate), and **dependencies** on other params. Every form surface on the platform — Action configs, Trigger configs, Auth inputs — is an ordered list of Params.

## Motivation

Actions, Triggers, Webhooks, and Auth all need to collect user input. Without a shared primitive each one re-invents form fields with subtly different shapes — we've already seen this inside the Auth RFC's `fields` array. One `Param` spec means:

- Any surface that needs a form references `Param[]`.
- Hosts implement **one** form renderer.
- Tooling (docs, generators, IDE hints) works uniformly across every surface.

## Goals

- Cover common value types: `string`, `text`, `number`, `boolean`, `select`, `multiselect`, `date`, `datetime`, `secret`, `file`, `json`, `code`, `group`.
- Decouple **value type** from **render presentation** via an optional `ui` hint.
- Support both **static** and **hook-driven** option lists.
- First-class **dependencies** — params that depend on others re-render when the deps change.
- **Validation** via declarative rules plus an optional `validate` hook.
- Serialization-agnostic.

## Non-Goals

- Specifying the hook runtime — shared with Auth hooks, deferred to a runtime RFC.
- Visual design / styling of rendered fields.
- Form layout beyond an ordered list (groups / sections / tabs — see Open Questions).

## Concept

A `Param` is:

1. **Identity & presentation** — `key`, `label`, `placeholder`, `hint`.
2. **Value shape** — `type` and any type-specific options.
3. **Behavior** — `required`, `default`, `secret`, `readOnly`, `repeat`.
4. **Hooks** — `options.source` to populate choices dynamically, `validation.hook` for custom validation.
5. **Dependencies** — `dependsOn` lists other param keys that must be filled first; changing a dep invalidates this param.

A form is `Param[]`. The surface that owns the form (Action, Trigger, Auth, …) decides what the values mean when submitted.

## Shape

### Simple string

```json
{
  "key": "name",
  "label": "Name",
  "placeholder": "Acme Inc.",
  "hint": "Shown in reports.",
  "type": "string",
  "required": true
}
```

### Select with static options

```json
{
  "key": "priority",
  "label": "Priority",
  "type": "select",
  "options": [
    { "value": "low",  "label": "Low" },
    { "value": "med",  "label": "Medium" },
    { "value": "high", "label": "High", "description": "Pages the on-call." }
  ],
  "default": "med"
}
```

### Dropdown populated from an API

```json
{
  "key": "channelId",
  "label": "Channel",
  "type": "select",
  "ui": "dropdown",
  "options": { "source": "./hooks/list-channels.ts", "searchable": true },
  "required": true
}
```

### Param with dependency

```json
{
  "key": "threadTs",
  "label": "Thread",
  "type": "select",
  "dependsOn": ["channelId"],
  "options": { "source": "./hooks/list-threads.ts" },
  "hint": "Pick a channel first."
}
```

### Multiselect as checkboxes

```json
{
  "key": "tags",
  "label": "Tags",
  "type": "multiselect",
  "ui": "checkboxes",
  "options": [
    { "value": "bug",     "label": "Bug" },
    { "value": "feature", "label": "Feature" }
  ]
}
```

### Secret

```json
{
  "key": "apiKey",
  "label": "API Key",
  "type": "secret",
  "required": true,
  "hint": "Found under Settings → Developer."
}
```

### Validation (declarative + hook)

```json
{
  "key": "subdomain",
  "label": "Subdomain",
  "type": "string",
  "validation": {
    "pattern": "^[a-z0-9-]+$",
    "minLength": 3,
    "maxLength": 32,
    "hook": "./hooks/validate-subdomain.ts"
  }
}
```

## Field reference

### Core

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✅ | Machine name. Unique within the enclosing form. Used in hooks and submitted values. |
| `label` | string | ✅ | Human-facing label. |
| `type` | enum | ✅ | Value type (see Types table). |
| `placeholder` | string | ⬜ | Hint text shown inside an empty input. |
| `hint` | string | ⬜ | Explanatory text rendered below the input. |
| `required` | boolean | ⬜ | Defaults to `false`. |
| `default` | any | ⬜ | Prefilled value. Must match `type`. |
| `secret` | boolean | ⬜ | Input is sensitive. Host MUST mask in UI and store encrypted. Implicit `true` when `type: "secret"`. |
| `readOnly` | boolean | ⬜ | Display-only; not submitted. |
| `repeat` | boolean | ⬜ | Allow multiple values (array of `type`). UI renders as an add/remove list. |
| `ui` | string | ⬜ | Render hint — see UI hints by type. |
| `dependsOn` | string[] | ⬜ | Keys of other params. Disabled until all listed keys have values; changes invalidate cached `options` and re-run `validate`. |
| `showIf` | [JSONLogic](https://jsonlogic.com) rule | ⬜ | Conditional visibility based on other field values. Evaluated against the current form state; truthy → visible. The platform ships a JSONLogic engine in [`@w6w/expr`](../packages/expr/README.md). |
| `options` | Options | ⬜ | For choice types. Static list or dynamic hook source. |
| `validation` | Validation | ⬜ | Declarative rules and/or a custom hook. |
| `children` | Param[] | ⬜ | Nested params for `type: "group"` (nested object) or `type: "section"` (flat, layout-only). |
| `section` | `"collapsible"` \| `"group"` | ⬜ | Required when `type: "section"`. Container behavior. |
| `title` | string | ⬜ | `section: "collapsible"` only, required there — the disclosure heading. |
| `subtitle` | string | ⬜ | `section: "collapsible"` only — optional secondary summary line. |
| `layout` | `"row"` \| `"stack"` | ⬜ | `section: "group"` only — children side by side or stacked. Defaults to `"stack"`. |
| `collapsed` | boolean | ⬜ | `section: "collapsible"` only — start collapsed. Defaults to `true`. |

### Types

| `type` | Value shape | Notes |
|---|---|---|
| `string` | string | Single-line text. |
| `text` | string | Multi-line text. |
| `number` | number | Use `validation.integer` to restrict to integers. |
| `boolean` | boolean | Rendered as toggle or checkbox. |
| `select` | string \| number | Single choice from `options`. |
| `multiselect` | array | Zero or more choices from `options`. |
| `date` | string (`YYYY-MM-DD`) | |
| `datetime` | string (ISO 8601) | Includes timezone. |
| `secret` | string | Masked in UI, encrypted at rest. Implies `secret: true`. |
| `file` | string (ref) | Reference to uploaded file; actual storage is the host's concern. |
| `json` | any | Structured JSON; host renders a JSON editor. |
| `code` | string | Code with language via `ui` (e.g. `"code:sql"`). |
| `group` | object | Nested form. Value is a `Record<string, unknown>` whose keys are the `key`s of the params in `children`. See [Groups](#groups). |
| `section` | — (layout only) | Layout-only container of `children`. `section: "collapsible"` renders a titled, collapsed-by-default disclosure; `section: "group"` a `layout` row/stack. Children's values live in the **enclosing** form (not nested under the section's `key`). See [Sections](#sections). |

### UI hints

| `type` | Allowed `ui` values | Default |
|---|---|---|
| `string` | `"input"`, `"textarea"` | `"input"` |
| `number` | `"input"`, `"slider"`, `"stepper"` | `"input"` |
| `boolean` | `"toggle"`, `"checkbox"` | `"toggle"` |
| `select` | `"dropdown"`, `"radio"` | `"dropdown"` |
| `multiselect` | `"dropdown"`, `"checkboxes"`, `"chips"` | `"dropdown"` |
| `code` | `"code:<language>"` | `"code:plain"` |

### Options

**Static:**

```json
"options": [
  { "value": "...", "label": "...", "description": "(optional)", "disabled": false }
]
```

**Dynamic:**

```json
"options": {
  "source": "./hooks/list.ts",
  "searchable": true,
  "cache": "session"
}
```

The `source` hook receives the current form state (including all `dependsOn` values) and returns an `Option[]`.

### Validation

| Field | Type | Description |
|---|---|---|
| `pattern` | regex | String must match. |
| `minLength` / `maxLength` | number | For `string` / `text`. |
| `min` / `max` | number | For `number`. |
| `integer` | boolean | Reject floats. |
| `enum` | array | Value must be in list (useful even without visible `options`). |
| `hook` | path | Custom validator. Receives `{ value, form }`, returns `{ ok: true }` or `{ ok: false, message }`. |

Validation runs on field change and again on submit.

## Groups

The `group` type holds a nested `Param[]` under the `children` field. Combined with `repeat: true` it expresses a list of structured items (e.g. an array of HTTP header rows).

```json
{
  "key": "headers",
  "label": "Custom Headers",
  "type": "group",
  "repeat": true,
  "children": [
    { "key": "name",  "label": "Name",  "type": "string", "required": true },
    { "key": "value", "label": "Value", "type": "string", "required": true }
  ]
}
```

The submitted value is `Array<{ name: string; value: string }>`. `dependsOn` inside `children` may reference sibling keys within the same group; references to params outside the group are resolved against the enclosing form.

## Sections

A `section` is a **layout-only** container of `children`. Unlike a `group`, a section does **not** nest its children's values under its own `key` — the children's values live flat in the **enclosing** form, exactly as if they'd been declared at the top level. A section only groups fields visually.

Two shapes, selected by `section`:

- `section: "collapsible"` — a titled, collapsed-by-default disclosure. Requires `title`; `subtitle` and `collapsed` (default `true`) are optional. Good for tucking advanced fields away behind an author-named heading (distinct from the host's single global "Additional parameters" disclosure).
- `section: "group"` — a `layout` cluster: `"row"` lays the children side by side, `"stack"` (the default) stacks them. The visibility-aware, multi-field sibling of the flat `row` flag.

**Collapsible example** (advanced fields behind a disclosure):

```json
{
  "key": "advancedContent",
  "label": "Advanced",
  "type": "section",
  "section": "collapsible",
  "title": "Advanced",
  "subtitle": "MIME type & template",
  "collapsed": true,
  "children": [
    { "key": "contentType", "label": "MIME Type", "type": "select", "options": [
      { "value": "text/plain", "label": "Plain Text" },
      { "value": "text/html",  "label": "HTML" }
    ] },
    { "key": "templateId", "label": "Template", "type": "select" }
  ]
}
```

**Group / row example** (two fields side by side):

```json
{
  "key": "sender",
  "label": "Sender",
  "type": "section",
  "section": "group",
  "layout": "row",
  "children": [
    { "key": "fromEmail", "label": "Sender Email", "type": "string", "required": true },
    { "key": "fromName",  "label": "Sender Name",  "type": "string" }
  ]
}
```

Here the submitted values are flat — `{ "fromEmail": "…", "fromName": "…" }` — **not** `{ "sender": { … } }`. This is the key difference from `group`, which nests under its `key`.

A section **coexists** with the other layout features: children may carry `row`, `showIf`, and even nested sections, all of which keep working inside the container. A child's `advanced` flag is **not** honored inside a section — the section is itself the disclosure, so its children render inline within it; use a `collapsible` section (or the enclosing form's global "Additional parameters") to hide fields, not a per-child `advanced`. `section: "group"` with `layout: "row"` is the visibility-aware sibling of the flat `row` flag; a collapsible section is an author-named, per-cluster disclosure distinct from the single global "Additional parameters" disclosure.

## Hooks

| Hook | Receives | Returns | Purpose |
|---|---|---|---|
| `options.source` | `{ form, dependsOn }` | `Option[]` | Populate choices from an API or other dynamic source. |
| `validation.hook` | `{ value, form }` | `{ ok, message? }` | Custom validation beyond declarative rules. |

Both hooks execute under the [Hook Runtime RFC](./hook-runtime.md) — same module format, same `HookContext` (with mediated `fetch` and structured `log`), same error shape, same default 30 s timeout, same sandbox posture as every other hook in the spec.

## Dependencies

When param `B` declares `dependsOn: ["A"]`:

1. `B` renders as disabled until `A` has a value.
2. If `B` has `options.source`, the hook receives `A`'s value in the form state.
3. When `A` changes, `B`'s cached options are invalidated and `B`'s current value is cleared unless it is still a valid option.

Circular dependencies are rejected at manifest load time.

## Resolved questions

| Question | Resolution |
|---|---|
| `showIf` expression language | **JSONLogic.** The reference engine ships as [`@w6w/expr`](../packages/expr/README.md). No bespoke mini-language. |
| Grouping / sections / tabs | **Resolved.** Added `type: "section"` (`section: "collapsible"` disclosure / `section: "group"` row/stack layout) as a layout-only container — its children's values stay flat in the enclosing form. See [Sections](#sections). Tabs still deferred. |
| i18n on Param | **Deferred to the enclosing manifest's `localizations` block.** No per-Param locale object — avoids double-sourcing translations. |
| `repeat` vs nested schema | Added a `group` type that takes a nested `Param[]` via `children`. Lists of structured items use `type: "group", repeat: true`. |
