import { assertEquals } from "jsr:@std/assert@^1.0.0";
import type { ExprPart } from "../../types/mod.ts";
import {
  coalesceOperandRefs,
  evaluate,
  hasRefusedChainToken,
  parseCoalesceChain,
  parseRenderTemplate,
  parseTemplate,
  serializeTemplate,
} from "../mod.ts";

Deno.test("plain text → single text part", () => {
  assertEquals(parseTemplate("hello world"), [{ kind: "text", value: "hello world" }]);
});

Deno.test("empty string → no parts", () => {
  assertEquals(parseTemplate(""), []);
});

Deno.test("a variable path → var part with the full path", () => {
  assertEquals(parseTemplate("{{ vars.env }}"), [{ kind: "var", ref: "vars.env" }]);
});

Deno.test("a step-output path → var part", () => {
  assertEquals(parseTemplate("{{ steps.fetch.output.title }}"), [
    { kind: "var", ref: "steps.fetch.output.title" },
  ]);
});

Deno.test("secrets.NAME → secret part keyed by bare name", () => {
  assertEquals(parseTemplate("{{ secrets.jwt_key }}"), [{ kind: "secret", ref: "jwt_key" }]);
});

Deno.test("=<json> → expr part with parsed JSONLogic", () => {
  assertEquals(parseTemplate('{{ ={"var":"vars.n"} }}'), [
    { kind: "expr", expr: { var: "vars.n" } },
  ]);
});

Deno.test("=<non-json> → expr part keeps the raw string", () => {
  assertEquals(parseTemplate("{{ =a + b }}"), [{ kind: "expr", expr: "a + b" }]);
});

Deno.test("mixed literal + refs preserves order and text runs", () => {
  assertEquals(parseTemplate("Bearer {{ secrets.jwt }} on {{ vars.env }}!"), [
    { kind: "text", value: "Bearer " },
    { kind: "secret", ref: "jwt" },
    { kind: "text", value: " on " },
    { kind: "var", ref: "vars.env" },
    { kind: "text", value: "!" },
  ]);
});

Deno.test("unterminated {{ is treated as literal text", () => {
  assertEquals(parseTemplate("a {{ vars.x"), [{ kind: "text", value: "a {{ vars.x" }]);
});

Deno.test("whitespace inside braces is trimmed", () => {
  assertEquals(parseTemplate("{{    vars.env    }}"), [{ kind: "var", ref: "vars.env" }]);
});

Deno.test("serialize is the inverse of parse (round-trip)", () => {
  const src = "Bearer {{ secrets.jwt }} on {{ vars.env }} #{{ steps.a.output.n }}";
  assertEquals(serializeTemplate(parseTemplate(src)), src);
});

Deno.test("round-trip of an expr part", () => {
  const parts = parseTemplate('{{ ={"+":[1,2]} }}');
  assertEquals(serializeTemplate(parts), '{{ ={"+":[1,2]} }}');
});

Deno.test("serialize prunes nothing and masks nothing structurally", () => {
  assertEquals(
    serializeTemplate([
      { kind: "text", value: "x=" },
      { kind: "var", ref: "vars.y" },
    ]),
    "x={{ vars.y }}",
  );
});

// --- balanced `}}` close: an expr arm whose JSON ends in an object ----------

Deno.test("=<json ending in an object> parses to the parsed object, not a truncated raw string", () => {
  assertEquals(parseTemplate('{{ ={"missing":{"var":"a"}} }}'), [
    { kind: "expr", expr: { missing: { var: "a" } } },
  ]);
  assertEquals(parseTemplate('{{ ={"map":{"var":"x"}} }}'), [
    { kind: "expr", expr: { map: { var: "x" } } },
  ]);
});

Deno.test("the balanced close is string-aware: a `}}` inside a JSON string does not end the arm", () => {
  assertEquals(parseTemplate('{{ ={"a":"}}"} }}'), [{ kind: "expr", expr: { a: "}}" } }]);
});

Deno.test(
  String.raw`parseTemplate: a \" escape inside a JSON string does not end the balanced scan`,
  () => {
    // The `\"` inside the JSON string must be skipped whole by `findBalancedClose`;
    // delete that branch and the scan stops at the `}}` *inside* the string, yielding
    // two parts (a truncated `expr` plus a stray `text`) instead of one.
    const parts = parseTemplate(String.raw`{{ ={"a":"}}\""} }}`);
    assertEquals(parts.length, 1);
    assertEquals(parts[0].expr, { a: '}}"' });
  },
);

