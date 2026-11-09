import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { evaluate, normalizeRefPath, parseTemplate, serializeTemplate } from "../mod.ts";

Deno.test("normalizeRefPath: [n], [\"key\"] and ['key'] read as dot segments", () => {
  assertEquals(normalizeRefPath("messages[0].id"), "messages.0.id");
  assertEquals(normalizeRefPath("items[2]"), "items.2");
  assertEquals(normalizeRefPath('user["name"]'), "user.name");
  assertEquals(normalizeRefPath("user['name'].first"), "user.name.first");
  assertEquals(normalizeRefPath("a[ 1 ][2]"), "a.1.2");
});

Deno.test("normalizeRefPath: a dotless path and an unaddressable key are left as written", () => {
  assertEquals(normalizeRefPath("messages.0.id"), "messages.0.id");
  assertEquals(normalizeRefPath("m['a.b']"), "m['a.b']");
  assertEquals(normalizeRefPath("[0].x"), "[0].x");
});

Deno.test("a {{ }} marker with brackets saves back in dot form", () => {
  const parts = parseTemplate("{{ steps.s.output.messages[0].id }}");
  assertEquals(parts, [{ kind: "var", ref: "steps.s.output.messages.0.id" }]);
  assertEquals(serializeTemplate(parts), "{{ steps.s.output.messages.0.id }}");
});

Deno.test("JSONLogic var reads a bracketed array item", () => {
  assertEquals(evaluate({ var: "m[1].id" }, { m: [{ id: "a" }, { id: "b" }] }), "b");
});
