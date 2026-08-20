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
 * against `{ vars, steps, trigger, foreach }` — e.g. `vars.env`,
 * `steps.fetch.output.title`. A project variable named `env` is therefore
 * `vars.env`, matching `RunScope`. Secrets are keyed by bare name
 * (`scope.secrets[NAME]`), so they carry the `secrets.` prefix only in text form.
 *
 * A sealed at-rest secret ({ type:"secret", ciphertext, iv }) has no text form
 * and is never produced or consumed here — the editor handles it separately.
 *
 * `ExprPart` is imported by RELATIVE path on purpose: this module is loaded by
 * `packages/ui` through a pnpm `link:` dependency, and Node resolves that
 * symlink to its realpath inside `packages/core`, which has no `node_modules`.
 * A bare `@w6w/types` specifier dies there with `ERR_MODULE_NOT_FOUND`.
 */

import type { ExprPart } from "../../types/mod.ts";

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
  return { var: trimmed };
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
  return { kind: "var", ref: inner };
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
 */
export function parseTemplate(input: string, mode: TemplateMode = "editor"): ExprPart[] {
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
      flushText();
      parts.push(innerToPart(input.slice(innerStart, end).trim(), mode));
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

/** The `var` refs of a recognised chain's operands, in order; null when not a chain. */
export function coalesceOperandRefs(expr: unknown): string[] | null {
  const chain = parseCoalesceChain(expr);
  if (!chain) return null;
  const refs: string[] = [];
  for (const operand of chain.operands) {
    const ref = asVarOperand(operand);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

/** True when a `var` ref still carries a top-level `||`/`??` — a chain the grammar REFUSED. */
export function hasRefusedChainToken(ref: string): boolean {
  return findTopLevelChainTokens(ref).length > 0;
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
        const raw = typeof p.expr === "string" ? p.expr : JSON.stringify(p.expr ?? "");
        out += `${OPEN} =${raw} ${CLOSE}`;
        break;
      }
    }
  }
  return out;
}
