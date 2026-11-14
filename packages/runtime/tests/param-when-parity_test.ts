/**
 * Parity guard for the vendored `src/param-when.ts`.
 *
 * `@w6w/runtime` carries its own copy of `@w6w/expr`'s `param-when.ts` so the
 * package needs no consumer-side `@w6w/expr` import mapping. These tests keep
 * the copy honest: same behaviour on a table of params/conditions, and the same
 * source text apart from the vendor header.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  effectiveParam as vendoredEffectiveParam,
  matchesParamCondition as vendoredMatchesParamCondition,
  PARAM_OVERLAY_KEYS as VENDORED_OVERLAY_KEYS,
  type ParamCondition,
  type ParamWhen,
} from "../src/param-when.ts";
import {
  effectiveParam as exprEffectiveParam,
  matchesParamCondition as exprMatchesParamCondition,
  PARAM_OVERLAY_KEYS as EXPR_OVERLAY_KEYS,
} from "../../expr/mod.ts";

interface FixtureParam {
  key: string;
  label?: string;
  hint?: string;
  required?: boolean;
  ui?: string;
  options?: readonly string[];
  when?: readonly ParamWhen[];
}

interface Case {
  name: string;
  param: FixtureParam;
  values: Record<string, unknown>;
}

const CASES: readonly Case[] = [
  { name: "no when entry at all", param: { key: "to", required: true }, values: {} },
  {
    name: "condition does not match, param untouched",
    param: {
      key: "cc",
      label: "CC",
      when: [{ if: { field: "mode", equals: "advanced" }, set: { required: true } }],
    },
    values: { mode: "simple" },
  },
  {
    name: "equals arm matches and overlays required",
    param: {
      key: "cc",
      label: "CC",
      when: [{ if: { field: "mode", equals: "advanced" }, set: { required: true } }],
    },
    values: { mode: "advanced" },
  },
  {
    name: "in arm matches",
    param: {
      key: "bcc",
      when: [{ if: { field: "mode", in: ["advanced", "expert"] }, set: { required: true } }],
    },
    values: { mode: "expert" },
  },
  {
    name: "notIn arm matches",
    param: {
      key: "bcc",
      when: [{ if: { field: "mode", notIn: ["simple"] }, set: { hint: "expert only" } }],
    },
    values: { mode: "expert" },
  },
  {
    name: "notIn arm does not match",
    param: {
      key: "bcc",
      when: [{ if: { field: "mode", notIn: ["simple"] }, set: { hint: "expert only" } }],
    },
    values: { mode: "simple" },
  },
  {
    name: "truthy arm matches",
    param: {
      key: "token",
      when: [{ if: { field: "useToken", truthy: true }, set: { required: true, ui: "password" } }],
    },
    values: { useToken: "yes" },
  },
  {
    name: "falsy arm matches on undefined field",
    param: {
      key: "token",
      when: [{ if: { field: "useToken", truthy: false }, set: { required: false } }],
    },
    values: {},
  },
  {
    name: "empty condition (no arms) always matches",
    param: { key: "token", when: [{ if: { field: "anything" }, set: { label: "Token" } }] },
    values: {},
  },
  {
    name: "first matching when entry wins",
    param: {
      key: "token",
      label: "Token",
      when: [
        { if: { field: "mode", equals: "simple" }, set: { required: false } },
        { if: { field: "mode", equals: "simple" }, set: { required: true, label: "Other" } },
        { if: { field: "mode", equals: "expert" }, set: { required: true } },
      ],
    },
    values: { mode: "simple" },
  },
  {
    name: "overlay sets every PARAM_OVERLAY_KEYS member",
    param: {
      key: "model",
      label: "Model",
      hint: "old",
      required: false,
      ui: "text",
      options: ["a"],
      when: [
        {
          if: { field: "mode", equals: "expert" },
          set: {
            label: "Expert model",
            hint: "new",
            required: true,
            ui: "select",
            options: ["a", "b"],
          },
        },
      ],
    },
    values: { mode: "expert" },
  },
  {
    name: "overlay leaves keys it does not set alone",
    param: {
      key: "model",
      label: "Model",
      hint: "keep me",
      options: ["a"],
      when: [{ if: { field: "mode", equals: "expert" }, set: { required: true } }],
    },
    values: { mode: "expert" },
  },
];

for (const c of CASES) {
  Deno.test(`vendored effectiveParam matches @w6w/expr — ${c.name}`, () => {
    const getValue = (key: string) => c.values[key];
    const vendored = vendoredEffectiveParam(c.param, getValue);
    const expr = exprEffectiveParam(c.param, getValue);
    assertEquals(vendored, expr);
    // `required` is what resolve.ts reads off the result, so pin it directly.
    assertEquals(vendored.required, expr.required);
  });
}

const CONDITIONS: readonly {
  name: string;
  cond: ParamCondition;
  values: Record<string, unknown>;
}[] = [
  { name: "no arms present", cond: { field: "mode" }, values: { mode: "simple" } },
  { name: "equals hit", cond: { field: "mode", equals: "simple" }, values: { mode: "simple" } },
  { name: "equals miss", cond: { field: "mode", equals: "simple" }, values: { mode: "expert" } },
  { name: "in hit", cond: { field: "mode", in: ["a", "b"] }, values: { mode: "b" } },
  { name: "in miss", cond: { field: "mode", in: ["a", "b"] }, values: { mode: "c" } },
  { name: "notIn hit", cond: { field: "mode", notIn: ["a"] }, values: { mode: "c" } },
  { name: "notIn miss", cond: { field: "mode", notIn: ["a"] }, values: { mode: "a" } },
  { name: "truthy hit", cond: { field: "flag", truthy: true }, values: { flag: 1 } },
  { name: "truthy miss", cond: { field: "flag", truthy: true }, values: { flag: 0 } },
  { name: "truthy false hit", cond: { field: "flag", truthy: false }, values: {} },
  { name: "absent field", cond: { field: "missing", equals: undefined }, values: {} },
];

for (const c of CONDITIONS) {
  Deno.test(`vendored matchesParamCondition matches @w6w/expr — ${c.name}`, () => {
    const getValue = (key: string) => c.values[key];
    assertEquals(
      vendoredMatchesParamCondition(c.cond, getValue),
      exprMatchesParamCondition(c.cond, getValue),
    );
  });
}

Deno.test("vendored PARAM_OVERLAY_KEYS is the @w6w/expr list", () => {
  assertEquals(VENDORED_OVERLAY_KEYS, EXPR_OVERLAY_KEYS);
});

/** Drop the vendor header so the remainder can be compared to the source. */
function stripVendorHeader(text: string): string {
  assert(text.startsWith("/**"), "param-when.ts must open with the vendor header comment");
  const end = text.indexOf("*/");
  assert(end > 0, "the vendor header comment must be terminated");
  return text.slice(end + 2).replace(/^\n+/, "");
}

