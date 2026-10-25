---
id: null
key: "build-a-w6w-app/dynamic-fields"
title: "Dynamic fields"
section: "build-apps"
description: "Offer choices from the user's own account: one `resolveFields` hook fills several pickers, refreshes them when a parent changes, and keeps a value it cannot confirm."
format: "markdown"
shared: true
sourceRepo: null
sourcePath: null
sourceSha: null
sourceRefSha: null
sourceUrl: null
syncedAt: null
createdAt: null
updatedAt: null
---

# Dynamic fields

Some params can only offer real choices once w6w knows which account the call will run against —
the models the user's Anthropic key can reach, the organizers under one Eventbrite organization.
A **dynamic field** fetches those choices from the user's own connection while they fill the form,
instead of shipping a fixed list that goes stale.

One hook per Action, `resolveFields`, answers for all of them in a single call: the editor sends the
form's literal values, the hook returns options for the keys it was asked about, and every picker
fills at once. The feature is specified in the [Param](/reference-spec/app-contract/param/) and
[Action](/reference-spec/app-contract/action/) RFCs; this page is how to use it in an App.

## Declare a dynamic field

A param becomes dynamic through `options.source`. The reserved string `"resolveFields"` names the
Action's own hook; a `./`-relative path names a per-field hook module instead. The two arms cannot
collide — a path always starts with `./`.

```ts
// The Anthropic app's `model` param.
{
  key: "model",
  label: "Model",
  type: "string",
  required: true,
  default: "claude-opus-4-1-20250805",
  options: { source: "resolveFields" },
  config: { allowCustom: true },
  hint: "Pick a model or type any model id.",
}
```

Two optional pieces go with it:

| Setting | Where it goes | What it does |
| --- | --- | --- |
| `refreshOn` | inside `options`, beside `source` | The sibling keys whose **commit** (a pick for a select or combobox, blur for a text input — never per keystroke) refetches this field's options. Unlike `dependsOn` it never disables the field, so a typed-in value stays possible before the parent is chosen. |
| `config.allowCustom` | `config` on the param | Turns the field into a combobox that also accepts free text. Without it, the returned options constrain the value exactly as before. |

The Eventbrite app uses both, because an organizer belongs to an organization:

```ts
// The Eventbrite app's create-event params, trimmed.
params: [
  {
    key: "organizationId",
    label: "Organization ID",
    type: "string",
    required: true,
    options: { source: "resolveFields" },
    config: { allowCustom: true },
  },
  {
    key: "organizerId",
    label: "Organizer ID",
    type: "string",
    options: { source: "resolveFields", refreshOn: ["organizationId"] },
    config: { allowCustom: true },
  },
  // …
],
resolveFields: resolveEventbriteFields,
```

Picking a different organization refetches `organizerId` and nothing else. Do **not** write a
`resolveFields: true` flag anywhere: `describe` sets it on your public manifest when the Action's
definition carries the function.

## Write the hook

`resolveFields` is a hook like any other — `(input, ctx)`, declared once on the Action object next
to `params` and `execute`. Its input is what the editor knows, and nothing that only exists at run
time:

| Key | Type | What it holds |
| --- | --- | --- |
| `reason` | `"init"` \| `"change"` | `init` opens the form; `change` follows a commit of a key named in some field's `refreshOn`. |
| `form` | `Record<string, unknown>` | The form's **literal** values only. |
| `previous` | `Record<string, unknown>` \| absent | The values the fields had before the change that triggered this call. |
| `changed` | `string[]` \| absent | The key(s) whose commit triggered a `change` call. |
| `fields` | `string[]` | The keys to answer for. Return options for these and ignore the rest. |
| `unresolved` | `string[]` | Keys the editor withheld because their value is an expression, a `{ type: "secret" }` envelope or a var binding. |

Return `{ fields: Record<key, { options?, error? }> }`: `options` is an `Option[]` of
`{ value, label, description? }`, and `error` is a per-field message instead — one field failing
does not spoil the others.

A full example, from the Eventbrite app. `organizationId` loads the user's organizations;
`organizerId` depends on it, and when the organization is still empty it offers every organizer with
the organization's name as the option's `description`:

```ts
export const resolveEventbriteFields: ResolveFieldsHook = async (input, ctx) => {
  const fields: Record<string, { options: Option[] }> = {};

  if (input.fields.includes("organizationId")) {
    const orgs = await listOrgs(ctx); // GET /users/me/organizations/
    fields.organizationId = { options: orgs.map((o) => ({ value: o.id, label: o.name ?? o.id })) };
  }

  if (input.fields.includes("organizerId") && !input.unresolved.includes("organizationId")) {
    const orgId = input.form.organizationId;
    let options: Option[];
    if (typeof orgId === "string" && orgId !== "") {
      const organizers = await listOrganizers(ctx, orgId); // GET /organizations/<id>/organizers/
      options = organizers.map((o) => ({ value: o.id, label: o.name ?? o.id }));
    } else {
      options = [];
      for (const org of await listOrgs(ctx)) {
        if (options.length >= MAX_OPTIONS) break;
        for (const o of await listOrganizers(ctx, org.id)) {
          options.push({ value: o.id, label: o.name ?? o.id, description: org.name ?? org.id });
        }
      }
      options = options.slice(0, MAX_OPTIONS);
    }
    fields.organizerId = { options };
  }

  return { fields };
};
```

