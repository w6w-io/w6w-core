/**
 * Param resolution. Applies defaults, enforces `required`, and runs declarative
 * validation against supplied values.
 *
 * NOTE: This is the static subset of the Action RFC's fixpoint resolution loop.
 * Dynamic `options.source`, `dependsOn` ordering, and `validation.hook` are a
 * later slice; this covers the path that needs no hook execution.
 */
import type { Param, Validation } from "@w6w/types";
import { W6WError } from "./errors.ts";

function fail(message: string, details?: unknown): never {
  throw new W6WError("param_invalid", "resolution", message, details);
}

function checkDeclarative(param: Param, value: unknown): void {
  const v: Validation = param.validation ?? {};
  const enumValues = v.enum;

  if (typeof value === "string") {
    if (v.pattern && !new RegExp(v.pattern).test(value)) {
      fail(`Param "${param.key}" does not match pattern ${v.pattern}.`);
    }
    if (v.minLength !== undefined && value.length < v.minLength) {
      fail(`Param "${param.key}" is shorter than minLength ${v.minLength}.`);
    }
    if (v.maxLength !== undefined && value.length > v.maxLength) {
      fail(`Param "${param.key}" is longer than maxLength ${v.maxLength}.`);
    }
  }

  if (typeof value === "number") {
    if (v.min !== undefined && value < v.min) fail(`Param "${param.key}" is below min ${v.min}.`);
    if (v.max !== undefined && value > v.max) fail(`Param "${param.key}" is above max ${v.max}.`);
    if (v.integer && !Number.isInteger(value)) fail(`Param "${param.key}" must be an integer.`);
  }

  if (enumValues && (typeof value === "string" || typeof value === "number")) {
    if (!enumValues.includes(value)) {
      fail(`Param "${param.key}" is not one of the allowed values.`, { allowed: enumValues });
    }
  }
}

/** Resolve and validate supplied values against an Action's params. */
export function resolveParams(
  params: Param[],
  supplied: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};

  for (const param of params) {
    const hasSupplied = Object.prototype.hasOwnProperty.call(supplied, param.key);
    const value = hasSupplied ? supplied[param.key] : param.default;

    if (value === undefined || value === null) {
      if (param.required) fail(`Required param "${param.key}" is missing.`);
      continue;
    }

    checkDeclarative(param, value);
    resolved[param.key] = value;
  }

  return resolved;
}
