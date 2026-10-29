import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { checkParamWhen, validateAction, validateAuth } from "../mod.ts";

const f = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  label: key,
  type: "string",
  ...extra,
});
const w = (when: unknown, key = "b") => [f("a"), f(key, { when })];
const errs = (params: unknown) => checkParamWhen(params, "p");
const only = (params: unknown, path: string, msg?: string) => {
  const e = errs(params);
  assertEquals(e.length, 1, JSON.stringify(e));
  assertEquals(e[0].path, path);
  if (msg) assert(e[0].message.includes(msg), e[0].message);
};
const ok = { if: { field: "a", equals: 1 }, set: { required: true } };

Deno.test("valid: well-formed when yields no errors", () => {
  assertEquals(errs(w([ok])), []);
  assertEquals(
    errs([f("a"), f("b", { when: [{ if: { field: "a", truthy: true }, set: {} }] })]),
    [],
  );
});

Deno.test("V1 when not an array", () => only(w({}), "p[1].when", "array"));
Deno.test("V2 entry not an object", () => only(w([3]), "p[1].when[0]", "object"));
Deno.test("V3 if.field missing/empty/non-string", () => {
  for (const field of [undefined, "", 4]) {
    only(w([{ if: { field, equals: 1 }, set: {} }]), "p[1].when[0].if.field");
  }
});
Deno.test("V4 if.field names the param itself", () => {
  only(
    w([{ if: { field: "b", equals: 1 }, set: {} }]),
    "p[1].when[0].if.field",
    "must not name the field itself",
  );
});
Deno.test("V5 if.field names no param in scope", () => {
  only(w([{ if: { field: "zzz", equals: 1 }, set: {} }]), "p[1].when[0].if.field", "zzz");
});
Deno.test("V6 if has no arm", () => {
  only(w([{ if: { field: "a" }, set: {} }]), "p[1].when[0].if");
});
Deno.test("V7 in/notIn not array, truthy not boolean", () => {
  only(w([{ if: { field: "a", in: 1 }, set: {} }]), "p[1].when[0].if.in");
  only(w([{ if: { field: "a", notIn: "x" }, set: {} }]), "p[1].when[0].if.notIn");
  only(w([{ if: { field: "a", truthy: "yes" }, set: {} }]), "p[1].when[0].if.truthy");
});
Deno.test("V8 set not an object", () => {
  only(w([{ if: { field: "a", equals: 1 }, set: [] }]), "p[1].when[0].set");
});
Deno.test("V9 set key outside the overlayable five", () => {
  only(
    w([{ if: { field: "a", equals: 1 }, set: { type: "number" } }]),
    "p[1].when[0].set.type",
  );
});
Deno.test("V10 set value types", () => {
  for (const k of ["label", "hint", "ui"]) {
    only(w([{ if: { field: "a", equals: 1 }, set: { [k]: 1 } }]), `p[1].when[0].set.${k}`);
  }
  only(w([{ if: { field: "a", equals: 1 }, set: { required: "y" } }]), "p[1].when[0].set.required");
});

Deno.test("scope: section child names a top-level sibling", () => {
  const params = [
    f("a"),
    { key: "s", label: "s", type: "section", section: "group", children: [f("b", { when: [ok] })] },
  ];
  assertEquals(errs(params), []);
});
Deno.test("scope: group child names an enclosing-form key", () => {
  const params = [f("a"), {
    key: "g",
    label: "g",
    type: "group",
    children: [f("b", { when: [ok] })],
  }];
  assertEquals(errs(params), []);
});
Deno.test("scope: group child names a group-local key", () => {
  const params = [{
    key: "g",
    label: "g",
    type: "group",
    children: [f("a"), f("b", { when: [ok] })],
  }];
  assertEquals(errs(params), []);
});
Deno.test("scope: enclosing form cannot see a group-local key", () => {
  const params = [
    { key: "g", label: "g", type: "group", children: [f("a")] },
    f("b", { when: [ok] }),
  ];
  assertEquals(errs(params).length, 1);
});

Deno.test("validateAction surfaces when errors", () => {
  const r = validateAction({
    key: "x",
    type: "perform",
    title: "X",
    params: w([{ if: { field: "zzz", equals: 1 }, set: {} }]),
  });
  assert(r.errors.some((e) => e.path === "action.params[1].when[0].if.field"));
});

Deno.test("validateAuth surfaces when errors", () => {
  const r = validateAuth({
    key: "k",
    type: "apiKey",
    displayName: "K",
    apiKey: { in: "header", name: "A" },
    fields: w([{ if: { field: "zzz", equals: 1 }, set: {} }]),
  });
  assert(r.errors.some((e) => e.path === "auth.fields[1].when[0].if.field"));
});