The Anthropic app's hook is the single-field case: it pages `GET /v1/models` (via `after_id`),
sorted newest first, `label` from `display_name` with the id as fallback, `description` from
`created_at`, capped at 1 000 options.

Four rules the host enforces around your hook:

- **No credential.** It runs in phase `resolution`, and `ctx.connection` is redacted. `ctx.fetch`
  is signed exactly as it is for `action.execute`, behind the same `network.allow`, so the same
  manifest hosts apply.
- **10 s.** This is the one hook the host caps at 10 seconds rather than the 30 000 ms default,
  because it sits in the editor's critical path. Page enough to be useful, not enough to time out.
- **Your output is untrusted.** The host drops any key it did not ask for and validates the rest:
  `value` must be a string or number, `label` is a string, and it takes at most 1 000 options per
  field.
- **A throw becomes a field error.** An error out of the hook surfaces as a `W6WError` in phase
  `resolution`, and the editor shows it on the fields that call asked for, with a retry.

## When the hook runs

| Moment | What the host does |
| --- | --- |
| The user opens the form | One `init` call asking for every `source: "resolveFields"` field. |
| A `refreshOn` key is committed | One `change` call asking only for that key's dependants. A newer request aborts an older in-flight one. |
| An Invocation or a replay | Nothing. Invocation does not re-run `resolveFields` to validate a supplied value, and replay uses the previously resolved values verbatim. |

A `resolveFields` call is **not** an Invocation — there is no verdict, no run history entry and
nothing to replay — but it is still metered: the global metering middleware records it as one
`api_call`, the same as a connection test, so it does count toward usage. It passes the normal auth
guard and the per-subject rate limit too, so a hook that pages a large account gets the same
treatment as any other API call.

## What the editor does with what you return

The editor never silently drops a value the user already has. The rules, in the order they bite:

1. **Kept and flagged.** On `init`, or on any refetch where the current value is not in the returned
   list, the value is kept and flagged inline as not in the returned list — the user can see that
   the account no longer offers it and decide what to do.
2. **Cleared only for a strict select.** The one exception is a `change` caused by a `refreshOn` key
   on a field **without** `allowCustom`: there the stale value is cleared. A field with
   `allowCustom` keeps the value and flags it, because the value was still legal to type.
3. **Types the value instead.** With `config.allowCustom`, the field is a combobox: the returned
   options are suggestions, and the user can type a value your hook never returned. The Anthropic
   app's `model` hint says as much, and both shipped apps set the flag — a new model or a newly
   created organizer should not require a deploy of the App.
4. **Expressions, secrets and vars are never sent.** Their keys arrive in `unresolved` instead. A
   dynamic field whose `refreshOn` key is unresolved falls back to the field's static options or to
   free text and shows that its options are unavailable; the dynamic field itself can still be bound
   with an expression, and the ƒx binding keeps working.

That is why a field can usefully be dynamic *and* `allowCustom` *and* still expression-bound: the
hook is a convenience, not a validator. Invocation re-checks nothing about `resolveFields`; validate
what matters in the Action's own code.

## Checklist

- Declare the hook once on the Action, next to `params`, and export the function from your app.
- Ask only for what you return, and return options for every key in `input.fields` — a missing key
  reads as "no options" to the user.
- Use `refreshOn` for the parent key instead of `dependsOn`, unless the child genuinely cannot be
  answered without it.
- Set `config.allowCustom` whenever the vendor lets the user supply an id the API will accept; it
  removes the dead end when no connection is picked yet or the list would be empty.
- Handle a thrown request per field (`error`) rather than for the whole form — one unreachable
  endpoint should not blank every picker.

## Where to next

- **[Build a w6w App](/build-apps/build-a-w6w-app/)**: the rest of an Action's shape, and the
  sandbox rules this hook runs under.
- **[Spec: Param](/reference-spec/app-contract/param/)**: `refreshOn`, `config.allowCustom` and the
  two arms of `options.source` in full.
- **[Spec: Action](/reference-spec/app-contract/action/)**: when resolution runs, at editor time and
  at Invocation time.
- **[Spec: Hook runtime](/reference-spec/host-runtime/hook-runtime/)**: the `action.resolveFields`
  row of the hook registry, its sandbox and its 10 s cap.
