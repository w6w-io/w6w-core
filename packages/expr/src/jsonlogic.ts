/**
 * A JSONLogic evaluator — the expression engine the platform uses for Param
 * `showIf` visibility (and, later, output→input mapping). JSONLogic was chosen
 * over a bespoke mini-language in the ROADMAP.
 *
 * Implements the operators `showIf` realistically needs: var/missing, the
 * (in)equality + ordering comparisons (with chained "between" form), boolean
 * and/or/!/!! , if/elseif, in, and basic arithmetic. Unknown operators throw.
 *
 * Reference: https://jsonlogic.com/operations.html
 */

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
  const parts = String(path).split(".");
  let cur: unknown = data;
  for (const part of parts) {
    if (cur === null || cur === undefined) return fallback ?? null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur === undefined ? (fallback ?? null) : cur;
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

    case "in": {
      const needle = evaluate(args[0], data);
      const hay = evaluate(args[1], data);
      if (typeof hay === "string") return hay.includes(String(needle));
      if (Array.isArray(hay)) return hay.includes(needle);
      return false;
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
