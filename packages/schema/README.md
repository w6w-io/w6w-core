# @w6w/schema

JSON Schema (Draft 2020-12) definitions for every primitive in the Core spec. One schema per RFC.

| Schema              | RFC                                       |
| ------------------- | ----------------------------------------- |
| `appSchema`         | [App](../../rfcs/app.md)                  |
| `actionSchema`      | [Action](../../rfcs/action.md)            |
| `authSchema`        | [Auth](../../rfcs/auth.md)                |
| `paramSchema`       | [Param](../../rfcs/param.md)              |
| `imageObjectSchema` | [ImageObject](../../rfcs/image-object.md) |
| `connectionSchema`  | [Connection](../../rfcs/connection.md)    |
| `invocationSchema`  | [Invocation](../../rfcs/invocation.md)    |

```ts
import { appSchema, schemas } from "@w6w/schema";

// Use with any Draft 2020-12 validator (Ajv, @cfworker/json-schema, etc.).
schemas.app === appSchema;
```

## What this covers vs. `@w6w/validator`

JSON Schema is the **structural** layer — types, required fields, enums, regex patterns, basic
ranges. It catches "your `categories` is a string, not an array" and "your `id` doesn't look like
reverse-DNS."

[`@w6w/validator`](../validator/README.md) is the **spec-rule** layer — cross-field invariants
("`apiKey` auth must declare an `apiKey` block"), the controlled vocabulary check for `categories`,
URL parsing for OAuth endpoints, and other rules that don't fit cleanly in JSON Schema.

A complete validation runs both layers. Hosts may choose just one; combining them is recommended.

## License

MIT
