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
        const raw = typeof p.expr === "string" ? p.expr : JSON.stringify(p.expr ?? "");
        out += `${OPEN} =${raw} ${CLOSE}`;
        break;
      }
    }
  }
  return out;
}