Deno.test("neighbours on both sides of an object-ending expr arm stay intact", () => {
  assertEquals(parseTemplate('x {{ ={"a":{"b":1}} }} y {{ vars.z }}'), [
    { kind: "text", value: "x " },
    { kind: "expr", expr: { a: { b: 1 } } },
    { kind: "text", value: " y " },
    { kind: "var", ref: "vars.z" },
  ]);
});

Deno.test("unbalanced/half-typed expr input falls back to today's first-`}}` behaviour", () => {
  assertEquals(parseTemplate('{{ ={"a": 1 }}'), [{ kind: "expr", expr: '{"a": 1' }]);
});

// --- idempotent round trip over the nine measured cases (stream B) ---------

Deno.test("idempotent round trip + fidelity over the measured corpus", () => {
  const CORPUS: ExprPart[][] = [
    [{ kind: "expr", expr: { missing: { var: "a" } } }],
    [{ kind: "var", ref: "secrets.foo" }],
    [{ kind: "text", value: "literal {{ vars.x }} here" }],
    [{ kind: "secret", ref: "jwt_key" }],
    [{ kind: "expr", expr: { if: [{ var: "x" }, { var: "y" }, "n"] } }],
    [
      { kind: "text", value: "line1\nline2 " },
      { kind: "var", ref: "vars.x" },
      { kind: "text", value: "\n" },
    ],
    [
      { kind: "var", ref: "vars.a" },
      { kind: "var", ref: "vars.b" },
    ],
    [
      { kind: "var", ref: "vars.a" },
      { kind: "text", value: " " },
      { kind: "var", ref: "vars.b" },
    ],
    [{ kind: "expr", expr: "a + b" }],
    // `{{ inputs.from || "+1234567" }}` — the intake screenshot's fallback chain.
    [{ kind: "expr", expr: { or: [{ var: "inputs.from" }, "+1234567"] } }],
    // `{{ inputs.form || inputs.form2 || vars.defaultValue }}` — three-operand chain.
    [{
      kind: "expr",
      expr: { or: [{ var: "inputs.form" }, { var: "inputs.form2" }, { var: "vars.defaultValue" }] },
    }],
  ];
  for (const [n, parts] of CORPUS.entries()) {
    const t = serializeTemplate(parts);
    assertEquals(serializeTemplate(parseTemplate(t)), t, `case ${n + 1} not idempotent`);
  }
  // full fidelity for every case except the two by-design promotions (index 1, 2)
  for (const i of [0, 3, 4, 5, 6, 7, 8, 9, 10]) {
    assertEquals(parseTemplate(serializeTemplate(CORPUS[i])), CORPUS[i], `case ${i + 1} fidelity`);
  }
});

Deno.test("a `var` ref starting `secrets.` promotes to a `secret` part on round trip (by design)", () => {
  const parts: ExprPart[] = [{ kind: "var", ref: "secrets.foo" }];
  assertEquals(parseTemplate(serializeTemplate(parts)), [{ kind: "secret", ref: "foo" }]);
});

Deno.test("text containing `{{ … }}` promotes that span to a chip on round trip (by design)", () => {
  const parts: ExprPart[] = [{ kind: "text", value: "literal {{ vars.x }} here" }];
  assertEquals(parseTemplate(serializeTemplate(parts))[1], { kind: "var", ref: "vars.x" });
});

Deno.test("a value ending in a trailing newline survives the round trip", () => {
  const parts: ExprPart[] = [
    { kind: "var", ref: "vars.x" },
    { kind: "text", value: "\n" },
  ];
  const t = serializeTemplate(parts);
  assertEquals(serializeTemplate(parseTemplate(t)), t);
  assertEquals(parseTemplate(t), parts);
});

// --- render mode: structural, not a post-filter -----------------------------

Deno.test("render mode: secrets.NAME falls through to the var arm — not dropped, not text", () => {
  assertEquals(parseTemplate("{{ secrets.foo }}", "render"), [
    { kind: "var", ref: "secrets.foo" },
  ]);
});

Deno.test("render mode: nothing is dropped and order is preserved", () => {
  assertEquals(parseTemplate("Hi {{ secrets.a }} and {{ vars.b }}!", "render"), [
    { kind: "text", value: "Hi " },
    { kind: "var", ref: "secrets.a" },
    { kind: "text", value: " and " },
    { kind: "var", ref: "vars.b" },
    { kind: "text", value: "!" },
  ]);
});

Deno.test("render mode keeps the `=` arm, including the balanced scan", () => {
  assertEquals(parseTemplate('{{ ={"var":"vars.n"} }}', "render"), [
    { kind: "expr", expr: { var: "vars.n" } },
  ]);
  assertEquals(parseTemplate('{{ ={"missing":{"var":"a"}} }}', "render"), [
    { kind: "expr", expr: { missing: { var: "a" } } },
  ]);
});

