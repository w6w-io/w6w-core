/**
 * The `{{ }}` inline-expression grammar — an n8n-style template string that is
 * just an alternate SERIALIZATION of the same {@link ExprPart} model the chip
 * editor uses (so the engine, validation, and secret handling are untouched).
 *
 * Grammar (what sits between `{{` and `}}`, trimmed), in `"editor"` mode
 * (the default — see {@link TemplateMode}):
 *   - `secrets.NAME`   → a named vault-secret reference  → { kind:"secret", ref:"NAME" }
 *   - `=<jsonlogic>`   → a raw JSONLogic expression      → { kind:"expr", expr:<parsed|raw> }
 *   - anything else    → a variable/data path            → { kind:"var", ref:"<path>" }
 *
 * In `"render"` mode the `secret` arm does not exist — `secrets.NAME` falls
 * through to the `var` arm instead, so `parseTemplate` can never construct a
 * `secret` part for that mode. This is one of two independent barriers behind
 * the secret fence (D-8); the other is that the engine evaluates `var` parts
 * against a secrets-free root in render contexts, so the ref resolves to `""`
 * regardless. The `=` arm is unaffected by mode.
 *
 * The `var` ref is the FULL path the engine reads via JSONLogic `{ var: ref }`
 * against `{ var, const, steps, trigger, foreach }` — e.g. `var.env`,
 * `steps.fetch.output.title`. A project variable named `env` is therefore
 * `var.env` (`vars.env` is its permanent alias). Secrets are keyed by bare name
 * (`scope.secrets[NAME]`), so they carry the `secrets.` prefix only in text form.
 *
 * A sealed at-rest secret ({ type:"secret", ciphertext, iv }) has no text form
 * and is never produced or consumed here — the editor handles it separately.
 *
 * `ExprPart` is declared locally rather than imported from `@w6w/types`
 * (structurally identical to the canonical definition in
 * `packages/types/src/value.ts` — keep the two in sync) because `@w6w/expr` is
 * "pure, dependency-free TypeScript" (see its `package.json`) and installable
 * completely on its own: from npm, from JSR, or from a git `path:packages/expr`
 * subdirectory install, none of which put a sibling `packages/types` — or any
 * `@w6w/types` install — on disk. A cross-package reference (relative or bare
 * specifier) only ever resolves in the one setup that happens to keep the full
 * `w6w-core` tree present, so it silently breaks every other consumer.
 */

import { normalizeRefPath } from "./ref-path.ts";

interface ExprPart {
  kind: "text" | "var" | "secret" | "expr" | "render";
  value?: string;
  ref?: string;
  expr?: unknown;
}

const OPEN = "{{";
const CLOSE = "}}";
const SECRET_PREFIX = "secrets.";

/**
 * `editor` builds all three arms below; `render` has no `secret` arm to take —
 * `secrets.NAME` falls through to the `var` arm instead. This is the structural
 * half of the secret fence (D-8): the mode selects which arms EXIST at
 * dispatch, not which already-built parts survive a filter — see the module
 * doc and the contract's "post-filter is the wrong mechanism" note.
 */
export type TemplateMode = "editor" | "render";

/**
 * Opt-in `\{{` escaping. A backslash directly before `{{` makes the marker literal text — but
 * ONLY when the marker would otherwise be one of the caller's own ({@link isOurs}). A marker
 * that is not ours (a vendor's Handlebars `\{{name}}`, which uses the same escape) is left
 * byte-for-byte alone, backslash included. `\\{{` is a literal backslash followed by a live
 * marker. `@w6w/expr` has no opinion on which markers are "ours" (the root set lives with the
 * engine), so the caller supplies it.
 */
export interface TemplateEscape {
  /** True when a marker that parses to `part` belongs to the caller, and so can be escaped. */
  isOurs(part: ExprPart): boolean;
  /**
   * `"strip"` (resolution): consume the escaping backslashes, so `\{{ var.x }}` yields the
   * text `{{ var.x }}`. `"keep"` (editing): keep the source text verbatim, so an editor's text
   * parts round-trip unchanged — the escaped marker still becomes text, never a part.
   */
  backslash: "strip" | "keep";
}

/** How many `\` end `s`. */
function trailingBackslashes(s: string): number {
  let n = 0;
  while (n < s.length && s[s.length - 1 - n] === "\\") n += 1;
  return n;
}

/** A `||`/`??` chain's JSONLogic key, and the infix token that spells it. */
type ChainOp = "or" | "??";
const CHAIN_TOKEN: Record<ChainOp, string> = { or: "||", "??": "??" };

