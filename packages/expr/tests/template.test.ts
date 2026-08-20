import { assertEquals } from "jsr:@std/assert@^1.0.0";
import type { ExprPart } from "../../types/mod.ts";
import {
  coalesceOperandRefs,
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
