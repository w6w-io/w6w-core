import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { checkFormResolvedFields, validateAction } from "../mod.ts";

const dyn = (refreshOn?: string[]) => ({
  source: "resolveFields",
  ...(refreshOn ? { refreshOn } : {}),
});
const field = (key: string, options?: unknown) => ({
  key,
  label: key,
  type: "select",
  ...(options === undefined ? {} : { options }),
});
const action = (params: unknown[], hook = true) => ({
  key: "send",
  type: "perform",
  title: "Send",
  ...(hook ? { resolveFields: true } : {}),
  params,
});

Deno.test("(i) opt-in param on an action without the hook is an error", () => {
  const r = checkFormResolvedFields(action([field("a", dyn())], false));
  assertEquals(r.errors.length, 1);
  assertEquals(r.errors[0].path, "action.params[0].options.source");
  assertEquals(r.warnings, []);
  // nested in a group counts too
  const g = checkFormResolvedFields(
    action([{ key: "g", label: "g", type: "group", children: [field("a", dyn())] }], false),
  );
  assertEquals(g.errors.length, 1);
  assertEquals(g.errors[0].path, "action.params[0].children[0].options.source");
  // resolveFields: false is not the hook
  const f = checkFormResolvedFields({ ...action([field("a", dyn())]), resolveFields: false });
  assertEquals(f.errors.length, 1);
});

Deno.test("(ii) refreshOn naming no param in scope is an error", () => {
  const r = checkFormResolvedFields(action([field("a", dyn(["nope"])), field("b")]));
  assertEquals(r.errors.length, 1);
  assertEquals(r.errors[0].path, "action.params[0].options.refreshOn[0]");
  assertEquals(r.warnings, []);
  const ok = checkFormResolvedFields(action([field("a", dyn(["b"])), field("b")]));
  assertEquals(ok.errors, []);
});

Deno.test("(iii) refreshOn naming the field's own key is an error", () => {
  const r = checkFormResolvedFields(action([field("a", dyn(["a"]))]));
  assertEquals(r.errors.length, 1);
  assertEquals(r.errors[0].path, "action.params[0].options.refreshOn[0]");
  assert(r.errors[0].message.includes("itself"));
});

Deno.test("(iv) hook with no opting param is a warning, not an error", () => {
  const r = checkFormResolvedFields(action([field("a")]));
  assertEquals(r.errors, []);
  assertEquals(r.warnings.length, 1);
  assertEquals(r.warnings[0].path, "action.resolveFields");
  const v = validateAction(action([field("a")]));
  assertEquals(v.ok, true);
  assertEquals(v.warnings?.length, 1);
});

Deno.test("scope: group sibling does not satisfy a top-level refreshOn; section-nested does", () => {
  const grouped = checkFormResolvedFields(action([
    field("a", dyn(["inner"])),
    { key: "g", label: "g", type: "group", children: [field("inner")] },
  ]));
  assertEquals(grouped.errors.length, 1);
  assertEquals(grouped.errors[0].path, "action.params[0].options.refreshOn[0]");

  const sectioned = checkFormResolvedFields(action([
    field("a", dyn(["inner", "deep"])),
    {
      key: "s",
      label: "s",
      type: "section",
      section: "group",
      children: [field("inner"), {
        key: "s2",
        label: "s2",
        type: "section",
        section: "group",
        children: [field("deep")],
      }],
    },
  ]));
  assertEquals(sectioned.errors, []);

  // a section's own key is not a value, so it cannot be refreshed on
  const sec = checkFormResolvedFields(action([
    field("a", dyn(["s"])),
    { key: "s", label: "s", type: "section", section: "group", children: [field("x")] },
  ]));
  assertEquals(sec.errors.length, 1);

  // a group's children form their own scope: a sibling inside the group works,
  // and an outer key does not
  const inGroup = checkFormResolvedFields(action([
    field("outer"),
    {
      key: "g",
      label: "g",
      type: "group",
      children: [field("x", dyn(["y"])), field("y"), field("z", dyn(["outer"]))],
    },
  ]));
  assertEquals(inGroup.errors.length, 1);
  assertEquals(inGroup.errors[0].path, "action.params[1].children[2].options.refreshOn[0]");
});

Deno.test("clean action: no errors, no warnings, and no `warnings` key", () => {
  const clean = action([field("a", dyn(["b"])), field("b")]);
  const r = checkFormResolvedFields(clean);
  assertEquals(r, { errors: [], warnings: [] });
  const v = validateAction(clean);
  assertEquals(v.ok, true);
  assertEquals("warnings" in v, false);
  const plain = validateAction(
    action([field("a", ["x", "y"].map((s) => ({ value: s, label: s })))], false),
  );
  assertEquals(plain.ok, true);
  assertEquals("warnings" in plain, false);
  assertEquals(checkFormResolvedFields("not an object"), { errors: [], warnings: [] });
});

Deno.test("validateAction reports (i)-(iii) as errors", () => {
  const v = validateAction(action([field("a", dyn(["a", "zzz"]))], false));
  assertEquals(v.ok, false);
  assertEquals(v.errors.length, 3);
});