Deno.test("editor mode (the default) still promotes secrets.NAME to a secret part", () => {
  assertEquals(parseTemplate("{{ secrets.foo }}"), [{ kind: "secret", ref: "foo" }]);
});

Deno.test("render mode never emits a secret part, over hostile spellings", () => {
  const hostile = [
    "{{ secrets.API_KEY }}",
    "{{ secrets. }}",
    "{{   secrets.a.b   }}",
    '{{ ={"var":"secrets.API_KEY"} }}',
    "{{ render:doc }}",
    "{{ =render }}",
  ];
  for (const t of hostile) {
    for (const p of parseTemplate(t, "render")) {
      assertEquals(
        ["text", "var", "expr"].includes(p.kind),
        true,
        `emitted kind=${p.kind} for ${t}`,
      );
    }
  }
});

// --- the render entry point: no mode parameter to forget --------------------

Deno.test("parseRenderTemplate: the render mode cannot be deselected", () => {
  // 1. the fixture DISCRIMINATES: the defaulted entry point really does emit a secret part
  assertEquals(parseTemplate("{{ secrets.jwt }}").some((p) => p.kind === "secret"), true);
  // 2. the render entry point, called the way the engine calls it, emits none
  assertEquals(parseRenderTemplate("{{ secrets.jwt }}").some((p) => p.kind === "secret"), false);
  // 3. …and cannot be argued out of it — no second argument selects the unfenced mode
  const loose = parseRenderTemplate as unknown as (s: string, m?: unknown) => ExprPart[];
  assertEquals(loose("{{ secrets.jwt }}", "editor").some((p) => p.kind === "secret"), false);
  // 4. …and it is not vacuous: it returns the same parts the fenced mode returns, not nothing
  assertEquals(
    parseRenderTemplate("a {{ vars.env }} b"),
    parseTemplate("a {{ vars.env }} b", "render"),
  );
});

// --- infix fallback chain: `||` and `??` ------------------------------------

Deno.test("|| chain → an `or` expr part, path operands as `var`, literal operands parsed", () => {
  assertEquals(parseTemplate('{{ inputs.from || "+1234567" }}'), [
    { kind: "expr", expr: { or: [{ var: "inputs.from" }, "+1234567"] } },
  ]);
});

Deno.test("?? chain → a `??` expr part", () => {
  assertEquals(parseTemplate('{{ inputs.from ?? "+1" }}'), [
    { kind: "expr", expr: { "??": [{ var: "inputs.from" }, "+1"] } },
  ]);
});

Deno.test("a chain of more than two operands stays flat, left-to-right", () => {
  assertEquals(parseTemplate("{{ inputs.form || inputs.form2 || vars.defaultValue }}"), [
    {
      kind: "expr",
      expr: { or: [{ var: "inputs.form" }, { var: "inputs.form2" }, { var: "vars.defaultValue" }] },
    },
  ]);
});

Deno.test("numeric, boolean and null literal operands parse as JSON primitives, not var refs", () => {
  assertEquals(parseTemplate("{{ vars.n || 10 }}"), [
    { kind: "expr", expr: { or: [{ var: "vars.n" }, 10] } },
  ]);
  assertEquals(parseTemplate("{{ vars.b || true }}"), [
    { kind: "expr", expr: { or: [{ var: "vars.b" }, true] } },
  ]);
  assertEquals(parseTemplate("{{ vars.x ?? null }}"), [
    { kind: "expr", expr: { "??": [{ var: "vars.x" }, null] } },
  ]);
});

Deno.test("a quoted operand keeps an internal `||`/`??` opaque — not a further split", () => {
  assertEquals(parseTemplate('{{ inputs.from || "a||b" }}'), [
    { kind: "expr", expr: { or: [{ var: "inputs.from" }, "a||b"] } },
  ]);
  assertEquals(parseTemplate('{{ inputs.from ?? "a??b" }}'), [
    { kind: "expr", expr: { "??": [{ var: "inputs.from" }, "a??b"] } },
  ]);
});

Deno.test("a quoted operand containing `}}` widens the close scan, string-aware", () => {
  assertEquals(parseTemplate('{{ inputs.from || "a}}b" }}'), [
    { kind: "expr", expr: { or: [{ var: "inputs.from" }, "a}}b"] } },
  ]);
});

Deno.test("the widened scan never engages for a marker with no top-level chain token", () => {
  // Not a second `}}` scanner: every ordinary marker keeps first-`}}` close-finding.
  assertEquals(parseTemplate("{{ vars.a }}"), [{ kind: "var", ref: "vars.a" }]);
  assertEquals(parseTemplate("{{name}}"), [{ kind: "var", ref: "name" }]);
  assertEquals(parseTemplate('{{ "a}}b" }}')[0], { kind: "var", ref: '"a' });
});

