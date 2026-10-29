/**
 * `Param.when` — the one shared condition evaluator and overlay helper.
 * Studio's form, the Test gate and the runtime's `required` check all read
 * through here so they cannot drift.
 */

/** Condition shape shared with `showIf`'s simple dialect. First present arm decides. */
export interface ParamCondition {
  field: string;
  equals?: unknown;
  in?: readonly unknown[];
  notIn?: readonly unknown[];
  truthy?: boolean;
}

/** The only Param keys a `when` entry may override. */
export interface ParamOverlay<O = unknown> {
  label?: string;
  hint?: string;
  required?: boolean;
  ui?: string;
  options?: O;
}

export interface ParamWhen<O = unknown> {
  if: ParamCondition;
  set: ParamOverlay<O>;
}

export const PARAM_OVERLAY_KEYS = ["label", "hint", "required", "ui", "options"] as const;

/** Evaluate a condition against `getValue`. No arm present means true. */
export function matchesParamCondition(
  cond: ParamCondition,
  getValue: (key: string) => unknown,
): boolean {
  const v = getValue(cond.field);
  if (cond.equals !== undefined) return v === cond.equals;
  if (cond.in) return cond.in.some((x) => x === v);
  if (cond.notIn) return !cond.notIn.some((x) => x === v);
  if (cond.truthy !== undefined) return cond.truthy ? !!v : !v;
  return true;
}

/**
 * Overlay the first matching `when` entry onto a shallow copy of `param`.
 * Returns the same object when there is no `when` or nothing matches.
 */
export function effectiveParam<P extends { when?: readonly ParamWhen[] }>(
  param: P,
  getValue: (key: string) => unknown,
): P {
  if (!param.when) return param;
  const hit = param.when.find((w) => matchesParamCondition(w.if, getValue));
  if (!hit) return param;
  const out: Record<string, unknown> = { ...param };
  const set = hit.set as Record<string, unknown>;
  for (const k of PARAM_OVERLAY_KEYS) {
    if (set[k] !== undefined) out[k] = set[k];
  }
  return out as P;
}
