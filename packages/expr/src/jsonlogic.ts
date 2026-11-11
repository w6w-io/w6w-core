/**
 * A JSONLogic evaluator — the expression engine the platform uses for Param
 * `showIf` visibility (and, later, output→input mapping). JSONLogic was chosen
 * over a bespoke mini-language in the ROADMAP.
 *
 * Implements the operators `showIf` realistically needs: var/missing, the
 * (in)equality + ordering comparisons (with chained "between" form), boolean
 * and/or/!/!! , if/elseif, membership and array comparisons, and basic arithmetic.
 * Unknown operators throw.
 *
 * Extensions include `includes` (reverse `in`), `include-any` / `include-all` (array
 * overlap / containment), and `xor` — true when EXACTLY ONE argument is truthy
 * (JSONLogic has no exclusive or). It is what the condition builder's "Exactly one of"
 * compiles to. `get` reads ONE key of a computed value — `{"get":[<object>, <key>]}` — which is
 * what a `{{ state[nodes.x.output.id] }}` computed bracket key lowers to.
 *
 * Reference: https://jsonlogic.com/operations.html
 */

import { normalizeRefPath } from "./ref-path.ts";

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

/** JSONLogic truthiness: empty array/string, 0, null, false are falsy. */
export function isTruthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return !!v;
}

function getVar(data: unknown, path: unknown, fallback: unknown): unknown {
  if (path === "" || path === null || path === undefined) return data;
  const parts = normalizeRefPath(String(path)).split(".");
  let cur: unknown = data;
  for (const part of parts) {
    if (cur === null || cur === undefined) return fallback ?? null;
    // Own properties only (primitives boxed so string `length`/indices still resolve): a
    // prototype member (`constructor`, `__proto__`, `toString`) reads as a missing key.
    const boxed = Object(cur) as Record<string, unknown>;
    cur = Object.hasOwn(boxed, part) ? boxed[part] : undefined;
  }
  return cur === undefined ? (fallback ?? null) : cur;
}

/**
 * `get`: one own key of an object, or one index of an array (an integer, or a string of digits),
 * or `null` — for a missing key, a prototype member, a non-object base, or a key that is not a
 * string/number. The key is used whole: `"a.b"` is the key `a.b`, never the path `a` → `b`.
 */
function getKey(base: unknown, key: unknown): unknown {
  if (base === null || typeof base !== "object") return null;
  if (Array.isArray(base)) {
    const index = typeof key === "number"
      ? key
      : typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key)
      ? Number(key)
      : NaN;
    return Number.isSafeInteger(index) && index >= 0 && index < base.length
      ? (base[index] ?? null)
      : null;
  }
  if (typeof key !== "string" && typeof key !== "number") return null;
  const name = String(key);
  const value = Object.hasOwn(base, name) ? (base as Record<string, unknown>)[name] : undefined;
  return value === undefined ? null : value;
}

function compare(args: unknown[], data: unknown, cmp: (a: number, b: number) => boolean): boolean {
  const vals = args.map((a) => Number(evaluate(a, data)));
  for (let i = 0; i < vals.length - 1; i++) {
    if (!cmp(vals[i], vals[i + 1])) return false;
  }
  return true;
}

function arith(args: unknown[], data: unknown, fn: (a: number, b: number) => number): number {
  const vals = args.map((a) => Number(evaluate(a, data)));
  return vals.reduce((acc, v) => fn(acc, v));
}