Deno.test("refusal: mixed || and ?? in one chain falls through to a var part", () => {
  const parts = parseTemplate("{{ vars.a || vars.b ?? vars.c }}");
  assertEquals(parts, [{ kind: "var", ref: "vars.a || vars.b ?? vars.c" }]);
  assertEquals(hasRefusedChainToken((parts[0] as { ref: string }).ref), true);
});

Deno.test("refusal: a secrets.-prefixed operand falls through to a var part, never a secret", () => {
  const parts = parseTemplate('{{ secrets.K || "x" }}');
  assertEquals(parts, [{ kind: "var", ref: 'secrets.K || "x"' }]);
  assertEquals(hasRefusedChainToken((parts[0] as { ref: string }).ref), true);
});

Deno.test("refusal: a secrets. operand in ANY position refuses the chain, not just the first", () => {
  // A first-operand-only check would build a chain here — assert the LATER operand also refuses.
  const parts = parseTemplate("{{ vars.a || secrets.K }}");
  assertEquals(parts, [{ kind: "var", ref: "vars.a || secrets.K" }]);
  assertEquals(hasRefusedChainToken((parts[0] as { ref: string }).ref), true);
});

Deno.test("refusal: an empty operand falls through to a var part", () => {
  const parts = parseTemplate("{{ vars.a || }}");
  assertEquals(parts, [{ kind: "var", ref: "vars.a ||" }]);
  assertEquals(hasRefusedChainToken((parts[0] as { ref: string }).ref), true);
});

Deno.test("a plain secrets.NAME with no operator is unaffected by the chain arm", () => {
  assertEquals(parseTemplate("{{ secrets.jwt_key }}"), [{ kind: "secret", ref: "jwt_key" }]);
});

Deno.test("the `=` escape hatch is checked before the chain arm — a JSONLogic chain payload wins", () => {
  assertEquals(parseTemplate('{{ ="a" || "b" }}' /* not valid JSON → raw expr, unaffected */), [
    { kind: "expr", expr: '"a" || "b"' },
  ]);
});

Deno.test("render-mode parity: the chain arm is mode-independent, exactly like `=`", () => {
  assertEquals(
    parseTemplate('{{ inputs.from || "+1234567" }}', "render"),
    parseTemplate('{{ inputs.from || "+1234567" }}'),
  );
  assertEquals(
    parseTemplate('{{ inputs.from ?? "+1" }}', "render"),
    parseTemplate('{{ inputs.from ?? "+1" }}'),
  );
});

Deno.test("render-mode refusal: a secrets.-prefixed operand never yields a secret part", () => {
  assertEquals(parseTemplate('{{ secrets.K || "x" }}', "render"), [
    { kind: "var", ref: 'secrets.K || "x"' },
  ]);
});

Deno.test("serialize: a recognised chain payload emits the infix form", () => {
  assertEquals(
    serializeTemplate([{ kind: "expr", expr: { or: [{ var: "vars.a" }, "x"] } }]),
    '{{ vars.a || "x" }}',
  );
  assertEquals(
    serializeTemplate([{ kind: "expr", expr: { "??": [{ var: "vars.count" }, 0] } }]),
    "{{ vars.count ?? 0 }}",
  );
});

Deno.test("serialize: a hand-written or-chain JSONLogic payload PROMOTES to infix form on round trip", () => {
  // Same class as the documented var→secret promotion (a `var` ref starting `secrets.`).
  const parts = parseTemplate('{{ ={"or":[{"var":"vars.a"},"x"]} }}');
  assertEquals(parts, [{ kind: "expr", expr: { or: [{ var: "vars.a" }, "x"] } }]);
  assertEquals(serializeTemplate(parts), '{{ vars.a || "x" }}');
});

Deno.test("serialize: every other JSONLogic shape keeps the `{{ =<raw> }}` escape hatch", () => {
  assertEquals(
    serializeTemplate([{ kind: "expr", expr: { "+": [1, 2] } }]),
    "{{ =" + JSON.stringify({ "+": [1, 2] }) + " }}",
  );
  // A length-1 `or` array is not a recognised chain (parseCoalesceChain requires length >= 2).
  assertEquals(
    serializeTemplate([{ kind: "expr", expr: { or: [{ var: "a" }] } }]),
    "{{ =" + JSON.stringify({ or: [{ var: "a" }] }) + " }}",
  );
});

