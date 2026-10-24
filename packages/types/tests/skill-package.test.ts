import { assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  canonicalSkillPath,
  DEFAULT_SKILL_PACKAGE_LIMITS,
  extractSkillFrontmatter,
  MAX_FRONTMATTER_NODES,
  SKILL_PACKAGE_CODES,
  validateSkillPackage,
} from "../mod.ts";

Deno.test("extract: valid block, CRLF and BOM", () => {
  assertEquals(extractSkillFrontmatter("---\nname: a\n---\nbody"), { raw: "name: a" });
  assertEquals(extractSkillFrontmatter("﻿---\r\nname: a\r\n---\r\nx"), { raw: "name: a" });
});

Deno.test("extract: missing / unterminated / oversize", () => {
  assertEquals(extractSkillFrontmatter("# hi"), { error: "frontmatter_missing" });
  assertEquals(extractSkillFrontmatter("\n---\na: 1\n---"), { error: "frontmatter_missing" });
  assertEquals(extractSkillFrontmatter("---\nname: a\n"), { error: "frontmatter_unterminated" });
  assertEquals(extractSkillFrontmatter("---\n" + "a".repeat(20) + "\n---", { maxBytes: 10 }), {
    error: "frontmatter_too_large",
  });
  assertEquals(extractSkillFrontmatter("---\n" + "a".repeat(10) + "\n---", { maxBytes: 10 }), {
    raw: "a".repeat(10),
  });
  assertEquals(extractSkillFrontmatter("---\n" + "a".repeat(20), { maxBytes: 10 }), {
    error: "frontmatter_too_large",
  });
});

Deno.test("constants and canonical path", () => {
  assertEquals(new Set(SKILL_PACKAGE_CODES).size, SKILL_PACKAGE_CODES.length);
  assertEquals(typeof MAX_FRONTMATTER_NODES, "number");
  assertEquals(DEFAULT_SKILL_PACKAGE_LIMITS.maxFiles > 0, true);
  assertEquals(canonicalSkillPath("A/é.MD"), "a/é.md");
  assertEquals(canonicalSkillPath("a/%2E%2e/b"), "a/%2e%2e/b");
});

Deno.test("validate stub returns empty report", () => {
  const r = validateSkillPackage({ entries: [], frontmatter: {} });
  assertEquals(r.errors, []);
  assertEquals(r.warnings, []);
});
