import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  compareOutputShape,
  type ObservedShape,
  observedShapeOfValue,
  type OutputField,
} from "../mod.ts";

const f = (key: string, type: OutputField["type"], items?: OutputField[]): OutputField => ({
  key,
  type,
  label: key,
  ...(items ? { items } : {}),
});

Deno.test("compare: clean match yields an empty diff", () => {
  const d = compareOutputShape([f("id", "string"), f("n", "number")], {
    id: "string",
    n: "number",
  });
  assertEquals(d, { missing: [], extra: [], typeMismatch: [] });
});

Deno.test("compare: missing top-level key", () => {
  assertEquals(compareOutputShape([f("id", "string")], { other: "string" }).missing, ["id"]);
});

Deno.test("compare: missing nested key under an observed object parent", () => {
  const d = compareOutputShape([f("venue.city", "string")], { venue: "object" });
  assertEquals(d.missing, ["venue.city"]);
});

Deno.test("compare: null or absent parent never yields missing", () => {
  const decl = [f("venue.address.city", "string")];
  assertEquals(compareOutputShape(decl, { venue: "null" }).missing, []);
  // Round 1: a dotted declaration implies its ancestor `venue`; wholly absent at the root it is
  // reported missing itself (R1-A3), while the deeper `venue.address.city` stays exempt.
  assertEquals(compareOutputShape(decl, {}).missing, ["venue"]);
  assertEquals(compareOutputShape(decl, { venue: "object" }).missing, []); // venue.address absent
});

Deno.test("compare: empty array never yields missing for item keys", () => {
  const d = compareOutputShape([f("webhooks", "array", [f("id", "string")])], {
    webhooks: "array",
  });
  assertEquals(d.missing, []);
});

Deno.test("compare: items keys become <key>.0.<itemKey> (missing + mismatch)", () => {
  const decl = [
    f("webhooks", "array", [f("id", "string"), f("endpoint_url", "string"), f("actions", "array")]),
  ];
  const obs: ObservedShape = {
    webhooks: "array",
    "webhooks.0": "object",
    "webhooks.0.id": "number",
    "webhooks.0.actions": "array",
  };
  const d = compareOutputShape(decl, obs);
  assertEquals(d.missing, ["webhooks.0.endpoint_url"]);
  assertEquals(d.typeMismatch, [{ key: "webhooks.0.id", declared: "string", observed: "number" }]);
  assertEquals(d.extra, []);
});

Deno.test("compare: items descend one level only", () => {
  const decl = [
    f("a", "array", [f("b", "array", [f("c", "string")])]),
  ];
  const obs: ObservedShape = {
    a: "array",
    "a.0": "object",
    "a.0.b": "array",
    "a.0.b.0": "object",
  };
  // b's own items are not descended: "a.0.b.0.c" is neither declared nor reported missing.
  assertEquals(compareOutputShape(decl, obs), { missing: [], extra: [], typeMismatch: [] });
});

Deno.test("compare: typeMismatch on differing observed type", () => {
  const d = compareOutputShape([f("id", "string")], { id: "number" });
  assertEquals(d.typeMismatch, [{ key: "id", declared: "string", observed: "number" }]);
});

Deno.test("compare: observed null / unknown is never a mismatch", () => {
  const decl = [f("a", "string"), f("b", "string")];
  assertEquals(compareOutputShape(decl, { a: "null", b: "unknown" }).typeMismatch, []);
});

Deno.test("compare: declared file never mismatches", () => {
  assertEquals(compareOutputShape([f("doc", "file")], { doc: "object" }).typeMismatch, []);
  assertEquals(compareOutputShape([f("doc", "file")], { doc: "string" }).typeMismatch, []);
});

Deno.test("compare: extra top-level observed key", () => {
  assertEquals(compareOutputShape([f("id", "string")], { id: "string", z: "number" }).extra, ["z"]);
});

Deno.test("compare: extra under a declared path with declared children", () => {
  const d = compareOutputShape([f("venue", "object"), f("venue.city", "string")], {
    venue: "object",
    "venue.city": "string",
    "venue.zip": "string",
  });
  assertEquals(d.extra, ["venue.zip"]);
});

