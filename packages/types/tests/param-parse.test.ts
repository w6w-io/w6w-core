import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { type ParamDefinition, parseParams } from "../src/param.ts";

const upper = (v: unknown) => String(v).toUpperCase();

Deno.test("parseParams: top-level, section (flat), group (nested), repeat scalar", async () => {
  const params: ParamDefinition[] = [
    { key: "a", label: "A", type: "string", parse: upper },
    {
      key: "s",
      label: "S",
      type: "section",
      section: "collapsible",
      title: "S",
      children: [{ key: "b", label: "B", type: "string", parse: upper }],
    },
    {
      key: "g",
      label: "G",
      type: "group",
      children: [{ key: "c", label: "C", type: "string", parse: upper }],
    },
    { key: "tags", label: "Tags", type: "string", repeat: true, parse: upper },
  ];
  const out = await parseParams(params, { a: "x", b: "y", g: { c: "z" }, tags: ["p", "q"] });
  assertEquals(out, { a: "X", b: "Y", g: { c: "Z" }, tags: ["P", "Q"] });
});

Deno.test("parseParams: absent values skip the parser; no parser returns the same object", async () => {
  const seen: unknown[] = [];
  const params: ParamDefinition[] = [
    { key: "a", label: "A", type: "string", parse: (v) => (seen.push(v), v) },
    { key: "b", label: "B", type: "string" },
  ];
  const values = { b: "kept" };
  assertStrictEquals(await parseParams(params, values), values);
  assertEquals(seen, []);
});

Deno.test("parseParams: an async parser is awaited", async () => {
  const params: ParamDefinition[] = [
    { key: "a", label: "A", type: "string", parse: (v) => Promise.resolve(`${v}!`) },
  ];
  assertEquals(await parseParams(params, { a: "hi" }), { a: "hi!" });
});
