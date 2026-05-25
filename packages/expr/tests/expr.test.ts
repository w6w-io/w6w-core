import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import { evaluate, ExprError, isTruthy, showIf } from "../mod.ts";

Deno.test("var reads dotted paths with a fallback", () => {
  assertEquals(evaluate({ var: "user.name" }, { user: { name: "Ada" } }), "Ada");
  assertEquals(evaluate({ var: ["missing.key", "default"] }, {}), "default");
  assertEquals(evaluate({ var: "" }, { a: 1 }), { a: 1 });
});

Deno.test("equality and ordering", () => {
  assertEquals(evaluate({ "==": [{ var: "plan" }, "pro"] }, { plan: "pro" }), true);
  assertEquals(evaluate({ "===": [1, 1] }), true);
  assertEquals(evaluate({ "!=": [1, 2] }), true);
  assertEquals(evaluate({ ">": [{ var: "n" }, 3] }, { n: 5 }), true);
  // chained "between"
  assertEquals(evaluate({ "<": [1, { var: "n" }, 10] }, { n: 5 }), true);
  assertEquals(evaluate({ "<": [1, { var: "n" }, 10] }, { n: 50 }), false);
});

Deno.test("boolean and/or short-circuit to the deciding value", () => {
  assertEquals(evaluate({ and: [true, true] }), true);
  assertEquals(evaluate({ and: [true, false] }), false);
  assertEquals(evaluate({ or: [false, "x"] }), "x");
  assertEquals(evaluate({ "!": [false] }), true);
  assertEquals(evaluate({ "!!": [""] }), false);
});

Deno.test("if / elseif chains", () => {
  const rule = {
    if: [{ "==": [{ var: "t" }, "a"] }, "A", { "==": [{ var: "t" }, "b"] }, "B", "Z"],
  };
  assertEquals(evaluate(rule, { t: "a" }), "A");
  assertEquals(evaluate(rule, { t: "b" }), "B");
  assertEquals(evaluate(rule, { t: "c" }), "Z");
});

Deno.test("in works for arrays and strings", () => {
  assertEquals(evaluate({ in: ["b", ["a", "b"]] }), true);
  assertEquals(evaluate({ in: ["ell", "hello"] }), true);
  assertEquals(evaluate({ in: ["z", ["a", "b"]] }), false);
});

Deno.test("arithmetic", () => {
  assertEquals(evaluate({ "+": [1, 2, 3] }), 6);
  assertEquals(evaluate({ "-": [10, 4] }), 6);
  assertEquals(evaluate({ "*": [2, 3] }), 6);
});

Deno.test("isTruthy uses JSONLogic semantics (empty array is falsy)", () => {
  assertEquals(isTruthy([]), false);
  assertEquals(isTruthy([0]), true);
  assertEquals(isTruthy(0), false);
  assertEquals(isTruthy("x"), true);
});

Deno.test("showIf: undefined rule is always visible; rules coerce to boolean", () => {
  assertEquals(showIf(undefined, {}), true);
  assertEquals(showIf({ "==": [{ var: "plan" }, "pro"] }, { plan: "free" }), false);
  assertEquals(showIf({ "!": { var: "hidden" } }, { hidden: false }), true);
});

Deno.test("unknown operator throws", () => {
  assertThrows(() => evaluate({ frobnicate: [1] }), ExprError);
});
