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
· `+` `-` `*` `/` `%` · `??` — absent-coalescing (`null`/absent only — `0`, `""`, `false` are kept).

Unknown operators throw `ExprError`. JSONLogic truthiness applies (an empty array is falsy). `??` is
the one exception: it never uses truthiness, only a `null`/`undefined` check.

## The `{{ }}` template grammar's infix fallback chain

Besides the JSONLogic-object form above, `{{ }}` templates (`parseTemplate` / `parseRenderTemplate`
/ `serializeTemplate`) support a flat fallback chain spelled with the infix operators `||` and `??`,
which parses to an ordinary `expr` part — no new part kind:

```ts
import { parseTemplate, serializeTemplate } from "@w6w/expr";

parseTemplate('{{ inputs.from || "+1234567" }}');
// [{ kind: "expr", expr: { or: [{ var: "inputs.from" }, "+1234567"] } }]

serializeTemplate([{ kind: "expr", expr: { "??": [{ var: "vars.count" }, "0"] } }]);
// '{{ vars.count ?? "0" }}'
```

`||` maps to JSONLogic's `or`; `??` maps to the `??` operator above. The chain refuses to build —
falling through to an ordinary `var` reference — if it mixes `||` and `??`, has an empty operand, or
any operand begins `secrets.`; see `rfcs/workflow.md`'s 2026-08-20 amendment for the full grammar.

## API

| Export                  | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `evaluate(rule, data?)` | Evaluate a JSONLogic rule.                                  |
| `showIf(rule, data?)`   | Boolean coercion for Param visibility (undefined → `true`). |
| `isTruthy(value)`       | JSONLogic truthiness.                                       |
| `ExprError`             | Thrown on an unknown operator.                              |

## License

MIT
