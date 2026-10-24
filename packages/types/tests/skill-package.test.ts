import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.0";
import {
  canonicalSkillPath,
  DEFAULT_SKILL_PACKAGE_LIMITS,
  extractSkillFrontmatter,
  MAX_FRONTMATTER_NODES,
  SKILL_PACKAGE_CODES,
  type SkillEntry,
  type SkillEntryKind,
  type SkillPackageLimits,
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

const FM = { name: "demo", description: "d" };
const LIM: SkillPackageLimits = {
  maxFileBytes: 100,
  maxPackageBytes: 1000,
  maxFiles: 5,
  maxDepth: 4,
  maxPathBytes: 40,
};
const f = (path: string, size = 1, kind: SkillEntryKind = "file"): SkillEntry => ({
  path,
  size,
  kind,
});
const run = (extra: SkillEntry[], opts: { skill?: boolean; limits?: SkillPackageLimits } = {}) =>
  validateSkillPackage({
    entries: [...(opts.skill === false ? [] : [f("SKILL.md")]), ...extra],
    frontmatter: FM,
    limits: opts.limits ?? LIM,
  });
const codes = (r: ReturnType<typeof run>) => r.errors.map((e) => `${e.code}:${e.path ?? ""}`);

Deno.test("valid flat package: root is empty string", () => {
  const r = run([f("docs/a.md")]);
  assertEquals(r.errors, []);
  assertEquals(r.ok, true);
  assertEquals(r.root, "");
});

Deno.test("root strip: once, only for a single shared top dir", () => {
  const r = run([f("wrap/SKILL.md"), f("wrap/docs/a.md"), f("wrap/", 0, "dir")], {
    skill: false,
  });
  assertEquals(r.errors, []);
  assertEquals(r.root, "wrap");
  // stripped once only: SKILL.md one level deeper is not at the root
  const nested = run([f("wrap/inner/SKILL.md")], { skill: false });
  assertEquals(codes(nested), ["skill_md_missing:"]);
  assertEquals(nested.root, null);
  // two top dirs: no strip, SKILL.md missing
  assertEquals(codes(run([f("a/SKILL.md"), f("b/x.md")], { skill: false })), [
    "skill_md_missing:",
  ]);
  // SKILL.md at the top blocks the strip
  const top = run([f("wrap/x.md")]);
  assertEquals(top.root, "");
  // SKILL.md is matched exactly (case-sensitive)
  assertEquals(codes(run([f("skill.md")], { skill: false })), ["skill_md_missing:"]);
  assertEquals(codes(run([f("wrap/Skill.md")], { skill: false })), ["skill_md_missing:"]);
  // a directory named SKILL.md is not a SKILL.md
  assertEquals(codes(run([f("SKILL.md", 0, "dir")], { skill: false })), ["skill_md_missing:"]);
});

Deno.test("empty entry list", () => {
  const r = validateSkillPackage({ entries: [], frontmatter: FM, limits: LIM });
  assertEquals(r.errors.map((e) => e.code), ["no_entries"]);
  assertEquals(r.root, null);
});

Deno.test("rejection arms: one code + offending path, no published root", () => {
  const cases: [string, string][] = [
    ["/etc/passwd", "path_absolute"],
    ["C:\\x", "path_absolute"],
    ["\\\\host\\share", "path_absolute"],
    ["a/../../b", "path_traversal"],
    ["./../x", "path_traversal"],
    ["a/../b", "path_traversal"],
    ["a/./b", "path_traversal"],
    ["a\\b", "path_backslash"],
    ["a\u0000b", "path_control_char"],
    ["a\nb", "path_control_char"],
    ["a\u007fb", "path_control_char"],
    ["a\ud800b", "path_invalid_text"],
    ["a//b", "path_empty_segment"],
    ["a/", "path_empty_segment"],
    ["a/b/c/d/e", "path_too_deep"],
    ["x".repeat(41), "path_too_long"],
  ];
  for (const [path, code] of cases) {
    const r = run([f(path)]);
    assertEquals(codes(r), [`${code}:${path}`], JSON.stringify(path));
    assertEquals(r.root, null, path);
    assertEquals(r.ok, false);
  }
});

Deno.test("traversal: percent-encoded dots are a literal name", () => {
  const r = run([f("a/%2e%2e/b")]);
  assertEquals(r.errors, []);
  assertEquals(r.root, "");
});

Deno.test("traversal is checked on the wrapper-relative path", () => {
  assertEquals(codes(run([f("w/SKILL.md"), f("w/../x")], { skill: false })), [
    "path_traversal:w/../x",
  ]);
});

Deno.test("path bytes count UTF-8 bytes, depth counts segments; exact limits pass", () => {
  assertEquals(run([f("é".repeat(20))]).errors, []); // 40 bytes
  assertEquals(codes(run([f("é".repeat(21))])), [`path_too_long:${"é".repeat(21)}`]);
  assertEquals(run([f("a/b/c/d")]).errors, []);
  // depth is measured after the wrapper strip
  assertEquals(run([f("w/SKILL.md"), f("w/a/b/c/d")], { skill: false }).errors, []);
});

Deno.test("entry kinds other than file/dir are rejected", () => {
  const kinds: [SkillEntryKind, string][] = [
    ["symlink", "entry_symlink"],
    ["hardlink", "entry_hardlink"],
    ["device", "entry_device"],
    ["other", "entry_other"],
  ];
  for (const [kind, code] of kinds) {
    const r = run([f("link", 0, kind)]);
    assertEquals(codes(r), [`${code}:link`]);
    assertEquals(r.root, null);
  }
  assertEquals(run([f("d/", 0, "dir"), f("d/x.md")]).errors, []);
});

Deno.test("collisions: NFC/NFD and case", () => {
  const nfc = "\u00e9.md";
  const nfd = "e\u0301.md";
  const a = run([f(nfc), f(nfd)]);
  assertEquals(a.errors.map((e) => e.code), ["path_duplicate", "path_duplicate"]);
  assertEquals(new Set(a.errors.map((e) => e.path)), new Set([nfc, nfd]));
  const b = run([f("Readme.md"), f("README.md")]);
  assertEquals(codes(b), ["path_duplicate:README.md", "path_duplicate:Readme.md"]);
  // exact duplicate path, and a file/dir name clash
  assertEquals(run([f("x.md"), f("x.md")]).errors.length, 2);
  assertEquals(run([f("x", 0, "dir"), f("X")]).errors.length, 2);
  // a lone NFD path is accepted (collision, not form, is the rule)
  assertEquals(run([f(nfd)]).errors, []);
});

Deno.test("credential paths are rejected by canonical segment", () => {
  const bad = [
    ".env",
    ".ENV",
    ".Env",
    ".env.local",
    ".ENV.production",
    "sub/.git/config",
    ".git/HEAD",
    ".ssh/id",
    ".aws/credentials",
    "a/.npmrc",
    ".pypirc",
    ".netrc",
    "keys/ID_RSA",
    "id_dsa",
    "id_ecdsa.pub",
    "k/id_ed25519",
    "x.PEM",
    "a/b.key",
    "c.p12",
    "d.PFX",
    ".env ",
    ".git.",
  ];
  for (const path of bad) {
    const r = run([f(path)]);
    assertEquals(codes(r), [`credential_path:${path}`], path);
    assertEquals(r.root, null);
  }
  // wrapper dir is checked too
  assertEquals(
    codes(run([f(".git/SKILL.md")], { skill: false })),
    ["credential_path:.git/SKILL.md"],
  );
  for (const ok of [".envrc", "env", ".gitignore", "id_rsa_notes.md", "my.keyring", "pem"]) {
    assertEquals(run([f(ok)]).errors, [], ok);
  }
});

Deno.test("limits: over fails, exactly at passes", () => {
  const files = (n: number) => Array.from({ length: n }, (_, i) => f(`f${i}.md`));
  assertEquals(run(files(4)).errors, []); // SKILL.md + 4 = maxFiles
  assertEquals(run(files(5)).errors.map((e) => e.code), ["too_many_files"]);
  assertEquals(run([f("a.md", 100)]).errors, []);
  assertEquals(codes(run([f("a.md", 101)])), ["file_too_large:a.md"]);
  const big = { ...LIM, maxFileBytes: 1000, maxPackageBytes: 10, maxFiles: 50 };
  assertEquals(run([f("a.md", 9)], { limits: big }).errors, []); // 1 + 9 = 10
  assertEquals(
    run([f("a.md", 10)], { limits: big }).errors.map((e) => e.code),
    ["package_too_large"],
  );
  // directory entries are not files and carry no size
  assertEquals(run([f("d/", 5000, "dir")]).errors, []);
  assertEquals(codes(run([f("a.md", -1)])), ["file_too_large:a.md"]);
  assertEquals(codes(run([f("a.md", NaN)])), ["file_too_large:a.md"]);
});

Deno.test("report is deterministic under entry shuffling", () => {
  const entries = [
    f("SKILL.md"),
    f("b/../c"),
    f("Readme.md"),
    f("README.md"),
    f(".env"),
    f("l", 0, "symlink"),
    f("z/y/x.md", 500),
    f("é.md"),
    f("e\u0301.md"),
  ];
  const base = validateSkillPackage({ entries, frontmatter: FM, limits: LIM });
  assertNotEquals(base.errors.length, 0);
  for (let k = 0; k < 20; k++) {
    const shuffled = [...entries].sort(() => Math.random() - 0.5);
    assertEquals(validateSkillPackage({ entries: shuffled, frontmatter: FM, limits: LIM }), base);
  }
});

Deno.test("module source references no Deno./fetch", async () => {
  const src = await Deno.readTextFile(new URL("../src/skill-package.ts", import.meta.url));
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assertEquals(/\bDeno\./.test(code) || /\bfetch\s*\(/.test(code), false);
});
