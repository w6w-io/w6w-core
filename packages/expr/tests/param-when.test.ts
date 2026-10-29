import { assert, assertEquals, assertFalse, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import {
  effectiveParam,
  matchesParamCondition,
  PARAM_OVERLAY_KEYS,
  type ParamWhen,
} from "../mod.ts";

const get = (m: Record<string, unknown>) => (k: string) => m[k];

Deno.test("matchesParamCondition: equals arm", () => {
  assert(matchesParamCondition({ field: "a", equals: 1 }, get({ a: 1 })));
  assertFalse(matchesParamCondition({ field: "a", equals: 1 }, get({ a: "1" })));
});
Deno.test("matchesParamCondition: in arm", () => {
  assert(matchesParamCondition({ field: "a", in: [1, 2] }, get({ a: 2 })));
  assertFalse(matchesParamCondition({ field: "a", in: [1, 2] }, get({ a: 3 })));
});
Deno.test("matchesParamCondition: notIn arm", () => {
  assert(matchesParamCondition({ field: "a", notIn: [1] }, get({ a: 2 })));
  assertFalse(matchesParamCondition({ field: "a", notIn: [1] }, get({ a: 1 })));
});
Deno.test("matchesParamCondition: truthy arm", () => {
  assert(matchesParamCondition({ field: "a", truthy: true }, get({ a: "x" })));
  assertFalse(matchesParamCondition({ field: "a", truthy: true }, get({})));
  assert(matchesParamCondition({ field: "a", truthy: false }, get({})));
});
Deno.test("matchesParamCondition: precedence in before notIn", () => {
  // in matches (a=1) but notIn would fail; `in` decides
  assert(matchesParamCondition({ field: "a", in: [1], notIn: [1] }, get({ a: 1 })));
  assertFalse(matchesParamCondition({ field: "a", equals: 2, in: [1] }, get({ a: 1 })));
});
Deno.test("matchesParamCondition: no arm is true", () => {
  assert(matchesParamCondition({ field: "a" }, get({})));
});

const w = (field: string, equals: unknown, set: ParamWhen["set"]): ParamWhen => ({
  if: { field, equals },
  set,
});

Deno.test("effectiveParam: first match wins", () => {
  const p = { key: "k", label: "L", when: [w("s", 1, { label: "A" }), w("s", 1, { label: "B" })] };
  assertEquals(effectiveParam(p, get({ s: 1 })).label, "A");
});
Deno.test("effectiveParam: only overlay keys change", () => {
  const set = { label: "N", type: "number", key: "zz", default: 5 } as unknown as ParamWhen["set"];
  const p = { key: "k", label: "L", type: "string", when: [w("s", 1, set)] };
  const out = effectiveParam(p, get({ s: 1 }));
  assertEquals(out.label, "N");
  assertEquals(out.key, "k");
  assertEquals(out.type, "string");
  assertEquals((out as Record<string, unknown>).default, undefined);
});
Deno.test("effectiveParam: undefined in set does not clobber", () => {
  const p = { key: "k", label: "L", hint: "H", when: [w("s", 1, { label: undefined })] };
  const out = effectiveParam(p, get({ s: 1 }));
  assertEquals(out.label, "L");
  assertEquals(out.hint, "H");
});
Deno.test("effectiveParam: same reference when no when / no match", () => {
  const a: { key: string; when?: ParamWhen[] } = { key: "k" };
  assertStrictEquals(effectiveParam(a, get({})), a);
  const b = { key: "k", when: [w("s", 1, { label: "A" })] };
  assertStrictEquals(effectiveParam(b, get({ s: 2 })), b);
});
Deno.test("effectiveParam: input not mutated", () => {
  const p = { key: "k", label: "L", when: [w("s", 1, { label: "A", required: true })] };
  const clone = structuredClone(p);
  const out = effectiveParam(p, get({ s: 1 }));
  assert(out !== p);
  assertEquals(p, clone);
});
Deno.test("PARAM_OVERLAY_KEYS exact", () => {
  assertEquals([...PARAM_OVERLAY_KEYS], ["label", "hint", "required", "ui", "options"]);
});