/** Evaluate a JSONLogic rule against `data`. */
export function evaluate(logic: unknown, data: unknown = {}): unknown {
  if (Array.isArray(logic)) return logic.map((l) => evaluate(l, data));
  if (logic === null || typeof logic !== "object") return logic;

  const keys = Object.keys(logic as Record<string, unknown>);
  if (keys.length !== 1) return logic; // plain object literal, not an operator

  const op = keys[0];
  const raw = (logic as Record<string, unknown>)[op];
  const args = Array.isArray(raw) ? raw : [raw];

  switch (op) {
    case "var":
      return getVar(data, args[0] !== undefined ? evaluate(args[0], data) : null, args[1]);
    case "get":
      return getKey(evaluate(args[0], data), evaluate(args[1], data));
    case "missing":
      return args
        .map((a) => evaluate(a, data))
        .filter((k) =>
          getVar(data, k, undefined) === null || getVar(data, k, undefined) === undefined
        );

    case "==":
      return evaluate(args[0], data) == evaluate(args[1], data);
    case "!=":
      return evaluate(args[0], data) != evaluate(args[1], data);
    case "===":
      return evaluate(args[0], data) === evaluate(args[1], data);
    case "!==":
      return evaluate(args[0], data) !== evaluate(args[1], data);

    case "!":
      return !isTruthy(evaluate(args[0], data));
    case "!!":
      return isTruthy(evaluate(args[0], data));

    case ">":
      return compare(args, data, (a, b) => a > b);
    case ">=":
      return compare(args, data, (a, b) => a >= b);
    case "<":
      return compare(args, data, (a, b) => a < b);
    case "<=":
      return compare(args, data, (a, b) => a <= b);

    case "and": {
      let cur: unknown;
      for (const a of args) {
        cur = evaluate(a, data);
        if (!isTruthy(cur)) return cur;
      }
      return cur;
    }
    case "or": {
      let cur: unknown;
      for (const a of args) {
        cur = evaluate(a, data);
        if (isTruthy(cur)) return cur;
      }
      return cur;
    }
    case "xor": {
      // Exactly one truthy argument. Every argument is evaluated (no short-circuit): the
      // answer depends on all of them. Always a boolean, unlike and/or.
      let truthy = 0;
      for (const a of args) if (isTruthy(evaluate(a, data))) truthy++;
      return truthy === 1;
    }
    case "??": {
      // Mirrors "or" verbatim except the predicate: keeps 0/""/false/[] — only null/undefined
      // are treated as absent. Never isTruthy.
      let cur: unknown;
      for (const a of args) {
        cur = evaluate(a, data);
        if (cur !== null && cur !== undefined) return cur;
      }
      return cur;
    }

    case "if":
    case "?:": {
      for (let i = 0; i < args.length - 1; i += 2) {
        if (isTruthy(evaluate(args[i], data))) return evaluate(args[i + 1], data);
      }
      return args.length % 2 ? evaluate(args[args.length - 1], data) : null;
    }

    case "in":
    case "includes": {
      const left = evaluate(args[0], data);
      const right = evaluate(args[1], data);
      const needle = op === "in" ? left : right;
      const hay = op === "in" ? right : left;
      if (typeof hay === "string") return hay.includes(String(needle));
      if (Array.isArray(hay)) return hay.includes(needle);
      return false;
    }

    case "include-any":
    case "include-all": {
      const left = evaluate(args[0], data);
      const right = evaluate(args[1], data);
      if (!Array.isArray(left) || !Array.isArray(right)) return false;
      const contains = (value: unknown) => left.includes(value);
      return op === "include-any" ? right.some(contains) : right.every(contains);
    }

    case "+":
      return arith(args, data, (a, b) => a + b);
    case "-":
      return args.length === 1
        ? -Number(evaluate(args[0], data))
        : arith(args, data, (a, b) => a - b);
    case "*":
      return arith(args, data, (a, b) => a * b);
    case "/":
      return arith(args, data, (a, b) => a / b);
    case "%":
      return arith(args, data, (a, b) => a % b);

    default:
      throw new ExprError(`Unknown JSONLogic operator: "${op}"`);
  }
}

/** Convenience for Param `showIf`: evaluate a rule and coerce to a boolean. */
export function showIf(rule: unknown, data: unknown = {}): boolean {
  if (rule === undefined) return true; // no condition → always visible
  return isTruthy(evaluate(rule, data));
}
