---
id: null
key: "composition"
title: "Composition"
section: "reference-spec"
description: "How one call becomes a reusable operation, an entry point or a graph: Functions, Endpoints, Workflows, node types and triggers."
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

# Composition

How one call becomes a reusable operation, an entry point or a graph: Functions, Endpoints, Workflows, node types and triggers. Each page below is one RFC of the w6w specification.

- [Function](/reference-spec/composition/function/)
- [Endpoint](/reference-spec/composition/endpoint/)
- [Workflow](/reference-spec/composition/workflow/)
- [Node Types](/reference-spec/composition/node-types/)
- [Trigger](/reference-spec/composition/trigger/)

## Fan-out and merge

A step can have more than one outgoing edge. `fanOut` on the step says how those branches run:

- `"sequential"` (the default) — branches run one after another, in plan order.
- `"parallel"` — branches run concurrently. The run waits for all of them, and a downstream step with several inbound edges runs once, after every branch has arrived.

Use the `@w6w/control` `merge` step to join branches back into one value. `mode` is `"array"` (the branch outputs in incoming-edge order) or `"object"` (outputs shallow-merged, the later edge wins). Optional `entries` (`{ key?, value }`) pick exactly what goes in; without `entries`, `merge` behaves as `aggregate`. If an entry's `value` is a single reference, its type is preserved rather than turned into a string.

```json
{
  "steps": [
    { "id": "start", "app": "@w6w/trigger", "fanOut": "parallel" },
    { "id": "a", "app": "crm", "action": "getUser" },
    { "id": "b", "app": "billing", "action": "getPlan" },
    {
      "id": "join",
      "app": "@w6w/control",
      "action": "merge",
      "params": {
        "mode": "object",
        "entries": [
          { "key": "user", "value": "{{a.output}}" },
          { "key": "plan", "value": "{{b.output}}" }
        ]
      }
    }
  ],
  "edges": [
    { "from": "start", "to": "a" }, { "from": "start", "to": "b" },
    { "from": "a", "to": "join" }, { "from": "b", "to": "join" }
  ]
}
```

See the Workflow and Engine RFC amendments of 2026-10-07 for the exact semantics.