Deno.test("compare: opaque declared object/element is not expanded into extras", () => {
  const d = compareOutputShape([f("venue", "object"), f("hooks", "array")], {
    venue: "object",
    "venue.city": "string",
    "venue.address": "object",
    "venue.address.line": "string",
    hooks: "array",
    "hooks.0": "object",
    "hooks.0.id": "string",
  });
  assertEquals(d.extra, []);
});

Deno.test("compare: extra inside a declared element", () => {
  const d = compareOutputShape([f("hooks", "array", [f("id", "string")])], {
    hooks: "array",
    "hooks.0": "object",
    "hooks.0.id": "string",
    "hooks.0.secret": "string",
  });
  assertEquals(d.extra, ["hooks.0.secret"]);
});

Deno.test("observed: plain objects expand to dotted paths", () => {
  assertEquals(observedShapeOfValue({ a: { b: 1, c: "x" }, d: true, e: null }), {
    a: "object",
    "a.b": "number",
    "a.c": "string",
    d: "boolean",
    e: "null",
  });
});

Deno.test("observed: array elements merge under .0", () => {
  assertEquals(observedShapeOfValue({ xs: [{ id: 1 }, { id: 2, name: "n" }] }), {
    xs: "array",
    "xs.0": "object",
    "xs.0.id": "number",
    "xs.0.name": "string",
  });
});

Deno.test("observed: conflicting non-null types become unknown, null yields", () => {
  assertEquals(
    observedShapeOfValue({ xs: [{ v: 1 }, { v: "s" }, { v: null }] })["xs.0.v"],
    "unknown",
  );
  assertEquals(observedShapeOfValue({ xs: [{ v: null }, { v: 1 }] })["xs.0.v"], "number");
});

Deno.test("observed: depth is bounded at 8 segments", () => {
  let v: unknown = "leaf";
  for (let i = 0; i < 12; i++) v = { k: v };
  const keys = Object.keys(observedShapeOfValue(v));
  assertEquals(Math.max(...keys.map((k) => k.split(".").length)), 8);
});

Deno.test("observed: non-object root yields an empty shape", () => {
  assertEquals(observedShapeOfValue("x"), {});
  assertEquals(observedShapeOfValue(null), {});
});

Deno.test("observed: no input value appears in the serialized result", () => {
  const secret = "SECRET-VALUE-123";
  const shape = observedShapeOfValue({ a: secret, b: { c: [secret, { d: secret }] }, n: 424242 });
  const diff = compareOutputShape([f("a", "number"), f("zz", "string")], shape);
  const out = JSON.stringify([shape, diff]);
  assertEquals(out.includes(secret), false);
  assertEquals(out.includes("424242"), false);
});

const venueName = [f("venue.name", "string")];
const empty = { missing: [], extra: [], typeMismatch: [] };

Deno.test("compare: dotted declaration does not report its parent as extra (R1-A1)", () => {
  assertEquals(
    compareOutputShape(venueName, observedShapeOfValue({ venue: { name: "x" } })),
    empty,
  );
});

Deno.test("compare: dotted declaration still reports an undeclared sibling (R1-A2)", () => {
  const d = compareOutputShape(
    venueName,
    observedShapeOfValue({ venue: { name: "x", city: "y" } }),
  );
  assertEquals(d.extra, ["venue.city"]);
});

Deno.test("compare: dotted declaration with absent parent reports the parent missing (R1-A3)", () => {
  assertEquals(compareOutputShape(venueName, observedShapeOfValue({})).missing, ["venue"]);
});

Deno.test("compare: dotted key inside items implies its ancestor (R1-A4)", () => {
  const d = compareOutputShape(
    [f("webhooks", "array", [f("venue.id", "string")])],
    observedShapeOfValue({ webhooks: [{ venue: { id: "1" } }] }),
  );
  assertEquals(d, empty);
  const e = compareOutputShape(
    [f("webhooks", "array", [f("venue.id", "string")])],
    observedShapeOfValue({ webhooks: [{ venue: { id: "1", x: 1 } }] }),
  );
  assertEquals(e.extra, ["webhooks.0.venue.x"]);
});
