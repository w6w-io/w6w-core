import { assertEquals } from "jsr:@std/assert@^1.0.0";

const load = async (name: string) =>
  JSON.parse(await Deno.readTextFile(new URL(`../schemas/${name}`, import.meta.url)));

Deno.test("action schema: outputField admits items as an array of outputField", async () => {
  const s = await load("action.schema.json");
  const f = s.$defs.outputField;
  assertEquals(f.properties.items, {
    type: "array",
    items: { $ref: "#/$defs/outputField" },
  });
  assertEquals(f.additionalProperties, false);
});

Deno.test("action schema: outputField items requires type array", async () => {
  const s = await load("action.schema.json");
  const f = s.$defs.outputField;
  assertEquals(f.if, { required: ["items"] });
  assertEquals(f.then, { properties: { type: { const: "array" } } });
});
