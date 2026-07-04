# @w6w/expr

The platform's **expression engine** — a [JSONLogic](https://jsonlogic.com) evaluator. Used for
Param `showIf` visibility (and, later, output→input mapping in workflows). JSONLogic was chosen over
a bespoke mini-language in the ROADMAP.

Part of the [`core`](../../README.md) workspace.

## Usage

```ts
import { evaluate, showIf } from "@w6w/expr";

evaluate({ "==": [{ var: "plan" }, "pro"] }, { plan: "pro" }); // true
evaluate({ var: ["user.name", "anon"] }, {}); // "anon" (fallback)

// Param visibility — undefined rule means always visible:
showIf({ "!": { var: "advanced" } }, { advanced: false }); // true
```

## Supported operators

`var`, `missing` · `==` `===` `!=` `!==` · `<` `<=` `>` `>=` (with the chained "between" form, e.g.
`{ "<": [1, x, 10] }`) · `and` `or` `!` `!!` · `if` / `?:` (elseif chains) · `in` (string or array)
· `+` `-` `*` `/` `%`.

Unknown operators throw `ExprError`. JSONLogic truthiness applies (an empty array is falsy).

## API

| Export                  | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `evaluate(rule, data?)` | Evaluate a JSONLogic rule.                                  |
| `showIf(rule, data?)`   | Boolean coercion for Param visibility (undefined → `true`). |
| `isTruthy(value)`       | JSONLogic truthiness.                                       |
| `ExprError`             | Thrown on an unknown operator.                              |

## License

MIT
