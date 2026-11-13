import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { BuildError } from "../src/errors.ts";
import { moduleAllowed, readRegistryMap } from "../src/registry.ts";

async function withDeno(imports: Record<string, string>, fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/deno.json`, JSON.stringify({ imports }));
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function code(dir: string): Promise<string> {
  const e = await assertRejects(() => readRegistryMap(dir, dir), BuildError);
  return e.code;
}

Deno.test("4a: caret range is registry_spec_invalid", async () => {
  await withDeno({ "@w6w/types": "jsr:@w6w/types@^0.2.0" }, async (d) => {
    assertEquals(await code(d), "registry_spec_invalid");
  });
});

Deno.test("4b: unapproved key @w6w/runtime (host root) is registry_spec_invalid", async () => {
  await withDeno({ "@w6w/runtime": "jsr:@w6w/runtime@0.2.0" }, async (d) => {
    assertEquals(await code(d), "registry_spec_invalid");
  });
});

Deno.test("approved P3 map yields pairs and gates module URLs", async () => {
  await withDeno({
    "@w6w/types": "jsr:@w6w/types@0.2.0",
    "@w6w/runtime/author": "jsr:@w6w/runtime@0.2.0/author",
    "@w6w/app-kit/poll": "jsr:@w6w/app-kit@0.1.0/poll",
  }, async (d) => {
    const { pairs } = await readRegistryMap(d, d);
    assertEquals([...pairs].sort(), ["app-kit@0.1.0", "runtime@0.2.0", "types@0.2.0"]);
    const h = "http://127.0.0.1:1/";
    assertEquals(moduleAllowed(`${h}@w6w/types/0.2.0/mod.ts`, pairs, h), true);
    assertEquals(moduleAllowed(`${h}@w6w/types/0.3.0/mod.ts`, pairs, h), false);
    assertEquals(moduleAllowed(`${h}@w6w/server/0.2.0/mod.ts`, pairs, h), false);
  });
});