Deno.test("parseCoalesceChain: recognises only a flat, well-formed, length>=2 chain", () => {
  assertEquals(parseCoalesceChain({ or: [{ var: "vars.a" }, "x"] }), {
    op: "or",
    operands: [{ var: "vars.a" }, "x"],
  });
  assertEquals(parseCoalesceChain({ "??": [{ var: "vars.a" }, 1, true, null] }), {
    op: "??",
    operands: [{ var: "vars.a" }, 1, true, null],
  });
  assertEquals(parseCoalesceChain({ or: [{ var: "a" }] }), null, "length 1");
  // The existing engine fixture (w6w-workflow/tests/expr_test.ts:506) stays unrecognized.
  assertEquals(parseCoalesceChain({ or: [[{ var: "" }]] }), null, "nested array operand");
  assertEquals(parseCoalesceChain({ if: [1, 2, 3] }), null, "not or/??");
  assertEquals(
    parseCoalesceChain({ or: [{ var: "a" }, { var: "b" }, { and: [1] }] }),
    null,
    "operand not var/primitive",
  );
  assertEquals(parseCoalesceChain(null), null);
  assertEquals(parseCoalesceChain([1, 2]), null, "array, not object");
  assertEquals(parseCoalesceChain("a + b"), null, "raw string expr");
});

Deno.test("coalesceOperandRefs: the var refs of a recognised chain, in order; null when not a chain", () => {
  assertEquals(
    coalesceOperandRefs({ or: [{ var: "vars.a" }, "x", { var: "vars.b" }] }),
    ["vars.a", "vars.b"],
  );
  assertEquals(coalesceOperandRefs({ or: [{ var: "a" }] }), null);
  assertEquals(coalesceOperandRefs({ "+": [1, 2] }), null);
});

Deno.test("hasRefusedChainToken: true only for a ref still carrying a top-level chain token", () => {
  assertEquals(hasRefusedChainToken("vars.a || vars.b"), true);
  assertEquals(hasRefusedChainToken("vars.a ?? vars.b"), true);
  assertEquals(hasRefusedChainToken("vars.a"), false);
  assertEquals(hasRefusedChainToken('vars.a || "x||y"'), true); // the outer token, not the quoted one
  assertEquals(hasRefusedChainToken('"a||b"'), false); // wholly inside quotes — opaque
});

// ── `\{{` escaping (opt-in, `TemplateEscape`) ──────────────────────────────────────────────
const rooted = (p: ExprPart) => p.kind !== "var" || (p.ref ?? "").startsWith("var.");
const strip = { isOurs: rooted, backslash: "strip" } as const;
const keep = { isOurs: rooted, backslash: "keep" } as const;

Deno.test("escape — without the option a backslash is ordinary text (unchanged behaviour)", () => {
  assertEquals(parseTemplate("\\{{ var.x }}"), [
    { kind: "text", value: "\\" },
    { kind: "var", ref: "var.x" },
  ]);
});

Deno.test("escape — strip: `\\{{ ours }}` is the literal marker text, backslash consumed", () => {
  assertEquals(parseTemplate("a \\{{ var.x }} b", "editor", strip), [
    { kind: "text", value: "a {{ var.x }} b" },
  ]);
});

Deno.test("escape — keep: the escaped marker is text and the source is verbatim", () => {
  assertEquals(parseTemplate("a \\{{ var.x }} b", "editor", keep), [
    { kind: "text", value: "a \\{{ var.x }} b" },
  ]);
});

Deno.test("escape — `\\\\{{` is a literal backslash then a live marker", () => {
  assertEquals(parseTemplate("C:\\\\{{ var.dir }}", "editor", strip), [
    { kind: "text", value: "C:\\" },
    { kind: "var", ref: "var.dir" },
  ]);
  assertEquals(parseTemplate("C:\\\\{{ var.dir }}", "editor", keep), [
    { kind: "text", value: "C:\\\\" },
    { kind: "var", ref: "var.dir" },
  ]);
});

Deno.test("escape — a marker that is not ours keeps its backslash (vendor Handlebars)", () => {
  assertEquals(parseTemplate("\\{{name}} {{ var.x }}", "editor", strip), [
    { kind: "text", value: "\\" },
    { kind: "var", ref: "name" },
    { kind: "text", value: " " },
    { kind: "var", ref: "var.x" },
  ]);
});

// --- inline expressions: ternary, comparisons, `&&`, `!`, parentheses (2026-11-11) -----------

const exprOf = (template: string): unknown => {
  const parts = parseTemplate(template);
  assertEquals(parts.length, 1, template);
  assertEquals(parts[0].kind, "expr", template);
  return parts[0].expr;
};

