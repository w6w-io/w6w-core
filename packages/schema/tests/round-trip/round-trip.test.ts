/**
 * Serialization round-trip. Locks the "serialization-agnostic" claim from the
 * App RFC: the same logical manifest survives a trip through each supported
 * format without semantic loss.
 *
 * Equality is *logical*, not byte-for-byte at the wire layer (YAML preserves
 * different whitespace than JSON; TOML re-orders keys). We canonicalize the
 * round-tripped value back into JSON and compare against the canonical JSON
 * of the source fixture.
 *
 * XML is mentioned by the App RFC but is intentionally not covered here yet:
 * lossless XML round-trip of arbitrary JSON-like data requires the spec to
 * pick a convention (BadgerFish vs JsonML vs …). That decision is a follow-up
 * RFC; once it lands we add an `xml.ts` adapter and another test case here.
 */
import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { parse as parseYaml, stringify as stringifyYaml } from "jsr:@std/yaml@^1.0.0";
import { parse as parseToml, stringify as stringifyToml } from "jsr:@std/toml@^1.0.0";
import { APP_FIXTURE } from "./fixture.ts";
import { canonicalJson } from "./normalize.ts";

const SOURCE = canonicalJson(APP_FIXTURE);

Deno.test("round-trip: JSON", () => {
  const text = JSON.stringify(APP_FIXTURE);
  const back = JSON.parse(text);
  assertEquals(canonicalJson(back), SOURCE);
});

Deno.test("round-trip: YAML", () => {
  const text = stringifyYaml(APP_FIXTURE as Record<string, unknown>);
  const back = parseYaml(text);
  assertEquals(canonicalJson(back), SOURCE);
});

Deno.test("round-trip: TOML", () => {
  const text = stringifyToml(APP_FIXTURE as Record<string, unknown>);
  const back = parseToml(text);
  assertEquals(canonicalJson(back), SOURCE);
});
