import { assertEquals } from "jsr:@std/assert@^1.0.0";
import type { ExprPart } from "../../types/mod.ts";
import { parseRenderTemplate, parseTemplate, serializeTemplate } from "../mod.ts";

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
  ];
  for (const [n, parts] of CORPUS.entries()) {
    const t = serializeTemplate(parts);
    assertEquals(serializeTemplate(parseTemplate(t)), t, `case ${n + 1} not idempotent`);
  }
  // full fidelity for every case except the two by-design promotions (index 1, 2)
  for (const i of [0, 3, 4, 5, 6, 7, 8]) {
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