Deno.test("inline: the user's ternary lowers to JSONLogic if/=== and evaluates", () => {
  const expr = exprOf("{{ var.a === var.b ? 'option1' : 'option2' }}");
  assertEquals(expr, {
    if: [{ "===": [{ var: "var.a" }, { var: "var.b" }] }, "option1", "option2"],
  });
  assertEquals(evaluate(expr, { var: { a: 1, b: 1 } }), "option1");
  assertEquals(evaluate(expr, { var: { a: 1, b: "1" } }), "option2");
});

Deno.test("inline: every comparison operator, in the condition", () => {
  const data = { var: { n: 2 } };
  for (
    const [op, expected] of [
      ["===", "y"],
      ["==", "y"],
      ["!==", "n"],
      ["!=", "n"],
      ["<", "n"],
      ["<=", "y"],
      [">", "n"],
      [">=", "y"],
    ] as const
  ) {
    const expr = exprOf(`{{ var.n ${op} 2 ? 'y' : 'n' }}`);
    assertEquals(expr, { if: [{ [op]: [{ var: "var.n" }, 2] }, "y", "n"] }, op);
    assertEquals(evaluate(expr, data), expected, op);
  }
  // A comparison alone (no ternary) is an expression too.
  assertEquals(exprOf("{{ var.n > 1 }}"), { ">": [{ var: "var.n" }, 1] });
});

Deno.test("inline: a nested else-ternary is right-associative and flattens into one if", () => {
  const expr = exprOf(`{{ var.n > 10 ? "big" : var.n > 0 ? 'small' : 'none' }}`);
  assertEquals(expr, {
    if: [{ ">": [{ var: "var.n" }, 10] }, "big", { ">": [{ var: "var.n" }, 0] }, "small", "none"],
  });
  assertEquals(evaluate(expr, { var: { n: 11 } }), "big");
  assertEquals(evaluate(expr, { var: { n: 3 } }), "small");
  assertEquals(evaluate(expr, { var: { n: -1 } }), "none");
  // Parentheses keep the nesting exactly as written, in either arm.
  assertEquals(exprOf("{{ var.a ? (var.b ? 1 : 2) : 3 }}"), {
    if: [{ var: "var.a" }, { if: [{ var: "var.b" }, 1, 2] }, 3],
  });
  assertEquals(exprOf("{{ var.a ? 1 : (var.b ? 2 : 3) }}"), {
    if: [{ var: "var.a" }, 1, { if: [{ var: "var.b" }, 2, 3] }],
  });
  // Unparenthesised then-arm ternary, as JavaScript allows.
  assertEquals(exprOf("{{ var.a ? var.b ? 1 : 2 : 3 }}"), {
    if: [{ var: "var.a" }, { if: [{ var: "var.b" }, 1, 2] }, 3],
  });
});

Deno.test("inline: !, && and ||/?? in the condition, with precedence and parentheses", () => {
  const expr = exprOf("{{ !var.off && (var.n <= 3 || var.force) ? var.items[0] : null }}");
  assertEquals(expr, {
    if: [
      {
        and: [
          { "!": [{ var: "var.off" }] },
          { or: [{ "<=": [{ var: "var.n" }, 3] }, { var: "var.force" }] },
        ],
      },
      { var: "var.items.0" },
      null,
    ],
  });
  assertEquals(evaluate(expr, { var: { off: false, n: 9, force: true, items: ["x"] } }), "x");
  assertEquals(evaluate(expr, { var: { off: true, n: 1, items: ["x"] } }), null);
  // `&&` binds tighter than `||`, `||` tighter than `??`, and the ternary loosest of all.
  assertEquals(exprOf("{{ var.a ?? var.b || var.c && var.d ? 1 : 0 }}"), {
    if: [
      {
        "??": [{ var: "var.a" }, {
          or: [{ var: "var.b" }, { and: [{ var: "var.c" }, { var: "var.d" }] }],
        }],
      },
      1,
      0,
    ],
  });
  // An unparenthesised run of one n-ary operator is one flat array.
  assertEquals(exprOf("{{ var.a && var.b && var.c ? 1 : 0 }}"), {
    if: [{ and: [{ var: "var.a" }, { var: "var.b" }, { var: "var.c" }] }, 1, 0],
  });
});

Deno.test("inline: literals — both quote styles, escapes, numbers, booleans, null", () => {
  assertEquals(
    exprOf(`{{ var.a ? "dq" : 'sq' }}`),
    { if: [{ var: "var.a" }, "dq", "sq"] },
  );
  assertEquals(
    exprOf(`{{ var.a ? 'it\\'s' : "say \\"hi\\"\\n" }}`),
    { if: [{ var: "var.a" }, "it's", 'say "hi"\n'] },
  );
  assertEquals(exprOf("{{ var.a == -1.5e2 ? true : false }}"), {
    if: [{ "==": [{ var: "var.a" }, -150] }, true, false],
  });
  assertEquals(exprOf("{{ var.a === null ? 0 : 1 }}"), {
    if: [{ "===": [{ var: "var.a" }, null] }, 0, 1],
  });
});

