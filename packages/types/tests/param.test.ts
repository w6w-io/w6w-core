/**
 * `isFormResolvedOptions` truth table + type-level checks for the
 * `resolveFields` surface.
 */
import { assert, assertFalse } from "jsr:@std/assert@^1.0.0";
import { isFormResolvedOptions, type Options } from "../src/param.ts";
import type { Action, ActionDefinition } from "../src/action.ts";
import type { ResolveFieldsHook } from "../src/hooks.ts";

Deno.test("isFormResolvedOptions: true only for source exactly 'resolveFields'", () => {
  assert(isFormResolvedOptions({ source: "resolveFields" }));
  assert(isFormResolvedOptions({ source: "resolveFields", refreshOn: ["org"] }));
});

Deno.test("isFormResolvedOptions: false for near-misses", () => {
  assertFalse(isFormResolvedOptions({ source: "./hooks/x.ts" }));
  assertFalse(isFormResolvedOptions({ source: "resolveFieldsX" }));
  assertFalse(isFormResolvedOptions({ source: " resolveFields" }));
  assertFalse(isFormResolvedOptions([] as Options));
  assertFalse(isFormResolvedOptions([{ value: "a", label: "A" }]));
  assertFalse(isFormResolvedOptions(undefined));
});

Deno.test("resolveFields typing", () => {
  const base = { key: "k", type: "read" as const, title: "T" };
  // @ts-expect-error the flag is `true`, a function is not assignable on Action
  const _a: Action = { ...base, resolveFields: () => ({ fields: {} }) };
  // @ts-expect-error ActionDefinition carries the function, not `true`
  const _d: ActionDefinition = { ...base, execute: () => null, resolveFields: true };
  const hook: ResolveFieldsHook = () => ({
    fields: { k: { options: [{ value: 1, label: "x" }] } },
  });
  const ok: ActionDefinition = { ...base, execute: () => null, resolveFields: hook };
  const flagged: Action = { ...base, resolveFields: true };
  assert(ok.resolveFields === hook);
  assert(flagged.resolveFields === true);
});
