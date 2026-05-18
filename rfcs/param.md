# RFC: Param

**Status:** Draft
**Author:** TBD
**Date:** 2026-04-15

## Summary

A `Param` is the declarative config for a single form field. It describes the value's **type**, the **render metadata** (label, placeholder, hint, required), optional **hooks** (populate options, validate), and **dependencies** on other params. Every form surface on the platform — Action configs, Trigger configs, Auth inputs — is an ordered list of Params.

## Motivation

Actions, Triggers, Webhooks, and Auth all need to collect user input. Without a shared primitive each one re-invents form fields with subtly different shapes — we've already seen this inside the Auth RFC's `fields` array. One `Param` spec means:

- Any surface that needs a form references `Param[]`.
- Hosts implement **one** form renderer.
- Tooling (docs, generators, IDE hints) works uniformly across every surface.

## Goals

- Cover common value types: `string`, `text`, `number`, `boolean`, `select`, `multiselect`, `date`, `datetime`, `secret`, `file`, `json`, `code`.
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
| `showIf` | expression | ⬜ | Conditional visibility based on other field values. Syntax TBD (see Open Questions). |
| `options` | Options | ⬜ | For choice types. Static list or dynamic hook source. |
| `validation` | Validation | ⬜ | Declarative rules and/or a custom hook. |

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

## Hooks

| Hook | Receives | Returns | Purpose |
|---|---|---|---|
| `options.source` | `{ form, dependsOn }` | `Option[]` | Populate choices from an API or other dynamic source. |
| `validation.hook` | `{ value, form }` | `{ ok, message? }` | Custom validation beyond declarative rules. |

Hooks share the runtime contract with Auth hooks (defined in a separate runtime RFC).

## Dependencies

When param `B` declares `dependsOn: ["A"]`:

1. `B` renders as disabled until `A` has a value.
2. If `B` has `options.source`, the hook receives `A`'s value in the form state.
3. When `A` changes, `B`'s cached options are invalidated and `B`'s current value is cleared unless it is still a valid option.

Circular dependencies are rejected at manifest load time.

## Open questions

1. **`showIf` expression language.** Invent a mini expression shape (`{ "equals": ["plan", "pro"] }`), adopt JSONLogic, or require a hook?
2. **Grouping / sections / tabs.** Forms are flat lists today. When do we add section headers, tabs, or collapsible groups?
3. **i18n of labels / hints.** Localize inline on the Param (object keyed by locale) or defer to the enclosing manifest's `localizations` block?
4. **`repeat` vs nested schema.** `repeat: true` gives a list of a single scalar or field. For lists of structured items (e.g., `[{ header, value }, …]`) — do we need nested `Param[]` as a value type?
