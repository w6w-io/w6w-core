/** Readable conditions compile to JSONLogic; no JavaScript is executed. */
export class ReadableExpressionError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} (character ${position + 1}).`);
    this.name = "ReadableExpressionError";
    this.position = position;
  }
}

type Token = { kind: "value" | "ref" | "op" | "end"; value: unknown; at: number };
const PRECEDENCE: Record<string, number> = {
  "??": 1,
  "||": 2,
  "&&": 3,
  "==": 4,
  "!=": 4,
  "===": 4,
  "!==": 4,
  ">": 5,
  ">=": 5,
  "<": 5,
  "<=": 5,
};
const LOGIC_OP: Record<string, string> = { "&&": "and", "||": "or" };
const PATH = /^[A-Za-z_$][\w$-]*(?:\.[\w$-]+)*$/;

/** Parse comparisons, boolean operators, parentheses, paths and JSON primitive literals.
 * `resolveRef` lets an editor expand a known step's short name to its canonical output path.
 * A reference wrapped in {{ }} is atomic, so picker fields containing spaces still work. */
export function parseReadableExpression(
  source: string,
  resolveRef: (ref: string) => string = (ref) => ref,
): unknown {
  if (source.length > 10000) throw new ReadableExpressionError("Expression is too long", 0);
  let i = 0;
  let depth = 0;
  const fail = (message: string, at = i): never => {
    throw new ReadableExpressionError(message, at);
  };
  const quoted = (): string => {
    const start = i;
    const quote = source[i++];
    let out = "";
    while (i < source.length) {
      const ch = source[i++];
      if (ch === quote) return out;
      if (ch === "\n" || ch === "\r") fail("Close the quoted value before a line break", i - 1);
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const escaped = source[i++];
      const escapes: Record<string, string> = {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        "\\": "\\",
        '"': '"',
        "'": "'",
        "/": "/",
      };
      if (escaped === "u") {
        const hex = source.slice(i, i + 4);
        if (!/^[\da-f]{4}$/i.test(hex)) fail("Use four hexadecimal digits after \\u", i);
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 4;
      } else if (Object.hasOwn(escapes, escaped)) out += escapes[escaped];
      else fail("Invalid string escape", i - 1);
    }
    return fail("Close the quoted value", start);
  };
  const next = (): Token => {
    while (/\s/.test(source[i] ?? "") && i < source.length) i++;
    const at = i;
    if (i >= source.length) return { kind: "end", value: "", at };
    if (source.startsWith("{{", i)) {
      const end = source.indexOf("}}", i + 2);
      if (end < 0) fail("Close the field reference with }}", i);
      const ref = source.slice(i + 2, end).trim();
      if (!ref || /[{}=!<>|?&]/.test(ref)) fail("Choose a field reference", i);
      i = end + 2;
      return { kind: "ref", value: ref, at };
    }
    const ch = source[i];
    if (ch === '"' || ch === "'") return { kind: "value", value: quoted(), at };
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if (number) {
      i += number[0].length;
      const value = Number(number[0]);
      if (!Number.isFinite(value)) fail("Use a finite number", at);
      return { kind: "value", value, at };
    }
    const word = /^[A-Za-z_$][\w$-]*(?:\.[\w$-]+)*/.exec(source.slice(i));
    if (word) {
      i += word[0].length;
      if (["true", "false", "null"].includes(word[0])) {
        return { kind: "value", value: JSON.parse(word[0]), at };
      }
      return { kind: "ref", value: word[0], at };
    }
    const op = /^(===|!==|==|!=|>=|<=|&&|\|\||\?\?|[!<>()])/.exec(source.slice(i));
    if (op) {
      i += op[0].length;
      return { kind: "op", value: op[0], at };
    }
    return fail(ch === "=" ? "Use == to compare values" : `Unexpected ${JSON.stringify(ch)}`, at);
  };
  let token = next();
  const take = () => {
    const previous = token;
    token = next();
    return previous;
  };
  const atom = (): unknown => {
    if (++depth > 64) fail("Expression is nested too deeply", token.at);
    try {
      if (token.kind === "value") return take().value;
      if (token.kind === "ref") {
        const t = take();
        return { var: resolveRef(String(t.value)) };
      }
      if (token.value === "!") {
        take();
        return { "!": [atom()] };
      }
      if (token.value === "(") {
        take();
        const value = binary(1);
        if (String(token.value) !== ")") fail("Close the parenthesis", token.at);
        take();
        return value;
      }
      return fail("Expected a field or value", token.at);
    } finally {
      depth--;
    }
  };
  const binary = (minimum: number): unknown => {
    let left = atom();
    while (token.kind === "op" && (PRECEDENCE[String(token.value)] ?? 0) >= minimum) {
      const op = String(take().value);
      left = { [LOGIC_OP[op] ?? op]: [left, binary(PRECEDENCE[op] + 1)] };
    }
    return left;
  };
  const result = binary(1);
  if (token.kind !== "end") fail("Expected a comparison or logical operator", token.at);
  return result;
}

/** A reversible readable representation of the supported JSONLogic subset, else null.
 * Unknown legacy JSONLogic stays in its original representation. */
export function formatReadableExpression(
  expression: unknown,
  displayRef: (ref: string) => string = (ref) => ref,
): string | null {
  const format = (value: unknown, nested: boolean): string | null => {
    if (
      value === null || typeof value === "string" || typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) return JSON.stringify(value);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (entries.length !== 1) return null;
    const [op, raw] = entries[0];
    if (op === "var" && typeof raw === "string" && raw) {
      const ref = displayRef(raw);
      return PATH.test(ref) && !["true", "false", "null"].includes(ref) ? ref : `{{ ${ref} }}`;
    }
    const args = Array.isArray(raw) ? raw : [raw];
    const token = op === "and" ? "&&" : op === "or" ? "||" : op;
    if (op === "!" && args.length === 1) {
      const inner = format(args[0], true);
      return inner === null ? null : `!${inner}`;
    }
    if (!Object.hasOwn(PRECEDENCE, token)) return null;
    if (
      (["and", "or", "??"].includes(op) && args.length < 2) ||
      (!["and", "or", "??"].includes(op) && args.length !== 2)
    ) return null;
    const rendered = args.map((arg) => format(arg, true));
    if (rendered.some((arg) => arg === null)) return null;
    const text = rendered.join(` ${token} `);
    return nested ? `(${text})` : text;
  };
  return format(expression, false);
}

/** The static field references a JSONLogic expression reads, in first-use order. */
export function expressionReferences(expression: unknown): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const object = value as Record<string, unknown>;
    if (Object.keys(object).length === 1 && typeof object.var === "string") refs.add(object.var);
    else Object.values(object).forEach(visit);
  };
  visit(expression);
  return [...refs];
}
