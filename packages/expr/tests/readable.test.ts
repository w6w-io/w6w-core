import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import {
  evaluate,
  expressionReferences,
  formatReadableExpression,
  parseReadableExpression,
} from "../mod.ts";

Deno.test("readable comparisons compile to JSONLogic and preserve literal types", () => {
  assertEquals(parseReadableExpression("nodes.order.output.context.source == 'eventbrite'"), {
    "==": [{ var: "nodes.order.output.context.source" }, "eventbrite"],
  });
  for (
    const [source, value] of [
      ['state.a === "123"', true],
      ["state.a === 123", false],
      ["state.a == 123", true],
      ["state.count >= 2 && state.enabled != false", true],
      ["state.missing == null", true],
      ['state.label == "quoted \\"value\\""', true],
      ["state.label == 'quoted \"value\"'", true],
      ["state.count < -1e2", false],
    ] as const
  ) {
    assertEquals(
      evaluate(parseReadableExpression(source), {
        state: { a: "123", count: 3, enabled: true, label: 'quoted "value"' },
      }),
      value,
      source,
    );
  }
});

Deno.test("parentheses, negation, and boolean precedence survive formatting and reparsing", () => {
  const data = { state: { count: 1, enabled: false, name: "x" } };
  for (
    const [source, expected] of [
      ["state.count == 1 || state.count == 2 && state.enabled", true],
      ["(state.count == 1 || state.count == 2) && state.enabled", false],
      ["!(state.count == 2) && !state.enabled", true],
      ['(state.missing ?? "x") == state.name', true],
    ] as const
  ) {
    const rule = parseReadableExpression(source);
    assertEquals(evaluate(rule, data), expected);
    const readable = formatReadableExpression(rule)!;
    assertEquals(evaluate(parseReadableExpression(readable), data), expected, readable);
  }
});

Deno.test("picker references with spaces are atomic, and aliases are expanded by the host", () => {
  assertEquals(parseReadableExpression('{{ nodes.order.output.first name }} == "Ada"'), {
    "==": [{ var: "nodes.order.output.first name" }, "Ada"],
  });
  const rule = parseReadableExpression(
    'order.context.source == "eventbrite"',
    (ref) => `nodes.${ref.replace("order.", "order.output.")}`,
  );
  assertEquals(expressionReferences(rule), ["nodes.order.output.context.source"]);
  assertEquals(
    formatReadableExpression(rule, (ref) => ref.replace("nodes.order.output", "order")),
    'order.context.source == "eventbrite"',
  );
});

Deno.test("invalid, unfinished, executable and excessively nested input is rejected", () => {
  for (
    const source of [
      "state.a ==",
      "state.a = 1",
      "state.a == 'unfinished",
      "(state.a == 1",
      "state.a == 1)",
      "state.a.toLowerCase() == 'x'",
      "state.a; alert(1)",
      "state.a => true",
      "state.a + 2",
      "state.a == NaN",
      "state.a == 1e999",
      "(".repeat(100) + "state.a" + ")".repeat(100),
    ]
  ) {
    // Unknown names are rejected by the caller's scope resolver.
    assertThrows(
      () =>
        parseReadableExpression(source, (ref) => {
          if (!ref.startsWith("state.")) throw new Error("Unknown reference");
          return ref;
        }),
      Error,
      undefined,
      source,
    );
  }
  assertEquals(formatReadableExpression({ map: [{ var: "state.items" }, { var: "id" }] }), null);
});