Deno.test("inline: ? : and comparisons inside strings or brackets are not operators", () => {
  assertEquals(exprOf("{{ var.a ? 'x ? y : z' : \"a === b\" }}"), {
    if: [{ var: "var.a" }, "x ? y : z", "a === b"],
  });
  assertEquals(exprOf(`{{ steps.s.output["a:b"] == 'x' ? 1 : 2 }}`), {
    if: [{ "==": [{ var: "steps.s.output.a:b" }, "x"] }, 1, 2],
  });
  // Bracket indexing normalises exactly as an ordinary marker does.
  assertEquals(exprOf(`{{ steps.s.output.rows[0]['name'] ? 1 : 2 }}`), {
    if: [{ var: "steps.s.output.rows.0.name" }, 1, 2],
  });
});

Deno.test("inline: a secrets operand ANYWHERE refuses the whole expression to the var arm", () => {
  for (
    const inner of [
      "secrets.K === 'a' ? 1 : 2",
      "var.a ? secrets.K : 2",
      "var.a ? 1 : secrets.K",
      "var.a ? 1 : var.b ? 2 : secrets.K",
      "!secrets.K",
      "var.a === secrets['K'] ? 1 : 2",
      "(var.a || secrets.K) ? 1 : 2",
    ]
  ) {
    for (const mode of ["editor", "render"] as const) {
      const parts = parseTemplate(`{{ ${inner} }}`, mode);
      assertEquals(parts, [{ kind: "var", ref: inner }], `${mode}: ${inner}`);
      assertEquals(hasRefusedChainToken(inner), true, inner);
    }
  }
});

Deno.test("inline: malformed input falls back exactly as before (never throws)", () => {
  for (
    const [template, expected] of [
      ["{{ var.a ? 1 }}", [{ kind: "var", ref: "var.a ? 1" }]],
      ["{{ var.a ? : 2 }}", [{ kind: "var", ref: "var.a ? : 2" }]],
      ["{{ var.a = 1 ? 2 : 3 }}", [{ kind: "var", ref: "var.a = 1 ? 2 : 3" }]],
      ["{{ (var.a ? 1 : 2 }}", [{ kind: "var", ref: "(var.a ? 1 : 2" }]],
      ["{{ var.a ? 'open : 2 }}", [{ kind: "var", ref: "var.a ? 'open : 2" }]],
      ["{{ var.a.toLowerCase() == 'x' ? 1 : 2 }}", [{
        kind: "var",
        ref: "var.a.toLowerCase() == 'x' ? 1 : 2",
      }]],
      ["{{ (var.a) }}", [{ kind: "var", ref: "(var.a)" }]],
      ["{{> partial}}", [{ kind: "var", ref: "> partial" }]],
      ["{{var:name}}", [{ kind: "var", ref: "var:name" }]],
      ["{{! a Handlebars comment }}", [{ kind: "var", ref: "! a Handlebars comment" }]],
      // A mixed `||`/`??` chain with no inline-only operator is still the chain's refusal.
      ["{{ vars.a || vars.b ?? vars.c }}", [{ kind: "var", ref: "vars.a || vars.b ?? vars.c" }]],
    ] as const
  ) {
    assertEquals(parseTemplate(template), expected as unknown as ExprPart[], template);
  }
  // Too deep to be authored by hand: refused, not a stack overflow.
  const deep = "(".repeat(200) + "var.a == 1" + ")".repeat(200);
  assertEquals(parseTemplate(`{{ ${deep} }}`)[0].kind, "var");
});

Deno.test("inline: plain paths, secrets and ||/?? chains keep their pre-existing parse", () => {
  assertEquals(parseTemplate("{{ var.a }}"), [{ kind: "var", ref: "var.a" }]);
  assertEquals(parseTemplate("{{ secrets.K }}"), [{ kind: "secret", ref: "K" }]);
  assertEquals(parseTemplate('{{ var.a || "x" }}'), [
    { kind: "expr", expr: { or: [{ var: "var.a" }, "x"] } },
  ]);
  // Byte-identical chain behaviour: a single-quoted chain operand is still read as a path.
  assertEquals(parseTemplate("{{ var.a ?? 'x' }}"), [
    { kind: "expr", expr: { "??": [{ var: "var.a" }, { var: "'x'" }] } },
  ]);
});

