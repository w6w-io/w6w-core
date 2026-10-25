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