interface ChainToken {
  index: number;
  /** The literal infix token found (`"||"` or `"??"`). */
  token: "||" | "??";
}

/**
 * Find every top-level `||`/`??` in `s`, skipping the contents of a double-quoted JSON
 * string — the same `inString` bookkeeping idiom as {@link findBalancedClose} (including the
 * `\` escape skip), so `"a||b"` is opaque to this scan even though it contains the token text.
 */
function findTopLevelChainTokens(s: string): ChainToken[] {
  const tokens: ChainToken[] = [];
  let inString = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i += 1;
      continue;
    }
    if (s.startsWith("||", i)) {
      tokens.push({ index: i, token: "||" });
      i += 2;
      continue;
    }
    if (s.startsWith("??", i)) {
      tokens.push({ index: i, token: "??" });
      i += 2;
      continue;
    }
    i += 1;
  }
  return tokens;
}

/** A JSON primitive literal per the chain grammar: a double-quoted string, a number, `true`,
 * `false`, or `null` — never an object or array. */
const NUMBER_LITERAL = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
function isJsonPrimitiveLiteral(trimmed: string): boolean {
  return trimmed === "true" || trimmed === "false" || trimmed === "null" ||
    NUMBER_LITERAL.test(trimmed) ||
    (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"'));
}

/** One chain operand → its JSONLogic value: a parsed literal, or `{ var: <path> }`. */
function chainOperandValue(trimmed: string): unknown {
  if (isJsonPrimitiveLiteral(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Malformed despite looking primitive (e.g. an unterminated quote) — treat as a path.
    }
  }
  return { var: normalizeRefPath(trimmed) };
}

/**
 * Recognise `inner` as a flat `||`/`??` fallback chain and build its `expr` part, given the
 * top-level `||`/`??` tokens {@link findTopLevelChainTokens} already found in it (the caller
 * guarantees at least one). Returns `null` when it is not a well-formed chain — in which case
 * the caller falls through to today's `var` arm, never the mode-dependent secrets arm. Fires
 * iff: exactly one of the two operators occurs; every operand is non-empty after trimming; and
 * no operand begins `secrets.` (see workflow.md's 2026-08-20 amendment for why that refusal is
 * outright, not a filter).
 */
function tryChain(inner: string, tokens: ChainToken[]): ExprPart | null {
  const distinctOps = new Set(tokens.map((t) => t.token));
  if (distinctOps.size !== 1) return null;

  const operands: string[] = [];
  let start = 0;
  for (const t of tokens) {
    operands.push(inner.slice(start, t.index));
    start = t.index + t.token.length;
  }
  operands.push(inner.slice(start));

  const trimmedOperands = operands.map((o) => o.trim());
  if (trimmedOperands.some((o) => o.length === 0)) return null;
  if (trimmedOperands.some((o) => o.startsWith(SECRET_PREFIX))) return null;

  const op: ChainOp = tokens[0].token === "||" ? "or" : "??";
  return { kind: "expr", expr: { [op]: trimmedOperands.map(chainOperandValue) } };
}

// --- inline expressions: `cond ? a : b`, comparisons, `&&`, `!`, parentheses -------------------
//
// The second infix production (RFC workflow.md, 2026-11-11 amendment). It engages ONLY when the
// marker carries at least one top-level operator the flat chain does not know (`?`, `:`, a
// comparison, `&&`, `!`, a parenthesis) or a COMPUTED bracket key (`state[nodes.x.output.id]`, an
// unquoted path inside `[…]`) — so a static path, a vendor `{{name}}`, and every `||`/`??` chain
// over static paths keep exactly the dispatch above. It lowers to the JSONLogic `@w6w/expr`
// evaluates (`if`, `===`, `and`, `!`, `get`, …); malformed text falls back to the pre-existing arms.

/** Infix tokens: the longest spelling first, so `===` never reads as `==` + `=`. */
const INLINE_OP = /(===|!==|==|!=|>=|<=|&&|\|\||\?\?|[!<>()?:])/y;
/** The operators that make a marker an inline expression rather than a path or a flat chain. */
const INLINE_ONLY_OPS = new Set([
  "===",
  "!==",
  "==",
  "!=",
  ">=",
  "<=",
  ">",
  "<",
  "&&",
  "!",
  "(",
  ")",
  "?",
  ":",
]);
/** A reference operand's head, its `.name` segments, and its static `[n]`/`["key"]`/`['key']`. */
const REF_HEAD = /[A-Za-z_$][\w$-]*/y;
const REF_DOT = /\.([\w$-]+)/y;
const REF_STATIC_BRACKET = /\[\s*(?:(\d+)|"([^"\\\n\r]*)"|'([^'\\\n\r]*)')\s*\]/y;
const INLINE_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w$.])/y;
const STRING_ESCAPES: Record<string, string> = {
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
/** Binding strength of each infix operator; the ternary binds looser than all of them. */
const INLINE_PRECEDENCE: Record<string, number> = {
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
/** Infix spelling → JSONLogic key. */
const INLINE_KEY: Record<string, string> = { "&&": "and", "||": "or" };
/** The n-ary JSONLogic keys an unparenthesised run of the same operator flattens into. */
const INLINE_NARY = new Set(["or", "and", "??"]);
const INLINE_MAX_DEPTH = 64;

type InlineToken =
  /** `node` is the lowered `get` chain when the path has a computed `[ref]`; else null. */
  | { kind: "ref"; value: string; node: unknown }
  | { kind: "lit"; value: string | number | boolean | null }
  | { kind: "op"; value: string };

/** One quoted string starting at `s[i]` (either quote) → its value and end, or null if malformed. */
function readQuoted(s: string, i: number): { value: string; end: number } | null {
  const quote = s[i];
  let out = "";
  let j = i + 1;
  while (j < s.length) {
    const ch = s[j];
    if (ch === quote) return { value: out, end: j + 1 };
    if (ch === "\n" || ch === "\r") return null;
    if (ch !== "\\") {
      out += ch;
      j += 1;
      continue;
    }
    const escaped = s[j + 1];
    if (escaped === "u") {
      const hex = s.slice(j + 2, j + 6);
      if (!/^[\da-fA-F]{4}$/.test(hex)) return null;
      out += String.fromCharCode(Number.parseInt(hex, 16));
      j += 6;
    } else if (escaped !== undefined && Object.hasOwn(STRING_ESCAPES, escaped)) {
      out += STRING_ESCAPES[escaped];
      j += 2;
    } else {
      return null;
    }
  }
  return null;
}

/** `re` (sticky) matched at `s[i]`, or null. */
function stickyAt(re: RegExp, s: string, i: number): RegExpExecArray | null {
  re.lastIndex = i;
  return re.exec(s);
}

/**
 * Read one reference operand at `s[i]`. A static path (`a.b`, `a[0]`, `a["k"]`) comes back as its
 * raw text with `node: null` — the caller normalises it exactly as before. A path holding a
 * COMPUTED key — an unquoted path inside `[…]`, `state[nodes.x.output.id]` — lowers to nested
 * `{"get":[<object>, <key>]}`: the static prefix is one `var`, each computed key is its own
 * expression (itself possibly computed: `a[b[c]]`), and every segment after the first computed
 * key is a literal key on its own `get` (never a dotted string, since a key may contain dots).
 */
function readRef(
  s: string,
  i: number,
  depth: number,
): { raw: string; node: unknown; end: number } | null {
  if (depth > INLINE_MAX_DEPTH) return null;
  const head = stickyAt(REF_HEAD, s, i);
  if (!head) return null;
  let j = i + head[0].length;
  let node: unknown = null;
  while (j < s.length) {
    const dot = stickyAt(REF_DOT, s, j);
    if (dot) {
      if (node !== null) node = { get: [node, dot[1]] };
      j += dot[0].length;
      continue;
    }
    const fixed = stickyAt(REF_STATIC_BRACKET, s, j);
    if (fixed) {
      if (node !== null) {
        node = { get: [node, fixed[1] !== undefined ? Number(fixed[1]) : (fixed[2] ?? fixed[3])] };
      }
      j += fixed[0].length;
      continue;
    }
    if (s[j] !== "[") break;
    let k = j + 1;
    while (k < s.length && /\s/.test(s[k])) k += 1;
    const key = readRef(s, k, depth + 1);
    if (!key) return null;
    if (key.node === null && ["true", "false", "null"].includes(key.raw)) return null;
    k = key.end;
    while (k < s.length && /\s/.test(s[k])) k += 1;
    if (s[k] !== "]") return null;
    const keyExpr = key.node ?? { var: normalizeRefPath(key.raw) };
    node = { get: [node ?? { var: normalizeRefPath(s.slice(i, j)) }, keyExpr] };
    j = k + 1;
  }
  return { raw: s.slice(i, j), node, end: j };
}

/**
 * Tokenize `s` for the inline-expression grammar, or null when it holds anything the grammar
 * does not know. Quotes and `[…]` segments are consumed whole, so a `?`, `:` or comparison inside
 * a string or a bracket index is never an operator.
 */
function tokenizeInline(s: string): InlineToken[] | null {
  const tokens: InlineToken[] = [];
  let i = 0;
  const sticky = (re: RegExp): string | null => {
    re.lastIndex = i;
    const m = re.exec(s);
    return m ? m[0] : null;
  };
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = readQuoted(s, i);
      if (!q) return null;
      tokens.push({ kind: "lit", value: q.value });
      i = q.end;
      continue;
    }
    const num = sticky(INLINE_NUMBER);
    if (num) {
      const value = Number(num);
      if (!Number.isFinite(value)) return null;
      tokens.push({ kind: "lit", value });
      i += num.length;
      continue;
    }
    const ref = readRef(s, i, 0);
    if (ref) {
      if (ref.node === null && ["true", "false", "null"].includes(ref.raw)) {
        tokens.push({ kind: "lit", value: JSON.parse(ref.raw) });
      } else {
        tokens.push({ kind: "ref", value: ref.raw, node: ref.node });
      }
      i = ref.end;
      continue;
    }
    const op = sticky(INLINE_OP);
    if (op) {
      tokens.push({ kind: "op", value: op });
      i += op.length;
      continue;
    }
    return null;
  }
  return tokens;
}

