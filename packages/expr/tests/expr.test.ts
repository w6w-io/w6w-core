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

Deno.test("xor is true when exactly one argument is truthy (0/1/2/3 true)", () => {
  assertEquals(evaluate({ xor: [false, 0, ""] }), false);
  assertEquals(evaluate({ xor: [false, "x", 0] }), true);
  assertEquals(evaluate({ xor: [1, "x", false] }), false);
  assertEquals(evaluate({ xor: [1, "x", true] }), false);
  assertEquals(evaluate({ xor: [[], [1]] }), true); // JSONLogic truthiness
  // Comparisons as rows, the shape the condition builder writes.
  const rows = {
    xor: [{ "==": [{ var: "a" }, 1] }, { "==": [{ var: "b" }, 1] }, { "==": [{ var: "c" }, 1] }],
  };
  assertEquals(evaluate(rows, { a: 0, b: 0, c: 0 }), false);
  assertEquals(evaluate(rows, { a: 0, b: 1, c: 0 }), true);
  assertEquals(evaluate(rows, { a: 1, b: 1, c: 0 }), false);
  assertEquals(evaluate(rows, { a: 1, b: 1, c: 1 }), false);
  assertEquals(showIf({ xor: [true] }), true);
  assertEquals(showIf({ xor: [] }), false);
});

Deno.test("?? coalesces only null/undefined — never isTruthy, unlike or", () => {
  // The wrong-thing-tree-A fixture: `??` implemented with isTruthy would keep 0's fallback
  // ("10"); the correct predicate keeps 0 itself.
  assertEquals(evaluate({ "??": [{ var: "inputs.count" }, "10"] }, { inputs: { count: 0 } }), 0);
  assertEquals(evaluate({ or: [{ var: "inputs.count" }, "10"] }, { inputs: { count: 0 } }), "10");
  // 0, "", false, [] are all KEPT by `??` — none of them is null/undefined.
  assertEquals(evaluate({ "??": [0, "x"] }), 0);
  assertEquals(evaluate({ "??": ["", "x"] }), "");
  assertEquals(evaluate({ "??": [false, "x"] }), false);
  assertEquals(evaluate({ "??": [[], "x"] }), []);
  // null and undefined (a missing `var`) fall through to the next operand.
  assertEquals(evaluate({ "??": [null, "x"] }), "x");
  assertEquals(evaluate({ "??": [{ var: "missing.path" }, "x"] }, {}), "x");
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

Deno.test("var: legitimate own-property reads are unchanged", () => {
  const d = { a: { b: 5 }, arr: [10, 20], s: "hey", n: null };
  assertEquals(evaluate({ var: "a.b" }, d), 5);
  assertEquals(evaluate({ var: "arr.1" }, d), 20);
  assertEquals(evaluate({ var: "arr.length" }, d), 2);
  assertEquals(evaluate({ var: "s.length" }, d), 3);
  assertEquals(evaluate({ var: "s.0" }, d), "h");
  assertEquals(evaluate({ var: ["n", "fb"] }, d), null);
  assertEquals(evaluate({ var: "nope" }, d), null);
  assertEquals(evaluate({ var: ["nope", "fb"] }, d), "fb");
  assertEquals(evaluate({ var: "" }, d), d);
  assertEquals(evaluate({ missing: ["a.b", "zz"] }, d), ["zz"]);
});

Deno.test("var: prototype members are refused like a missing key", () => {
  const d = { vars: { x: 1 }, s: "str" };
  for (
    const path of [
      "constructor",
      "constructor.constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "vars.constructor.constructor",
      "s.length.constructor",
    ]
  ) {
    assertEquals(evaluate({ var: path }, d), null, path);
    assertEquals(evaluate({ var: [path, "fb"] }, d), "fb", path);
  }
  assertEquals(evaluate({ missing: ["vars.constructor"] }, d), ["vars.constructor"]);
});

Deno.test("var: an own property named like a prototype member still reads", () => {
  assertEquals(evaluate({ var: "constructor" }, { constructor: 1 }), 1);
  assertEquals(evaluate({ var: "a.toString" }, { a: { toString: "t" } }), "t");
});
