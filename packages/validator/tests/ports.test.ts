import { assert, assertFalse } from "jsr:@std/assert@^1.0.0";
import { validateAction, validateApp } from "../mod.ts";

const ACTION = { key: "go", type: "perform", title: "Go" };
const APP = {
  manifestVersion: "1",
  id: "com.acme.slack",
  name: "slack",
  displayName: "Slack",
  version: "1.4.2",
  description: "Send messages in Slack.",
  categories: ["communication"],
  appearance: { icon: { svg: "./icon.svg" } },
  author: { name: "Acme" },
};

const bad: [string, unknown][] = [
  ["out -1", { out: -1 }],
  ["in 1.5", { in: 1.5 }],
  ["out string 2", { out: "2" }],
  ["number 3", 3],
];
const good: [string, unknown][] = [
  ["empty", {}],
  ["in 0", { in: 0 }],
  ["out many", { out: "many" }],
  ["in 10 out 1", { in: 10, out: 1 }],
];

for (const [name, ports] of bad) {
  Deno.test(`action rejects ports ${name}`, () => {
    const r = validateAction({ ...ACTION, ports });
    assertFalse(r.ok);
    assert(r.errors.some((e) => e.path.startsWith("action.ports")));
  });
  Deno.test(`app rejects ports ${name}`, () => {
    const r = validateApp({ ...APP, ports });
    assertFalse(r.ok);
    assert(r.errors.some((e) => e.path.startsWith("ports")));
  });
}
for (const [name, ports] of good) {
  Deno.test(`action accepts ports ${name}`, () => {
    assert(validateAction({ ...ACTION, ports }).ok);
  });
  Deno.test(`app accepts ports ${name}`, () => {
    const r = validateApp({ ...APP, ports });
    assertFalse(r.errors.some((e) => e.path.startsWith("ports")));
  });
}
