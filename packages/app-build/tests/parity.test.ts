import { assertEquals } from "jsr:@std/assert@^1.0.0";
import type { DescribedApp } from "@w6w/runtime";
import { compareDescribed } from "../mod.ts";

// deno-lint-ignore no-explicit-any
const base = (): any => ({
  actions: [{ key: "a", name: "A", n: { x: 1, y: 2 } }],
  auth: [{ key: "k", hooks: ["sign"] }],
  triggers: [{ key: "t", hooks: [] }],
  healthChecks: [{ key: "h", probe: true }],
  interfaces: [{ id: "i" }],
});

Deno.test("compareDescribed: equal ignoring object key order", () => {
  const b = base();
  b.actions = [{ n: { y: 2, x: 1 }, name: "A", key: "a" }];
  assertEquals(compareDescribed(base() as DescribedApp, b as DescribedApp), []);
});

const mutate: Record<string, (d: ReturnType<typeof base>) => void> = {
  actions: (d) => d.actions[0].name = "B",
  auth: (d) => d.auth[0].hooks = ["refresh"],
  triggers: (d) => d.triggers.push({ key: "t2", hooks: [] }),
  healthChecks: (d) => d.healthChecks[0].probe = false,
  interfaces: (d) => d.interfaces = [],
};
for (const [key, fn] of Object.entries(mutate)) {
  Deno.test(`compareDescribed: names only ${key}`, () => {
    const b = base();
    fn(b);
    assertEquals(compareDescribed(base() as DescribedApp, b as DescribedApp), [key]);
  });
}

Deno.test("compareDescribed: array order is significant", () => {
  const b = base();
  const a = base();
  a.actions.push({ key: "z" });
  b.actions = [{ key: "z" }, a.actions[0]];
  assertEquals(compareDescribed(a as DescribedApp, b as DescribedApp), ["actions"]);
});
