import { assert, assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@^1.0.0";
import { resolveParams, W6WError } from "../mod.ts";
import type { Param } from "@w6w/types";

Deno.test("resolveParams flattens section children into the enclosing level", () => {
  // A `type: "section"` container (sendgrid's `sender`) whose children submit
  // FLAT — not nested under the section's `key`.
  const params: Param[] = [
    { key: "to", label: "To", type: "string", required: true },
    {
      key: "sender",
      label: "Sender",
      type: "section",
      section: "group",
      children: [
        { key: "fromEmail", label: "From Email", type: "string", required: true },
        { key: "fromName", label: "From Name", type: "string" },
      ],
    },
  ];

  const resolved = resolveParams(params, {
    to: "dest@example.com",
    fromEmail: "sender@example.com",
    fromName: "Sender",
  });

  // Section children survive at the top level.
  assertEquals(resolved.fromEmail, "sender@example.com");
  assertEquals(resolved.fromName, "Sender");
  assertEquals(resolved.to, "dest@example.com");
  // The section's own key is layout-only and contributes no value.
  assertFalse(Object.prototype.hasOwnProperty.call(resolved, "sender"));
});

Deno.test("resolveParams enforces required on a section child", () => {
  const params: Param[] = [
    {
      key: "sender",
      label: "Sender",
      type: "section",
      section: "group",
      children: [
        { key: "fromEmail", label: "From Email", type: "string", required: true },
      ],
    },
  ];

  assertThrows(
    () => resolveParams(params, {}),
    W6WError,
    "fromEmail",
  );
});

Deno.test("resolveParams descends into nested sections", () => {
  const params: Param[] = [
    {
      key: "outer",
      label: "Outer",
      type: "section",
      section: "collapsible",
      title: "Outer",
      children: [
        {
          key: "inner",
          label: "Inner",
          type: "section",
          section: "group",
          children: [
            { key: "deep", label: "Deep", type: "string" },
          ],
        },
      ],
    },
  ];

  const resolved = resolveParams(params, { deep: "value" });

  assertEquals(resolved.deep, "value");
  assertFalse(Object.prototype.hasOwnProperty.call(resolved, "outer"));
  assertFalse(Object.prototype.hasOwnProperty.call(resolved, "inner"));
});

Deno.test("resolveParams leaves a group's value nested under its key (not flattened)", () => {
  const params: Param[] = [
    {
      key: "headers",
      label: "Headers",
      type: "group",
      children: [
        { key: "name", label: "Name", type: "string" },
        { key: "value", label: "Value", type: "string" },
      ],
    },
  ];

  const resolved = resolveParams(params, {
    headers: { name: "X-Trace", value: "abc" },
  });

  // A group nests under its key — its whole value object is copied as-is and its
  // children are NOT hoisted to the enclosing level.
  assertEquals(resolved.headers, { name: "X-Trace", value: "abc" });
  assertFalse(Object.prototype.hasOwnProperty.call(resolved, "name"));
  assertFalse(Object.prototype.hasOwnProperty.call(resolved, "value"));
});

Deno.test("resolveParams preserves defaults for flat params", () => {
  const params: Param[] = [
    { key: "limit", label: "Limit", type: "number", default: 10 },
  ];

  const resolved = resolveParams(params, {});
  assert(resolved.limit === 10);
});