Deno.test("vendored param-when.ts is byte-identical to @w6w/expr apart from the header", async () => {
  const vendored = await Deno.readTextFile(new URL("../src/param-when.ts", import.meta.url));
  const source = await Deno.readTextFile(
    new URL("../../expr/src/param-when.ts", import.meta.url),
  );
  assertEquals(stripVendorHeader(vendored), source);
});

Deno.test("the vendor header names its source", async () => {
  const vendored = await Deno.readTextFile(new URL("../src/param-when.ts", import.meta.url));
  const header = vendored.slice(0, vendored.indexOf("*/") + 2);
  assert(header.includes("packages/expr/src/param-when.ts"));
  assert(header.includes("@w6w/expr"));
});

Deno.test("resolve.ts takes effectiveParam from the vendored copy", async () => {
  const source = await Deno.readTextFile(new URL("../src/resolve.ts", import.meta.url));
  assert(source.includes('from "./param-when.ts"'));
  assertEquals(source.includes("@w6w/expr"), false);
});

Deno.test("runtime/deno.json carries no @w6w/expr mapping", async () => {
  const config = JSON.parse(await Deno.readTextFile(new URL("../deno.json", import.meta.url))) as {
    imports?: Record<string, string>;
  };
  assertEquals(Object.keys(config.imports ?? {}).includes("@w6w/expr"), false);
});