/** True when `ref` reads the vault — the secret fence's operand test (any position, any depth). */
function isSecretRef(ref: string): boolean {
  return /^secrets(?:[.[]|$)/.test(ref);
}

/** True when any `{ var }` anywhere in `v` — an operand, a computed key or its base — is secret. */
function readsSecret(v: unknown): boolean {
  if (v === null || typeof v !== "object") return false;
  if (Array.isArray(v)) return v.some(readsSecret);
  const ref = asVarOperand(v);
  if (ref !== undefined) return isSecretRef(ref);
  return Object.values(v as Record<string, unknown>).some(readsSecret);
}

/** Thrown inside {@link parseInline} for malformed text; never escapes it. */
class InlineMalformed extends Error {}

/** `parseInline`'s answer: the JSONLogic, `"refused"` (the secret fence), or null (not ours). */
type InlineResult = { expr: unknown } | "refused" | null;

/**
 * Parse `inner` as an inline expression. Null when it carries neither an inline-only operator nor a
 * computed bracket key (so the caller's pre-existing arms keep it), when it is malformed, or when
 * it reduces to a bare static path or literal. `"refused"` when it is well-formed but any `var` in
 * it — an operand, a computed key, or the object a key is read from — reads `secrets`: refused
 * outright, exactly like a chain with a `secrets.` operand, never filtered after the fact.
 */
function parseInline(inner: string): InlineResult {
  const tokens = tokenizeInline(inner);
  const engages = (t: InlineToken) =>
    (t.kind === "op" && INLINE_ONLY_OPS.has(t.value)) || (t.kind === "ref" && t.node !== null);
  if (!tokens || !tokens.some(engages)) return null;
  let pos = 0;
  let depth = 0;
  /** Nodes written inside `( … )` — never flattened into a neighbouring n-ary or `if`. */
  const grouped = new WeakSet<object>();
  const isOp = (value: string) => {
    const t = tokens[pos];
    return t !== undefined && t.kind === "op" && t.value === value;
  };
  const fail = (): never => {
    throw new InlineMalformed();
  };

  const atom = (): unknown => {
    if (++depth > INLINE_MAX_DEPTH) fail();
    try {
      const t = tokens[pos];
      if (!t) return fail();
      if (t.kind === "lit") {
        pos += 1;
        return t.value;
      }
      if (t.kind === "ref") {
        pos += 1;
        if (t.node !== null) return t.node;
        if (isSecretRef(t.value)) return { var: t.value }; // refused below, whatever its spelling
        return { var: normalizeRefPath(t.value) };
      }
      if (t.value === "!") {
        pos += 1;
        return { "!": [atom()] };
      }
      if (t.value === "(") {
        pos += 1;
        const value = conditional();
        if (!isOp(")")) fail();
        pos += 1;
        if (value !== null && typeof value === "object") grouped.add(value);
        return value;
      }
      return fail();
    } finally {
      depth -= 1;
    }
  };

  const binary = (minimum: number): unknown => {
    let left = atom();
    while (true) {
      const t = tokens[pos];
      if (!t || t.kind !== "op") break;
      const prec = INLINE_PRECEDENCE[t.value];
      if (prec === undefined || prec < minimum) break;
      pos += 1;
      const key = INLINE_KEY[t.value] ?? t.value;
      const right = binary(prec + 1);
      const prior = left as Record<string, unknown[]> | null;
      if (
        INLINE_NARY.has(key) && prior !== null && typeof prior === "object" &&
        !grouped.has(prior) && Object.keys(prior).length === 1 && Array.isArray(prior[key])
      ) {
        prior[key].push(right);
      } else {
        left = { [key]: [left, right] };
      }
    }
    return left;
  };

  /** `cond ? a : b`, right-associative; an unparenthesised else-ternary flattens into one `if`. */
  const conditional = (): unknown => {
    if (++depth > INLINE_MAX_DEPTH) fail();
    try {
      const cond = binary(1);
      if (!isOp("?")) return cond;
      pos += 1;
      const then = conditional();
      if (!isOp(":")) fail();
      pos += 1;
      const otherwise = conditional() as Record<string, unknown> | null;
      if (
        otherwise !== null && typeof otherwise === "object" && !grouped.has(otherwise) &&
        Object.keys(otherwise).length === 1 && Array.isArray(otherwise.if)
      ) {
        return { if: [cond, then, ...otherwise.if] };
      }
      return { if: [cond, then, otherwise] };
    } finally {
      depth -= 1;
    }
  };

  let expr: unknown;
  try {
    expr = conditional();
  } catch (e) {
    if (e instanceof InlineMalformed) return null;
    throw e;
  }
  if (pos !== tokens.length) return null;
  // A bare path or literal (`(vars.a)`, `("x")`) is not an expression: keep today's arms.
  if (expr === null || typeof expr !== "object" || asVarOperand(expr) !== undefined) return null;
  if (readsSecret(expr)) return "refused";
  return { expr };
}

/** The inline-grammar JSONLogic key a node uses, if `v` is a single-key operator node. */
function inlineNode(v: unknown): { key: string; args: unknown[] } | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const keys = Object.keys(v as Record<string, unknown>);
  if (keys.length !== 1) return null;
  const args = (v as Record<string, unknown>)[keys[0]];
  if (!Array.isArray(args)) return null;
  const key = keys[0];
  if (key === "if") return args.length >= 3 && args.length % 2 === 1 ? { key, args } : null;
  if (key === "!") return args.length === 1 ? { key, args } : null;
  if (key === "get") return args.length === 2 ? { key, args } : null;
  if (INLINE_NARY.has(key)) return args.length >= 2 ? { key, args } : null;
  if (Object.hasOwn(INLINE_PRECEDENCE, key)) return args.length === 2 ? { key, args } : null;
  return null;
}

