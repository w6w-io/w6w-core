/**
 * Recursive canonical-key sort. Two logically-equal values, after this pass,
 * serialize byte-identically through `JSON.stringify`. Arrays preserve order;
 * objects' keys are sorted lexicographically.
 *
 * This is what makes the round-trip tests testable: the spec's
 * "serialization-agnostic" claim is about *logical* equality, not about
 * preserving insertion order or formatting choices a given format imposes.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
