import { assertEquals, assertFalse } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { describe, loadApp } from "../mod.ts";

const HELLO_DIR = fromFileUrl(new URL("../../../fixtures/apps/hello", import.meta.url));
const SENDGRID_DIR = fromFileUrl(new URL("../../../fixtures/apps/sendgrid", import.meta.url));

Deno.test("describe() surfaces a declared Interface conformance verbatim", async () => {
  const app = await loadApp(HELLO_DIR);
  const desc = describe(app);

  assertEquals(desc.interfaces, [{
    interfaceId: "fixture-greeter@1",
    methods: {
      greet: {
        uses: { action: "get-greeting" },
        with: { name: { "$": "inputs.name" } },
        outputMap: { greeting: { "$": "output.greeting" } },
      },
    },
  }]);
});

Deno.test("describe() returns an empty array for an app declaring no Interfaces", async () => {
  const app = await loadApp(SENDGRID_DIR);
  const desc = describe(app);

  assertEquals(desc.interfaces, []);
});

Deno.test("a conformance method binding crosses the sandbox as plain JSON, not a passthrough", async () => {
  const app = await loadApp(HELLO_DIR);
  const desc = describe(app);

  const conformance = desc.interfaces.find((c) => c.interfaceId === "fixture-greeter@1");
  const binding = conformance?.methods.greet;
  assertFalse(binding && "execute" in binding);
  // Plain JSON round-trip: serializing again must be lossless.
  assertEquals(JSON.parse(JSON.stringify(binding)), binding);
});
