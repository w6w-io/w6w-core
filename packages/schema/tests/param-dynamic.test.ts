import { assertEquals } from "jsr:@std/assert@^1.0.0";

const load = async (name: string) =>
  JSON.parse(await Deno.readTextFile(new URL(`../schemas/${name}`, import.meta.url)));

Deno.test("param schema: refreshOn on the dynamic options arm", async () => {
  const s = await load("param.schema.json");
  assertEquals(s.$defs.options.oneOf[1].properties.refreshOn, {
    type: "array",
    items: { type: "string", minLength: 1 },
  });
});

Deno.test("param schema: config.allowCustom", async () => {
  const s = await load("param.schema.json");
  assertEquals(s.$defs.config.properties.allowCustom, { type: "boolean" });
});

Deno.test("action schema: resolveFields const true", async () => {
  const s = await load("action.schema.json");
  assertEquals(s.properties.resolveFields, { const: true });
});

Deno.test("param schema: when overlay is closed at entry, if and set", async () => {
  const s = await load("param.schema.json");
  const when = s.properties.when;
  assertEquals(when.type, "array");
  const entry = when.items;
  assertEquals(entry.additionalProperties, false);
  assertEquals(entry.required, ["if", "set"]);
  assertEquals(entry.properties.if.additionalProperties, false);
  assertEquals(entry.properties.if.required, ["field"]);
  assertEquals(entry.properties.if.properties, {
    field: { type: "string", minLength: 1 },
    equals: true,
    in: { type: "array" },
    notIn: { type: "array" },
    truthy: { type: "boolean" },
  });
  const set = entry.properties.set;
  assertEquals(set.additionalProperties, false);
  assertEquals(Object.keys(set.properties).sort().join(","), "hint,label,options,required,ui");
  assertEquals(set.properties.options, { $ref: "#/$defs/options" });
  assertEquals(set.properties.required, { type: "boolean" });
});
