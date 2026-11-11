# @w6w/expr

The platform's **expression engine** — a [JSONLogic](https://jsonlogic.com) evaluator used for Param
`showIf` visibility and workflow expressions. Editors can compile readable conditions into JSONLogic
with the authoring helpers below.

Part of the [`core`](https://github.com/w6w-io/w6w-core#readme) workspace.

## Install

```sh
npm install @w6w/expr
```

The npm package is **ESM-only**, built to `dist/` with `.d.ts` declarations. `require("@w6w/expr")`
also works on Node >= 20.19 / 22.12 (`require(esm)`). Deno and in-repo consumers keep importing
`mod.ts` by path.

The package also exposes a `w6w-source` export condition that resolves to `./mod.ts`. Only this
repo's own tools (the `@w6w/ui` and studio bundlers/typecheckers, which read the source tree) set
it; npm consumers never do, so they get `dist`.

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
· `+` `-` `*` `/` `%` · `??` — absent-coalescing (`null`/absent only — `0`, `""`, `false` are kept)
· `xor` — exactly one argument truthy (not in JSONLogic; always a boolean, every argument evaluated)
· `includes` (reverse `in`) · `include-any` / `include-all` (array comparisons).

Unknown operators throw `ExprError`. JSONLogic truthiness applies (an empty array is falsy). `??` is
the one exception: it never uses truthiness, only a `null`/`undefined` check.

### Membership and array comparisons

| Operator      | Meaning                                                 | Example that returns `true`                                   |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| `in`          | The right array contains the left value.                | `{ "in": ["email", ["name", "email"]] }`                      |
| `includes`    | The left array contains the right value.                | `{ "includes": [["name", "email"], "email"] }`                |
| `include-any` | The arrays share at least one value.                    | `{ "include-any": [["name", "email"], ["email", "status"]] }` |
| `include-all` | The left array contains every value in the right array. | `{ "include-all": [["name", "email"], ["email"]] }`           |

Both operands can be expressions, such as `{ "var": "trigger.event.changedFields" }`. Array
membership uses JavaScript `includes` equality, without type coercion (`1` differs from `"1"`);
objects compare by identity. Order and duplicate values do not affect array containment. An empty
right array makes `include-all` true and `include-any` false. Both return false when either operand
is not an array. `in` and `includes` also support substring checks on strings. The three new
operators are platform extensions to JSONLogic.

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
any operand begins `secrets.`; see
[`rfcs/workflow.md`](https://github.com/w6w-io/w6w-core/blob/main/rfcs/workflow.md)'s 2026-08-20
amendment for the full grammar.

### Inline expressions: ternary and comparisons

A marker may also hold a small expression. It lowers to the JSONLogic above:

```ts
parseTemplate("{{ var.a === var.b ? 'option1' : 'option2' }}");
// [{ kind: "expr", expr: { if: [{ "===": [{ var: "var.a" }, { var: "var.b" }] }, "option1", "option2"] } }]

parseTemplate("{{ var.n > 10 ? 'big' : var.n > 0 ? 'small' : 'none' }}");
// one flat `if`: [cond1, "big", cond2, "small", "none"]
```

| Syntax                                  | JSONLogic                         |
| --------------------------------------- | --------------------------------- |
| `c ? a : b` (right-associative)         | `if`                              |
| `===` `==` `!==` `!=` `<` `<=` `>` `>=` | the operator of the same name     |
| `&&` · `\|\|` · `??` · `!x` · `( … )`   | `and` · `or` · `??` · `!` · group |

From loosest to tightest: the ternary, `??`, `||`, `&&`, equality, relational, `!`. Operands are
paths (`steps.s.output.rows[0]['name']`), single- or double-quoted strings, numbers, `true`, `false`
and `null`. A `?` or `:` inside a string or a bracket index is not an operator.

The grammar engages only when the marker contains one of `?`, `:`, a comparison, `&&`, `!` or a
parenthesis. A bare path, `secrets.NAME`, a vendor placeholder and a flat `||`/`??` chain parse as
before. Malformed text falls back the same way, to a `var` part. Any operand that reads `secrets`
refuses the whole expression to a `var` part carrying the original text, as with a chain.
`serializeTemplate` prints the expression back as infix text with single-quoted strings, and falls
back to `{{ =<raw> }}` for a shape it cannot spell. See `rfcs/workflow.md`'s 2026-11-11 amendment.

## API

Editors can accept readable conditions and compile them to the existing JSONLogic format:

```ts
import { formatReadableExpression, parseReadableExpression } from "@w6w/expr";

const rule = parseReadableExpression('state.source == "eventbrite" && state.enabled');
evaluate(rule, { state: { source: "eventbrite", enabled: true } }); // true
formatReadableExpression(rule); // '(state.source == "eventbrite") && state.enabled'
```

The authoring syntax supports `==`, `!=`, `===`, `!==`, `<`, `<=`, `>`, `>=`, `&&`, `||`, `??`, `!`,
the ternary `cond ? a : b`, parentheses, dotted field paths and quoted
strings/numbers/booleans/null. It does not execute JavaScript or allow function calls. An optional
reference resolver expands an editor's short field names. Invalid input throws
`ReadableExpressionError` with a character position. The formatter returns `null` for legacy
JSONLogic outside this subset.

This is an editor compiler; workflow manifests still store JSONLogic expressions or their
`{{ =<jsonlogic> }}` template form. The runtime `{{ }}` grammar accepts the same operators (see
above).

| Export                  | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `evaluate(rule, data?)` | Evaluate a JSONLogic rule.                                  |
| `showIf(rule, data?)`   | Boolean coercion for Param visibility (undefined → `true`). |
| `isTruthy(value)`       | JSONLogic truthiness.                                       |
| `ExprError`             | Thrown on an unknown operator.                              |

## License

MIT
