/**
 * Sanity checks. We don't run a full JSON Schema validator here — that lives in
 * @w6w/validator's conformance suite, where Ajv is wired in. Here we just
 * confirm every schema file is valid JSON with the expected `$id` and that the
 * top-level `schemas` export enumerates them.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { schemas } from "../mod.ts";

const EXPECTED_NAMES = [
  "app",
  "action",
  "auth",
  "param",
  "imageObject",
  "connection",
  "invocation",
] as const;

Deno.test("schemas object exports every primitive", () => {
  for (const name of EXPECTED_NAMES) {
    assert(name in schemas, `missing schema export "${name}"`);
  }
});

Deno.test("every schema declares a w6w.io $id and Draft 2020-12", () => {
  for (const [name, schema] of Object.entries(schemas)) {
    const s = schema as { $id?: string; $schema?: string };
    assert(s.$id?.startsWith("https://w6w.io/schemas/v1/"), `${name}: bad $id ${s.$id}`);
    assertEquals(s.$schema, "https://json-schema.org/draft/2020-12/schema", `${name}: bad $schema`);
  }
});