Deno.test("inline: serialize prints readable infix and parse(serialize(x)) is stable", () => {
  for (
    const template of [
      "{{ var.a === var.b ? 'option1' : 'option2' }}",
      "{{ var.n > 10 ? 'big' : var.n > 0 ? 'small' : 'none' }}",
      "{{ var.a ? (var.b ? 1 : 2) : 3 }}",
      "{{ var.a ? 1 : (var.b ? 2 : 3) }}",
      "{{ !var.off && (var.n <= 3 || var.force) ? var.items.0 : null }}",
      "{{ (var.a ? 1 : 2) == 1 }}",
      "{{ var.a ? 'it\\'s' : 'x ? y : z' }}",
      "Hello {{ var.name }}, you are {{ var.age >= 18 ? 'an adult' : 'a minor' }}.",
    ]
  ) {
    const parts = parseTemplate(template);
    assertEquals(serializeTemplate(parts), template, template);
    assertEquals(parseTemplate(serializeTemplate(parts)), parts, template);
  }
  // Double quotes and bracket indexing normalise to the canonical spelling, then hold.
  const t = `{{ var.list[0] == "x" ? "a" : "b" }}`;
  const once = serializeTemplate(parseTemplate(t));
  assertEquals(once, "{{ var.list.0 == 'x' ? 'a' : 'b' }}");
  assertEquals(serializeTemplate(parseTemplate(once)), once);
});

Deno.test("inline: a path segment that is not a plain name prints in bracket form", () => {
  const parts: ExprPart[] = [{
    kind: "expr",
    expr: { if: [{ "==": [{ var: "steps.my step.output.a:b" }, 1] }, "y", "n"] },
  }];
  assertEquals(serializeTemplate(parts), `{{ steps["my step"].output["a:b"] == 1 ? 'y' : 'n' }}`);
  assertEquals(parseTemplate(serializeTemplate(parts)), parts);
});

Deno.test("inline: an =<jsonlogic> payload of an inline shape promotes to infix on round trip", () => {
  const parts = parseTemplate('{{ ={"if":[{"==":[{"var":"var.a"},1]},"y","n"]} }}');
  assertEquals(serializeTemplate(parts), "{{ var.a == 1 ? 'y' : 'n' }}");
  assertEquals(parseTemplate(serializeTemplate(parts)), parts);
  // An un-flattened nested else-if keeps its nesting through parentheses.
  const nested: ExprPart[] = [{
    kind: "expr",
    expr: { if: [{ var: "var.a" }, 1, { if: [{ var: "var.b" }, 2, 3] }] },
  }];
  assertEquals(serializeTemplate(nested), "{{ var.a ? 1 : (var.b ? 2 : 3) }}");
  assertEquals(parseTemplate(serializeTemplate(nested)), nested);
});

Deno.test("inline: shapes the grammar cannot spell keep the {{ =<raw> }} escape hatch", () => {
  for (
    const expr of [
      { if: [{ var: "var.a" }, 1] }, // no else arm
      { if: [{ var: "secrets.K" }, 1, 2] }, // would be refused if printed
      { if: [{ var: 'steps.a"b.output' }, 1, 2] }, // a segment with no bracket spelling
      { if: [{ var: "var.a" }, "}}", 2] }, // would close the marker early
      { "==": [{ var: "var.a" }, { "+": [1, 2] }] }, // an operator outside the grammar
      { "<": [1, { var: "var.a" }, 3] }, // three-argument between
      { "!": { var: "var.a" } }, // unary without the array
    ]
  ) {
    const parts: ExprPart[] = [{ kind: "expr", expr }];
    const text = serializeTemplate(parts);
    assertEquals(text, `{{ =${JSON.stringify(expr)} }}`, JSON.stringify(expr));
    assertEquals(parseTemplate(text), parts);
  }
});

Deno.test("inline: coalesceOperandRefs returns an inline expression's refs for root-anchoring", () => {
  assertEquals(
    coalesceOperandRefs(exprOf("{{ var.a === steps.s.output.x ? var.b : 'n' }}")),
    ["var.a", "steps.s.output.x", "var.b"],
  );
  // A Handlebars-ish `{{!name}}` parses as negation, but its unrooted ref keeps it someone
  // else's marker for every consumer's root check.
  assertEquals(coalesceOperandRefs(exprOf("{{!name}}")), ["name"]);
  // Bare refs / unknown operators stay opaque (null).
  assertEquals(coalesceOperandRefs({ var: "var.a" }), null);
  assertEquals(coalesceOperandRefs({ if: [{ var: "a" }, 1] }), null);
  assertEquals(coalesceOperandRefs({ if: [{ "+": [1, 2] }, 1, 2] }), null);
});