/** The `var` refs of an expression made only of inline-grammar shapes, in order; else null. */
function inlineExprRefs(expr: unknown): string[] | null {
  const refs: string[] = [];
  const visit = (v: unknown): boolean => {
    if (isJsonPrimitiveValue(v)) return typeof v !== "number" || Number.isFinite(v);
    const ref = asVarOperand(v);
    if (ref !== undefined) {
      refs.push(ref);
      return true;
    }
    const node = inlineNode(v);
    return node !== null && node.args.every(visit);
  };
  return inlineNode(expr) !== null && visit(expr) ? refs : null;
}

/** A string literal in the inline grammar's single-quoted spelling. */
function quoteInline(s: string): string {
  // deno-lint-ignore no-control-regex -- control characters are exactly what must be escaped
  const escaped = s.replace(/[\\'\u0000-\u001f]/g, (ch) => {
    switch (ch) {
      case "\\":
        return "\\\\";
      case "'":
        return "\\'";
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      case "\b":
        return "\\b";
      case "\f":
        return "\\f";
      default:
        return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
  return `'${escaped}'`;
}

/**
 * A `var` ref as an inline operand: its dot path, with any segment that is not a plain name
 * (`a:b`, `my step`) written as `["…"]` — which `normalizeRefPath` reads straight back to the same
 * dot path. Null when no spelling exists (an empty segment, or one holding a quote or backslash).
 */
function printInlineRef(ref: string): string | null {
  const [head, ...rest] = ref.split(".");
  if (!/^[A-Za-z_$][\w$-]*$/.test(head) || ["true", "false", "null"].includes(ref)) return null;
  let out = head;
  for (const seg of rest) {
    if (/^[\w$-]+$/.test(seg)) out += `.${seg}`;
    else if (seg.length > 0 && !/["\\{}\n\r]/.test(seg)) out += `["${seg}"]`;
    else return null;
  }
  return out;
}

/**
 * A path operand — a `var`, or a `get` chain — in bracket form: `state[nodes.x.id].a["b.c"]`.
 * A literal key prints only after a computed one (before it, it would have been part of the
 * static `var` path); null for any shape the reference grammar cannot spell.
 */
function printRefExpr(v: unknown): string | null {
  const ref = asVarOperand(v);
  if (ref !== undefined) return printInlineRef(ref);
  const node = inlineNode(v);
  if (!node || node.key !== "get") return null;
  const [base, key] = node.args;
  const head = printRefExpr(base);
  if (head === null) return null;
  const afterComputed = inlineNode(base)?.key === "get";
  if (typeof key === "string" && afterComputed) {
    if (/^[\w$-]+$/.test(key)) return `${head}.${key}`;
    return /["\\\n\r]/.test(key) ? null : `${head}["${key}"]`;
  }
  if (typeof key === "number" && afterComputed) {
    return Number.isSafeInteger(key) && key >= 0 && !Object.is(key, -0) ? `${head}[${key}]` : null;
  }
  const computed = printRefExpr(key);
  return computed === null ? null : `${head}[${computed}]`;
}

/** How tightly a printed node binds: ternary 0, the infix table, `!` 6, an operand 7. */
function inlinePrecedence(v: unknown): number {
  const node = inlineNode(v);
  if (!node) return 7;
  if (node.key === "if") return 0;
  if (node.key === "!") return 6;
  if (node.key === "get") return 7;
  const token = node.key === "and" ? "&&" : node.key === "or" ? "||" : node.key;
  return INLINE_PRECEDENCE[token];
}

/**
 * Print an inline-grammar expression as the infix text an author would type, or null when it
 * holds a shape (or a reference) the grammar cannot spell. Self-checking: the text is accepted only
 * if parsing it back yields the identical JSONLogic, so `parse(serialize(x))` is stable by
 * construction rather than by a second copy of the grammar's rules.
 */
function formatInline(expr: unknown): string | null {
  if (inlineExprRefs(expr) === null) return null;
  const print = (v: unknown, minimum: number): string | null => {
    let text: string | null;
    if (typeof v === "string") text = quoteInline(v);
    else if (isJsonPrimitiveValue(v)) text = JSON.stringify(v);
    else {
      const ref = asVarOperand(v);
      if (ref !== undefined) {
        text = printInlineRef(ref);
      } else {
        const node = inlineNode(v)!;
        const own = inlinePrecedence(v);
        if (node.key === "get") {
          text = printRefExpr(v);
        } else if (node.key === "if") {
          const pieces: string[] = [];
          for (let i = 0; i < node.args.length - 1; i += 2) {
            const c = print(node.args[i], 1);
            const t = print(node.args[i + 1], 1);
            if (c === null || t === null) return null;
            pieces.push(`${c} ? ${t} :`);
          }
          const e = print(node.args[node.args.length - 1], 1);
          if (e === null) return null;
          text = `${pieces.join(" ")} ${e}`;
        } else if (node.key === "!") {
          const inner = print(node.args[0], 6);
          text = inner === null ? null : `!${inner}`;
        } else {
          const token = node.key === "and" ? "&&" : node.key === "or" ? "||" : node.key;
          const rendered = node.args.map((a) => print(a, own + 1));
          text = rendered.some((r) => r === null) ? null : rendered.join(` ${token} `);
        }
      }
    }
    if (text === null) return null;
    return inlinePrecedence(v) < minimum ? `(${text})` : text;
  };
  const text = print(expr, 0);
  if (text === null || text.includes(CLOSE)) return null;
  const back = parseInline(text);
  if (back === null || back === "refused") return null;
  return JSON.stringify(back.expr) === JSON.stringify(expr) ? text : null;
}

/** Map the trimmed inner text of one `{{ … }}` to a part, per {@link TemplateMode}. */
function innerToPart(inner: string, mode: TemplateMode): ExprPart {
  if (inner.startsWith("=")) {
    const raw = inner.slice(1).trim();
    try {
      return { kind: "expr", expr: JSON.parse(raw) };
    } catch {
      // Not valid JSON — keep the raw authored string; the engine parses it later.
      return { kind: "expr", expr: raw };
    }
  }
  const inline = parseInline(inner);
  if (inline === "refused") {
    // Same refusal as a chain naming a secret: the original text as a `var` part, never the
    // mode-dependent secrets arm. `hasRefusedChainToken` recognises it.
    return { kind: "var", ref: inner };
  }
  if (inline) return { kind: "expr", expr: inline.expr };
  const chainTokens = findTopLevelChainTokens(inner);
  if (chainTokens.length > 0) {
    const chain = tryChain(inner, chainTokens);
    if (chain) return chain;
    // A chain-shaped input the grammar refused (mixed operators, an empty operand, a
    // `secrets.` operand, …) falls through to today's `var` arm — never to the mode-dependent
    // secrets arm below, since text carrying a top-level `||`/`??` was never a bare secret
    // name. `hasRefusedChainToken` is what a consumer uses to recognise this refusal.
    return { kind: "var", ref: inner };
  }
  if (mode === "editor" && inner.startsWith(SECRET_PREFIX)) {
    return { kind: "secret", ref: inner.slice(SECRET_PREFIX.length) };
  }
  return { kind: "var", ref: normalizeRefPath(inner) };
}

/** `true` if, skipping leading whitespace from `start`, the next char is `=` — the expr arm. */
function isExprOpen(input: string, start: number): boolean {
  let i = start;
  while (i < input.length && /\s/.test(input[i])) i += 1;
  return input[i] === "=";
}

/**
 * Find the depth- and string-aware close of a `=<jsonlogic>` arm: `{`/`[` open,
 * `}`/`]` close, a JSON string literal (`\"` escapes included) is opaque to
 * depth, and the arm ends at the first `}}` seen at depth 0 — checked *before*
 * that position's char is folded into the depth count, so the delimiter itself
 * never contributes to depth. Returns -1 if no depth-0 `}}` exists (half-typed
 * JSON), so the caller can fall back to first-`}}`.
 */
function findBalancedClose(input: string, start: number): number {
  let depth = 0;
  let inString = false;
  let i = start;
  while (i < input.length) {
    const ch = input[i];
    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (depth === 0 && input.startsWith(CLOSE, i)) return i;
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
    }
    i += 1;
  }
  return -1;
}

/**
 * Parse a `{{ }}` template string into parts. Literal text becomes `text` parts;
 * an unterminated `{{` (no matching `}}`) is treated as literal text, never an
 * error — so half-typed input stays editable. `mode` (default `"editor"`)
 * selects which arms {@link innerToPart} can dispatch to — see {@link TemplateMode}.
 * `escape` opts in to `\{{` escaping (see {@link TemplateEscape}); omitted, a backslash is
 * ordinary text, as it always was.
 */
export function parseTemplate(
  input: string,
  mode: TemplateMode = "editor",
  escape?: TemplateEscape,
): ExprPart[] {
  const parts: ExprPart[] = [];
  let text = "";
  let i = 0;
  const flushText = () => {
    if (text) {
      parts.push({ kind: "text", value: text });
      text = "";
    }
  };
  while (i < input.length) {
    if (input.startsWith(OPEN, i)) {
      const innerStart = i + OPEN.length;
      const exprArm = isExprOpen(input, innerStart);
      let end = exprArm ? findBalancedClose(input, innerStart) : input.indexOf(CLOSE, innerStart);
      if (end === -1 && exprArm) end = input.indexOf(CLOSE, innerStart);
      // Widen the close scan, conservatively: only when the naive first-`}}` inner carries a
      // top-level `||`/`??` token do we re-scan depth/string-aware — every marker with no such
      // token (every vendor spelling, `{{ vars.a }}`, `{{name}}`, …) keeps byte-identical
      // close-finding, per out_of_scope: this is not a second `}}` scanner.
      if (
        !exprArm && end !== -1 && findTopLevelChainTokens(input.slice(innerStart, end)).length > 0
      ) {
        const balanced = findBalancedClose(input, innerStart);
        if (balanced >= 0) end = balanced;
      }
      if (end === -1) {
        text += input.slice(i); // unterminated → literal
        break;
      }
      const part = innerToPart(input.slice(innerStart, end).trim(), mode);
      const slashes = escape ? trailingBackslashes(text) : 0;
      if (escape && slashes > 0 && escape.isOurs(part)) {
        if (escape.backslash === "strip") {
          // `\\` → `\`; an odd count leaves one more, which escapes the marker.
          text = text.slice(0, text.length - slashes) + "\\".repeat(Math.floor(slashes / 2));
        }
        if (slashes % 2 === 1) {
          text += input.slice(i, end + CLOSE.length); // escaped → the marker's own source text
          i = end + CLOSE.length;
          continue;
        }
      }
      flushText();
      parts.push(part);
      i = end + CLOSE.length;
    } else {
      text += input[i];
      i += 1;
    }
  }
  flushText();
  return parts;
}

/**
 * Parse a `{{ }}` template in `render` mode — the engine's entry point.
 *
 * It takes NO mode parameter, by design: {@link parseTemplate}'s default is the
 * unfenced `editor` mode, so a caller that forgets the second argument still
 * compiles, typechecks, runs, and silently drops barrier 1 of the secret fence
 * (D-8). There is no argument here to forget, and no second argument that can
 * select the editor mode. Deliberately a declaration, not a re-export alias:
 * an alias would carry the defaulted parameter along with it.
 */
export function parseRenderTemplate(input: string): ExprPart[] {
  return parseTemplate(input, "render");
}

function isJsonPrimitiveValue(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** `v`'s `var` ref if `v` is a single-key `{ var: <string> }` object, else `undefined`. */
function asVarOperand(v: unknown): string | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const keys = Object.keys(v as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "var") return undefined;
  const ref = (v as Record<string, unknown>).var;
  return typeof ref === "string" ? ref : undefined;
}

/** A flat `||`/`??` fallback chain recognised from a JSONLogic payload. */
export interface CoalesceChain {
  op: "or" | "??";
  operands: unknown[];
}

/** A flat fallback chain, else null (every other JSONLogic shape stays opaque). */
export function parseCoalesceChain(expr: unknown): CoalesceChain | null {
  if (expr === null || typeof expr !== "object" || Array.isArray(expr)) return null;
  const keys = Object.keys(expr as Record<string, unknown>);
  if (keys.length !== 1) return null;
  const key = keys[0];
  if (key !== "or" && key !== "??") return null;
  const operands = (expr as Record<string, unknown>)[key];
  if (!Array.isArray(operands) || operands.length < 2) return null;
  for (const operand of operands) {
    if (!isJsonPrimitiveValue(operand) && asVarOperand(operand) === undefined) return null;
  }
  return { op: key, operands };
}

/**
 * The `var` refs of an expression the inline `{{ }}` grammar writes — a recognised `||`/`??` chain,
 * or a ternary / comparison / `&&` / `!` expression over paths and literals — in order; null for
 * every other JSONLogic shape. This is the set a consumer root-checks: an inline expression is ours
 * iff every ref it reads is rooted, exactly as a chain is (RFC workflow.md, 2026-08-20 and
 * 2026-11-11 amendments). The check is by SHAPE, so a `{{ =<jsonlogic> }}` payload of one of these
 * shapes is judged the same way.
 */
export function coalesceOperandRefs(expr: unknown): string[] | null {
  const chain = parseCoalesceChain(expr);
  if (!chain) return inlineExprRefs(expr);
  const refs: string[] = [];
  for (const operand of chain.operands) {
    const ref = asVarOperand(operand);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

/**
 * True when a `var` ref is an inline expression the grammar REFUSED: it still carries a top-level
 * `||`/`??`, or it is a well-formed ternary/comparison expression refused for reading `secrets`.
 * A consumer must not treat either as an ordinary path.
 */
export function hasRefusedChainToken(ref: string): boolean {
  return findTopLevelChainTokens(ref).length > 0 || parseInline(ref) === "refused";
}

/** Serialize parts back to a `{{ }}` template string (inverse of {@link parseTemplate}). */
export function serializeTemplate(parts: ExprPart[]): string {
  let out = "";
  for (const p of parts) {
    switch (p.kind) {
      case "text":
        out += p.value ?? "";
        break;
      case "var":
        out += `${OPEN} ${p.ref ?? ""} ${CLOSE}`;
        break;
      case "secret":
        out += `${OPEN} ${SECRET_PREFIX}${p.ref ?? ""} ${CLOSE}`;
        break;
      case "expr": {
        const chain = parseCoalesceChain(p.expr);
        if (chain) {
          const token = CHAIN_TOKEN[chain.op];
          const rendered = chain.operands
            .map((operand) => {
              const ref = asVarOperand(operand);
              return ref !== undefined ? ref : JSON.stringify(operand);
            })
            .join(` ${token} `);
          out += `${OPEN} ${rendered} ${CLOSE}`;
          break;
        }
        const infix = formatInline(p.expr);
        if (infix !== null) {
          out += `${OPEN} ${infix} ${CLOSE}`;
          break;
        }
        const raw = typeof p.expr === "string" ? p.expr : JSON.stringify(p.expr ?? "");
        out += `${OPEN} =${raw} ${CLOSE}`;
        break;
      }
    }
  }
  return out;
}
