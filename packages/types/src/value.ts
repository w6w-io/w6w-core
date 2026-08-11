/**
 * Value — the multipart/expression value model for a step's `with` block.
 *
 * A `with` value is either a plain literal, OR one of the envelopes below.
 * The normative specification is the Workflow RFC — see `rfcs/workflow.md`,
 * *Amendment — 2026-08-11: the multipart expression envelope (`ExprValue`) and
 * the `render` part kind*:
 *
 *   - **ExprValue** (`{ type: "expr", parts: [...] }`) — an ordered list of
 *     segments that concatenate to a single string at resolve time. Each part is
 *     `text` (a literal chunk), `var` / `secret` (a named reference), `expr`
 *     (inline JSONLogic), or `render` (a path whose resolved string is parsed as
 *     a `{{ }}` template and rendered). Resolved by extending the engine's
 *     existing `resolveValue` seam (`w6w-workflow/engine/src/expr.ts`) alongside
 *     the current `{"$":path}` / `{"$expr":logic}` markers — one authoritative
 *     value model, not a second grammar.
 *   - **SecretValue** (`{ type: "secret", ciphertext, iv }`) — the at-rest form
 *     of a secret-typed field: an AES-256-GCM encrypted scalar (base64),
 *     decrypted server-side via `packages/server/packages/db/crypto.ts`. The
 *     client renders it as `***`; the server-side parser resolves the real value
 *     at run time.
 *
 * These are TYPES ONLY — no runtime crypto lives here; the server owns crypto.
 */

/** The segment kinds an {@link ExprValue} part can take. */
export type ExprPartKind = "text" | "var" | "secret" | "expr" | "render";

/**
 * One segment of an {@link ExprValue}. The populated field depends on `kind`:
 *   - `text`   → `value` holds a literal string chunk.
 *   - `var`    → `ref` names a project variable.
 *   - `secret` → `ref` names a vault secret (surfaced via the secret picker).
 *   - `expr`   → `expr` holds inline JSONLogic evaluated against the run scope.
 *   - `render` → `ref` names the path whose resolved string is parsed and
 *     rendered as a `{{ }}` template against the same run scope. No new field:
 *     `render` reuses `ref`.
 */
export interface ExprPart {
  kind: ExprPartKind;
  /** Literal chunk, for `kind: "text"`. */
  value?: string;
  /** Name/path of the reference, for `kind: "var" | "secret" | "render"`. */
  ref?: string;
  /** Inline JSONLogic, for `kind: "expr"`. */
  expr?: unknown;
}

/**
 * A multipart value: an ordered list of {@link ExprPart} segments that
 * concatenate to a string at resolve time.
 */
export interface ExprValue {
  type: "expr";
  parts: ExprPart[];
}

/**
 * The at-rest form of a secret-typed scalar field: AES-GCM ciphertext + IV
 * (both base64). Decrypted server-side; never decrypted in Core or the client.
 */
export interface SecretValue {
  type: "secret";
  ciphertext: string;
  iv: string;
}

/** `true` if `v` is an {@link ExprValue} envelope. Safe on `unknown`. */
export function isExprValue(v: unknown): v is ExprValue {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { type?: unknown }).type === "expr" &&
    Array.isArray((v as { parts?: unknown }).parts)
  );
}

/** `true` if `v` is a {@link SecretValue} envelope. Safe on `unknown`. */
export function isSecretValue(v: unknown): v is SecretValue {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    (v as { type?: unknown }).type === "secret" &&
    typeof (v as { ciphertext?: unknown }).ciphertext === "string" &&
    typeof (v as { iv?: unknown }).iv === "string"
  );
}

/** `true` if `v` is either a value envelope ({@link ExprValue} | {@link SecretValue}). */
export function isValueEnvelope(v: unknown): v is ExprValue | SecretValue {
  return isExprValue(v) || isSecretValue(v);
}
