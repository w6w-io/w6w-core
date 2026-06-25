# RFC: Action

**Status:** Final
**Author:** Segev Shmueli
**Date:** 2026-04-15 (revised 2026-06-01)

## Summary

An `Action` defines a single operation a user can perform through an App — reading data, searching for records, or executing a side effect. Actions are standalone files referenced from the App manifest. Each action declares its **type**, **title**, **description**, input **params**, an **execute** method, and an **output** shape for downstream step chaining.

## Motivation

Actions are how workflows interact with apps. A workflow step says "do X with App Y" — that's an action. Standardizing the action shape means:

- Publishers describe "what you can do with my app" once, uniformly.
- Hosts render config forms, validate inputs, and chain outputs without custom UI per action.
- The workflow editor can wire output fields from one action into input params of another.

## Goals

- Classify actions by intent: **read**, **search**, **perform**.
- Input via [Param](./param.md)[] (reuses the Param RFC).
- Declared output shape so downstream steps can reference fields.
- An `execute` method — the function that does the work.
- Standalone files referenced from App.
- Serialization-agnostic.

## Non-Goals

- Defining the execution runtime (deferred to runtime RFC).
- Batching / bulk operations.
- Scheduling / delayed execution — that's the workflow engine's concern.

## Concept

An Action is **one thing a user can do** with an App. Every action has a `type` that classifies its intent:

| Type | Side effects | Returns | Platform behavior |
|---|---|---|---|
| `read` | No | Single object or null | Cacheable. Safe to retry. Fetches a known record (e.g. by ID). |
| `search` | No | `{ items, nextCursor? }` | Cacheable. Cursor-paginated (see [Pagination](#pagination)). Matches criteria. |
| `perform` | Yes | Result object | Not cacheable by default. Set `idempotent: true` to declare safe to retry. Creates, updates, deletes, sends, etc. |

The type tells the platform how to treat the action — caching, retry safety, UI grouping — without inspecting what it actually does.

Actions use the App's Auth to sign outbound requests. The action never sees raw credentials; `sign` injects auth transparently (see [Auth RFC](./auth.md)). The stored, per-user instance of that auth is a [Connection](./connection.md); Action calls reference it through an [Invocation](./invocation.md).

Some params depend on others — a Variant param's options are a function of the Product param's value. This is handled by a **fixpoint resolution loop** that runs hooks until the form is stable, then `execute` is called. The algorithm is specified in [Param resolution](#param-resolution) below.

## Shape

### Read

```json
{
  "manifestVersion": "1",
  "key": "get-user",
  "type": "read",
  "title": "Get User",
  "description": "Fetch a user by ID.",
  "params": [
    { "key": "userId", "label": "User ID", "type": "string", "required": true }
  ],
  "execute": "./actions/get-user.ts",
  "output": [
    { "key": "id",    "type": "string", "label": "User ID" },
    { "key": "name",  "type": "string", "label": "Name" },
    { "key": "email", "type": "string", "label": "Email" }
  ]
}
```

### Search

```json
{
  "manifestVersion": "1",
  "key": "find-channels",
  "type": "search",
  "title": "Find Channels",
  "description": "Search for channels matching a query.",
  "resource": "channel",
  "params": [
    { "key": "query", "label": "Search query", "type": "string", "required": true },
    { "key": "limit", "label": "Max results",  "type": "number", "default": 10 }
  ],
  "execute": "./actions/find-channels.ts",
  "output": [
    { "key": "id",    "type": "string", "label": "Channel ID" },
    { "key": "name",  "type": "string", "label": "Channel Name" },
    { "key": "topic", "type": "string", "label": "Topic" }
  ],
  "sample": {
    "items": [
      { "id": "C01", "name": "general", "topic": "Company-wide" }
    ],
    "nextCursor": null
  }
}
```

### Perform

```json
{
  "manifestVersion": "1",
  "key": "send-message",
  "type": "perform",
  "title": "Send Message",
  "description": "Send a message to a Slack channel.",
  "resource": "message",
  "idempotent": false,
  "params": [
    {
      "key": "channelId",
      "label": "Channel",
      "type": "select",
      "options": { "source": "./hooks/list-channels.ts" },
      "required": true
    },
    {
      "key": "text",
      "label": "Message",
      "type": "text",
      "required": true
    },
    {
      "key": "threadTs",
      "label": "Thread",
      "type": "select",
      "dependsOn": ["channelId"],
      "options": { "source": "./hooks/list-threads.ts" },
      "hint": "Reply in a thread. Leave empty to post to the channel."
    }
  ],
  "execute": "./actions/send-message.ts",
  "output": [
    { "key": "ts",      "type": "string", "label": "Message Timestamp" },
    { "key": "channel", "type": "string", "label": "Channel ID" }
  ]
}
```

## Output

Output declares the shape of what the action returns, so downstream workflow steps can map fields into their own params.

**Static** — declared inline when the output shape is known at publish time:

```json
"output": [
  { "key": "id",   "type": "string", "label": "Record ID" },
  { "key": "name", "type": "string", "label": "Name" }
]
```

**Dynamic** — via a hook when the output shape depends on configuration (e.g. "Get Spreadsheet Row" where columns are user-defined):

```json
"output": {
  "source": "./hooks/output-fields.ts"
}
```

The `source` hook receives the current param values and returns an `OutputField[]`. This follows the same pattern as [Param](./param.md)'s dynamic `options`.

## Pagination

`search` Actions return `{ items, nextCursor? }`. The cursor is **opaque to the platform** — its shape is the publisher's choice, but it MUST be a JSON-serializable value (string, number, or plain object).

```ts
type SearchResult<T> = {
  items: T[];
  /** Pass back into the next call's `cursor` param. Absent / null = no more results. */
  nextCursor?: unknown;
};
```

Hosts MAY auto-supply a `cursor` param into the action's `params` if one isn't declared; publishers SHOULD declare it explicitly when they want it user-visible (e.g. for manual pagination in the editor).

Offset-based or page-based APIs translate trivially: the publisher's `execute` hook converts `cursor` to/from `?page=N` or `?offset=N`. The platform does not need to model the underlying scheme.

## Param resolution

The Param RFC defines `dependsOn` for inter-param dependencies and `options.source` for dynamically populating choices. This section formalizes how those interact at the Action level — the algorithm that runs whenever params change, in both the form editor and at Invocation time.

### Algorithm

Given a partial set of param values, the host runs a fixpoint loop:

1. Build the dependency DAG from each param's `dependsOn`. Cycles are rejected at manifest load (Param RFC requires this).
2. Mark each param:
   - **resolved** — has a value (user-supplied, `default`, or computed).
   - **blocked** — has unresolved `dependsOn`.
   - **resolvable** — all `dependsOn` are resolved; no value yet.
3. For each resolvable param with `options.source`:
   - Invoke the source hook with the current form state.
   - The returned `Option[]` becomes the param's available choices.
4. If a resolvable param has a `default` that is a valid option (or the param has no `options`), set the value to the default.
5. Re-mark all params and repeat until a pass changes nothing.
6. Validate every resolved value against the param's declarative rules and `validation.hook`.

The loop terminates because the DAG is acyclic and each pass either resolves a param or runs no work. The loop is **monotonic by external input** — only user choice (in the editor) or supplied values (in an Invocation) advance state.

### When resolution runs

| Trigger | Behavior |
|---|---|
| Editor — user opens the form | Run from scratch with defaults as the only resolved set. |
| Editor — user edits a value | Invalidate downstream cached options; re-run from the changed node. The user's existing downstream values are kept only if still valid options. |
| Invocation — programmatic call | Run over the supplied `params`. Hooks may be re-run to validate that supplied values are valid options under the current dependency state. Missing `dependsOn` references reject the Invocation. |
| Replay — re-running a recorded Run | Skip resolution. Replay uses the previously-recorded resolved values verbatim so executions are deterministic. |

### Example

```json
"params": [
  {
    "key": "productId",
    "label": "Product",
    "type": "select",
    "options": { "source": "./hooks/list-products.ts" },
    "required": true
  },
  {
    "key": "variantId",
    "label": "Variant",
    "type": "select",
    "dependsOn": ["productId"],
    "options": { "source": "./hooks/list-variants.ts" },
    "required": true
  },
  {
    "key": "quantity",
    "label": "Quantity",
    "type": "number",
    "default": 1,
    "required": true
  }
]
```

Resolution sequence in the editor:

1. **Pass 1.** `productId` is resolvable → `list-products` runs → user picks `"shoes-42"`. `quantity` resolves to `1` from its default.
2. **Pass 2.** `variantId` is now unblocked → `list-variants` runs with `{ productId: "shoes-42" }` in scope → user picks `"red-9"`.
3. **Pass 3.** Nothing changes → fixpoint reached → form ready to submit.

Resolution in a programmatic Invocation with `params: { productId: "shoes-42", variantId: "red-9", quantity: 2 }`:

1. **Pass 1.** All three params are already resolved.
2. **Pass 2.** Validate `variantId` is still a valid option under `productId: "shoes-42"` by running `list-variants`. Reject `param_invalid` if it's not.
3. **Pass 3.** No changes → call `execute`.

### Implications

- `options.source` is not a value derivation. It returns the *set* of valid options; picking one requires either user input or a value already supplied. The platform never silently picks one for the caller.
- Validation reuses the option list as an implicit `enum`. A supplied select value MUST be in the resolved option list.
- Hooks run during resolution share the runtime contract with all other hooks (Auth `sign`, Param `validation.hook`, Action `execute`) — see [Hook Runtime RFC](./hook-runtime.md).

## Field reference

### Top-level

| Field | Type | Required | Description |
|---|---|---|---|
| `manifestVersion` | string | ✅ | Core spec version. |
| `key` | string | ✅ | Machine name. Unique within the App. Lowercase, kebab-case. |
| `type` | enum | ✅ | `"read"` \| `"search"` \| `"perform"`. |
| `title` | string | ✅ | Human-facing name (e.g. "Send Message"). |
| `description` | string | ⬜ | One-line summary of what the action does. |
| `resource` | string | ⬜ | UI grouping hint. Actions sharing the same `resource` value (e.g. `"channel"`, `"message"`) are grouped together in the editor. Purely presentational — no structural meaning. |
| `idempotent` | boolean | ⬜ | `perform` Actions only. Declares the operation is safe to re-execute with the same inputs (e.g. `PUT`-shaped). Drives the platform's retry policy and lets [Invocation](./invocation.md) use `invocationId` as a dedupe key. Defaults to `false`. |
| `requiresAuth` | boolean | ⬜ | When the enclosing App declares Auth methods, set `false` to opt this Action out of requiring a Connection (e.g. a public `health` endpoint). Defaults to `true` when the App has auth, `false` when it doesn't. |
| `params` | [Param](./param.md)[] | ⬜ | Inputs collected from the user in the workflow editor. |
| `execute` | string (path) \| function | ✅ | The method that executes this action. Path reference or co-located function — see [Hook Runtime RFC §Module format](./hook-runtime.md#module-format). |
| `output` | OutputField[] \| `{ source }` | ⬜ | Shape of the return value. Static array or dynamic hook. |
| `sample` | object | ⬜ | An example value matching `output`. Used by the editor for richer field-mapper previews (Zapier-style). Not used for validation. |

### OutputField

| Field | Type | Required | Description |
|---|---|---|---|
| `key` | string | ✅ | Machine name. Dot notation for nested paths (`message.id`). |
| `type` | string | ✅ | `"string"` \| `"number"` \| `"boolean"` \| `"object"` \| `"array"`. |
| `label` | string | ✅ | Human-facing name shown in the field mapper. |

## Resolved questions

| Question | Resolution |
|---|---|
| Pagination contract for `search` | **Cursor.** `search` returns `{ items, nextCursor? }`. The cursor is opaque to the platform; publishers translate to offset/page schemes inside `execute`. |
| Idempotency hints | Added optional `idempotent: boolean` on `perform` Actions. Drives retry policy and Invocation dedupe. |
| Resource grouping | Added optional `resource: string` for UI grouping. Purely presentational — actions remain a flat list structurally. |
| Sample data | Added optional `sample` alongside `output`. Cheap to spec, big editor UX win. |
| Connectionless actions | Added optional `requiresAuth` to opt an Action out of needing a Connection even when the App declares Auth (resolves the corresponding Invocation question). |
