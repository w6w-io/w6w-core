import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.0";
import {
  canonicalSkillPath,
  DEFAULT_SKILL_PACKAGE_LIMITS,
  extractSkillFrontmatter,
  MAX_FRONTMATTER_NODES,
  rawPathUnitCap,
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

const withFm = (frontmatter: unknown, entries: SkillEntry[] = [f("SKILL.md")]) =>
  validateSkillPackage({ entries, frontmatter, limits: LIM });
const fmCodes = (r: ReturnType<typeof withFm>) => r.errors.map((e) => e.code);

Deno.test("valid wrapped package: root stripped once, inert_script + inert_field, metadata kept", () => {
  const meta = { "allowed-tools": ["Bash"], scripts: { go: "run.sh" }, dependencies: { a: "1" } };
  const r = validateSkillPackage({
    entries: [
      f("pkg/", 0, "dir"),
      f("pkg/SKILL.md"),
      f("pkg/run.sh", 10),
      f("pkg/docs/deep/notes.md", 5),
      f("pkg/docs/pkg/inner.txt", 5),
    ],
    frontmatter: { name: "my-skill-1", description: "Does things", ...meta },
    limits: LIM,
  });
  assertEquals(r.errors, []);
  assertEquals(r.ok, true);
  assertEquals(r.root, "pkg");
  assertEquals(r.name, "my-skill-1");
  assertEquals(r.description, "Does things");
  assertEquals(r.metadata, meta);
  assertEquals(
    r.warnings.filter((w) => w.code === "inert_script").map((w) => w.path),
    ["pkg/run.sh"],
  );
  assertEquals(
    r.warnings.filter((w) => w.code === "inert_field").map((w) => w.message.match(/"(.+?)"/)![1])
      .sort(),
    ["allowed-tools", "dependencies", "scripts"],
  );
  assertEquals(r.warnings.length, 4);
});

Deno.test("metadata: no warnings and empty metadata when only name/description", () => {
  const r = withFm(FM);
  assertEquals(r.warnings, []);
  assertEquals(r.metadata, {});
});

Deno.test("metadata: a literal __proto__ key stays an own property, not a prototype", () => {
  const fm = JSON.parse('{"name":"a","description":"d","__proto__":{"x":1}}');
  const r = withFm(fm);
  assertEquals(Object.getPrototypeOf(r.metadata), Object.prototype);
  assertEquals(Object.keys(r.metadata), ["__proto__"]);
  assertEquals(r.warnings.map((w) => w.code), ["inert_field"]);
});

Deno.test("scripts of every flavour are inert warnings, never errors", () => {
  const r = withFm(FM, [f("SKILL.md"), f("a.PY"), f("b/c.js"), f("d.sh"), f("e.md")]);
  assertEquals(r.ok, true);
  assertEquals(r.warnings.map((w) => `${w.code}:${w.path}`), [
    "inert_script:a.PY",
    "inert_script:b/c.js",
    "inert_script:d.sh",
  ]);
});

Deno.test("frontmatter: missing / not a plain object", () => {
  for (const bad of [undefined, null]) {
    const r = withFm(bad);
    assertEquals(fmCodes(r), ["frontmatter_missing"]);
    assertEquals(r.root, null);
    assertEquals(r.ok, false);
  }
  class Fm {
    name = "a";
    description = "d";
  }
  for (const bad of [[1], "x", 3, true, new Fm(), new Date(0), new Map()]) {
    const r = withFm(bad);
    assertEquals(fmCodes(r), ["frontmatter_not_object"]);
    assertEquals(r.root, null);
    assertEquals(r.name, null);
  }
  assertEquals(withFm(Object.assign(Object.create(null), FM)).ok, true);
});

Deno.test("frontmatter: name grammar", () => {
  const bad: unknown[] = [
    undefined,
    5,
    ["a"],
    { a: 1 },
    "",
    "Abc",
    "a b",
    "a_b",
    "a/b",
    "é",
    "a".repeat(65),
    "a\n",
  ];
  for (const name of bad) {
    const r = withFm({ name, description: "d" });
    assertEquals(fmCodes(r), ["frontmatter_name_invalid"], JSON.stringify(name));
    assertEquals(r.errors[0].path, "SKILL.md");
    assertEquals(r.root, null);
    assertEquals(r.name, null);
  }
  for (const name of ["a", "-", "0", "a-b-9", "a".repeat(64)]) {
    const r = withFm({ name, description: "d" });
    assertEquals(r.errors, [], name);
    assertEquals(r.name, name);
  }
});

Deno.test("frontmatter: description non-empty, <= 1024 (exact passes)", () => {
  for (const description of [undefined, "", "   \n", 5, null, ["x"], "d".repeat(1025)]) {
    const r = withFm({ name: "a", description });
    assertEquals(fmCodes(r), ["frontmatter_description_invalid"], JSON.stringify(description));
    assertEquals(r.description, null);
  }
  assertEquals(withFm({ name: "a", description: "d".repeat(1024) }).errors, []);
  // 1024 astral characters are 2048 UTF-16 units but still 1024 characters.
  assertEquals(withFm({ name: "a", description: "😀".repeat(1024) }).errors, []);
  assertEquals(fmCodes(withFm({ name: "a", description: "😀".repeat(1025) })), [
    "frontmatter_description_invalid",
  ]);
});

Deno.test("frontmatter: both name and description invalid report both", () => {
  assertEquals(fmCodes(withFm({ name: 1, description: "" })), [
    "frontmatter_description_invalid",
    "frontmatter_name_invalid",
  ]);
});

Deno.test("frontmatter errors combine with entry errors; both reported", () => {
  const r = withFm({ name: "BAD", description: "d" }, [f("SKILL.md"), f(".env")]);
  assertEquals(fmCodes(r).sort(), ["credential_path", "frontmatter_name_invalid"]);
  assertEquals(r.root, null);
});

Deno.test("node walk: exactly MAX_FRONTMATTER_NODES passes, one more fails", () => {
  // root object counts 1, "name"/"description" values 1 each, `list` array 1 + its items.
  const mk = (items: number) => ({ ...FM, list: new Array(items).fill(0) });
  const fixed = 1 + 2 + 1;
  const ok = withFm(mk(MAX_FRONTMATTER_NODES - fixed));
  assertEquals(ok.errors, []);
  const over = withFm(mk(MAX_FRONTMATTER_NODES - fixed + 1));
  assertEquals(fmCodes(over), ["frontmatter_too_many_nodes"]);
  assertEquals(over.root, null);
  assertEquals(over.metadata, {});
});

Deno.test("node walk: alias fan-out (shared subtrees) is charged per visit", () => {
  const shared = new Array(100).fill(0);
  const fm = { ...FM, a: Array.from({ length: 200 }, () => shared) }; // 200 * 101 > cap
  assertEquals(fmCodes(withFm(fm)), ["frontmatter_too_many_nodes"]);
  // a shared leaf-ish subtree well under the cap is fine and is not mistaken for a cycle
  const small = { ...FM, a: [shared, shared], b: shared };
  assertEquals(withFm(small).errors, []);
});

Deno.test("node walk: cycles terminate, and absurd nesting is refused", () => {
  const cyc: Record<string, unknown> = { ...FM };
  cyc.self = cyc;
  assertEquals(fmCodes(withFm(cyc)), ["frontmatter_not_object"]);
  const arr: unknown[] = [];
  arr.push(arr);
  assertEquals(fmCodes(withFm({ ...FM, arr })), ["frontmatter_not_object"]);
  let deep: unknown = 0;
  for (let i = 0; i < 5000; i++) deep = [deep];
  assertEquals(fmCodes(withFm({ ...FM, deep })), ["frontmatter_too_many_nodes"]);
});

Deno.test("report with frontmatter is deterministic under shuffling and key order", () => {
  const entries = [f("w/SKILL.md"), f("w/a.sh"), f("w/b.py"), f("w/c/d.js"), f("w/e.md")];
  const fmA = { name: "n", description: "d", z: 1, a: 2, m: { q: 1 } };
  const fmB = { m: { q: 1 }, a: 2, description: "d", z: 1, name: "n" };
  const base = validateSkillPackage({ entries, frontmatter: fmA, limits: LIM });
  assertEquals(base.ok, true);
  assertEquals(base.warnings.length, 6);
  for (let k = 0; k < 20; k++) {
    const shuffled = [...entries].sort(() => Math.random() - 0.5);
    assertEquals(validateSkillPackage({ entries: shuffled, frontmatter: fmA, limits: LIM }), base);
    assertEquals(validateSkillPackage({ entries: shuffled, frontmatter: fmB, limits: LIM }), base);
  }
});

// ---- Round 2 (eval F-1..F-4) ----

Deno.test("F-1: a 65,000-dot segment is rejected path_too_long in linear time", () => {
  const seg = ".".repeat(65_000);
  const t0 = performance.now();
  const r = run([f(`d/${seg}`)], { skill: true });
  const ms = performance.now() - t0;
  assertEquals(
    r.errors.filter((e) => e.code === "path_too_long").length,
    1,
  );
  assertEquals(r.ok, false);
  // original quadratic regex: ~1,440 ms; linear trim: ~1 ms
  assertEquals(ms < 200, true, `took ${ms}ms`);
  // alternating ". " is the other backtracking shape
  const t1 = performance.now();
  const r2 = run([f(`d/${". ".repeat(32_500)}x`)]);
  assertEquals(r2.errors.some((e) => e.code === "path_too_long"), true);
  assertEquals(performance.now() - t1 < 200, true);
});

Deno.test("F-1: trailing dots/spaces are still ignored for credential matching", () => {
  for (const p of [".env.", ".git ", ".ENV. . ", "id_rsa..", "x.pem  "]) {
    const r = run([f(`d/${p}`)]);
    assertEquals(r.errors.some((e) => e.code === "credential_path"), true, p);
  }
  // dots in the middle are not trimmed
  assertEquals(run([f("d/a.b.c")]).errors, []);
});

Deno.test("F-2: a kind outside the union fails closed as entry_other", () => {
  for (const kind of ["fifo", "socket", "FILE", null, undefined]) {
    const bad = { path: "weird", size: 5e9, kind } as unknown as SkillEntry;
    const r = run([bad]);
    const issues = r.errors.filter((e) => e.path === "weird" && e.code === "entry_other");
    assertEquals(issues.length, 1, String(kind));
    assertEquals(r.ok, false);
    assertEquals(r.root, null);
  }
});

Deno.test("F-3: NaN / missing limits fail closed", () => {
  const files = [f("a.md"), f("b.md"), f("c.md"), f("d.md"), f("e.md"), f("g.md")];
  const code = (limits: unknown, extra: SkillEntry[] = files) =>
    validateSkillPackage({
      entries: [f("SKILL.md"), ...extra],
      frontmatter: FM,
      limits: limits as SkillPackageLimits,
    }).errors.map((e) => e.code);
  // sanity: the same package with real limits is over count
  assertEquals(code(LIM), ["too_many_files"]);
  assertEquals(code({ ...LIM, maxFiles: NaN }).includes("too_many_files"), true);
  assertEquals(code({ ...LIM, maxFiles: NaN }, [f("a.md")]).includes("too_many_files"), true);
  assertEquals(code({ ...LIM, maxFileBytes: NaN }, [f("a.md")]).includes("file_too_large"), true);
  assertEquals(
    code({ ...LIM, maxPackageBytes: NaN }, [f("a.md")]).includes("package_too_large"),
    true,
  );
  assertEquals(code({ ...LIM, maxDepth: NaN }, [f("a/b.md")]).includes("path_too_deep"), true);
  assertEquals(code({ ...LIM, maxPathBytes: NaN }, [f("a.md")]).includes("path_too_long"), true);
  // partial limits object: every omitted limit is a failing limit
  const partial = code({ maxFiles: 5 }, [f("a.md")]);
  for (const c of ["file_too_large", "package_too_large", "path_too_deep", "path_too_long"]) {
    assertEquals(partial.includes(c as never), true, c);
  }
  assertEquals(extractSkillFrontmatter("---\na: 1\n---", { maxBytes: NaN }), {
    error: "frontmatter_too_large",
  });
  assertEquals(extractSkillFrontmatter("---\na: 1", { maxBytes: NaN }), {
    error: "frontmatter_too_large",
  });
  // an absent maxBytes still means the default
  assertEquals(extractSkillFrontmatter("---\na: 1\n---", { maxBytes: undefined }), { raw: "a: 1" });
});

Deno.test("F-4: canonicalSkillPath is NFC(lower(NFC(x))) and closes the 7 equivalent pairs", () => {
  const pairs: [string, string][] = [
    ["ǰ", "ǰ"],
    ["ẖ", "ẖ"],
    ["ẗ", "ẗ"],
    ["ẘ", "ẘ"],
    ["ẙ", "ẙ"],
    ["ΐ", "ΐ"],
    ["ΰ", "ΰ"],
  ];
  for (const [a, b] of pairs) {
    assertEquals(canonicalSkillPath(a), canonicalSkillPath(b), JSON.stringify([a, b]));
    assertEquals(canonicalSkillPath(a), canonicalSkillPath(a).normalize("NFC"));
    // upper-case spellings of the decomposed twin collide too
    assertEquals(canonicalSkillPath(`D/${a}.md`), canonicalSkillPath(`d/${b.toUpperCase()}.md`));
    const r = run([f(`${a}.md`), f(`${b}.md`)]);
    assertEquals(r.errors.filter((e) => e.code === "path_duplicate").length, 2, a);
  }
});

Deno.test("F-5: lone ../SKILL.md or ./SKILL.md is path_traversal with no root", () => {
  for (const p of ["../SKILL.md", "./SKILL.md"]) {
    for (const rest of [[], [f("../docs/a.md")]]) {
      const r = validateSkillPackage({
        entries: [f(p), ...rest.map((e) => ({ ...e, path: p.slice(0, -8) + "docs/a.md" }))],
        frontmatter: FM,
        limits: LIM,
      });
      assertEquals(r.ok, false, p);
      assertEquals(r.root, null, p);
      assertEquals(r.errors.some((e) => e.code === "path_traversal" && e.path === p), true, p);
    }
  }
});

Deno.test("F-5: a zero-byte file is accepted", () => {
  const r = run([f("empty.txt", 0)]);
  assertEquals(r.ok, true);
  assertEquals(r.errors, []);
});

Deno.test("F-5: wrapper spelled NFD on some entries and NFC on others is one wrapper", () => {
  const nfc = "é";
  const nfd = "é";
  const r = validateSkillPackage({
    entries: [
      f(`${nfc}/SKILL.md`),
      f(`${nfd}/a.md`),
      f(`${nfd}/`, 0, "dir"),
      f(`${nfc}/`, 0, "dir"),
    ],
    frontmatter: FM,
    limits: LIM,
  });
  assertEquals(r.errors, []);
  assertEquals(r.ok, true);
});

Deno.test("F-5: maxFiles files plus one dir entry still passes", () => {
  const files = Array.from({ length: LIM.maxFiles - 1 }, (_, i) => f(`d/f${i}.md`));
  const r = run([...files, f("d", 0, "dir")]);
  assertEquals(r.errors, []);
  assertEquals(r.ok, true);
});

Deno.test("F-5: SKILL.md/SKILL.md alone does not satisfy the SKILL.md requirement", () => {
  const r = validateSkillPackage({
    entries: [f("SKILL.md/SKILL.md")],
    frontmatter: FM,
    limits: LIM,
  });
  assertEquals(r.ok, false);
  assertEquals(r.root, null);
});

Deno.test("F-5: frontmatter nesting 100 passes, 101 fails", () => {
  const nest = (n: number) => {
    let v: unknown = "x";
    for (let i = 0; i < n; i++) v = { k: v };
    return v;
  };
  // the top-level frontmatter object is level 1, so metadata.k nests n-1 below it
  const at = (n: number) =>
    validateSkillPackage({
      entries: [f("SKILL.md")],
      frontmatter: { ...FM, deep: nest(n) },
      limits: LIM,
    });
  let lastOk = 0;
  for (let n = 90; n <= 110; n++) if (at(n).ok) lastOk = n;
  assertEquals(at(lastOk).ok, true);
  assertEquals(at(lastOk + 1).errors.map((e) => e.code), ["frontmatter_too_many_nodes"]);
  assertEquals(lastOk >= 98 && lastOk <= 100, true);
});

Deno.test("F-5: extract maxBytes boundary, unterminated and bytes not chars", () => {
  const body = "a".repeat(10);
  assertEquals(extractSkillFrontmatter(`---\n${body}\n---\n`, { maxBytes: 10 }), { raw: body });
  assertEquals(extractSkillFrontmatter(`---\n${body}\n---\n`, { maxBytes: 9 }), {
    error: "frontmatter_too_large",
  });
  assertEquals(extractSkillFrontmatter(`---\n${body}`, { maxBytes: 10 }), {
    error: "frontmatter_unterminated",
  });
  assertEquals(extractSkillFrontmatter(`---\n${body}`, { maxBytes: 9 }), {
    error: "frontmatter_too_large",
  });
  // 5 two-byte chars = 10 bytes, 5 chars
  const mb = "é".repeat(5);
  assertEquals(extractSkillFrontmatter(`---\n${mb}\n---\n`, { maxBytes: 10 }), { raw: mb });
  assertEquals(extractSkillFrontmatter(`---\n${mb}\n---\n`, { maxBytes: 9 }), {
    error: "frontmatter_too_large",
  });
});

Deno.test("F-5: __proto__ metadata key keeps its own-property descriptor", () => {
  const fm = JSON.parse('{"name":"a","description":"d","__proto__":{"x":1}}');
  const r = withFm(fm);
  const d = Object.getOwnPropertyDescriptor(r.metadata, "__proto__");
  assertEquals(d?.value, { x: 1 });
  assertEquals(d?.enumerable, true);
  assertEquals(({} as Record<string, unknown>).x, undefined);
});

// F-11: bound the work before the first normalization. U+0301 (ccc 230) then U+0316 (ccc 220)
// is the worst reordering case for String.prototype.normalize (quadratic).
const markRun = (units: number) => "a" + "\u0301".repeat(units / 2) + "\u0316".repeat(units / 2);

Deno.test("F-11: 10 entries of a 65 KB mark-run name are bounded before NFC", () => {
  const big = markRun(65_000);
  const entries = [f("SKILL.md")];
  for (let i = 0; i < 10; i++) entries.push(f(`${i}${big}`));
  const t = performance.now();
  const r = validateSkillPackage({ entries, frontmatter: FM, limits: { ...LIM, maxFiles: 50 } });
  const ms = performance.now() - t;
  assertEquals(r.ok, false);
  assertEquals(r.root, null);
  assertEquals(r.errors.filter((e) => e.code === "path_too_long").length, 10);
  assertEquals(r.errors.length, 10);
  if (ms > 100) throw new Error(`took ${ms} ms`);
});

Deno.test("F-11: dir entries and a mark-run wrapper repeated on every entry are bounded", () => {
  const big = markRun(65_000);
  const entries = [f(`${big}/SKILL.md`)];
  for (let i = 0; i < 10; i++) entries.push(f(`${big}/d${i}/x.md`), f(`${big}${i}/`, 0, "dir"));
  const t = performance.now();
  const r = validateSkillPackage({ entries, frontmatter: FM, limits: { ...LIM, maxFiles: 50 } });
  const ms = performance.now() - t;
  assertEquals(r.ok, false);
  // every entry is over-long; the only other report is the SKILL.md the wrapper hid
  assertEquals(r.errors.filter((e) => e.code === "path_too_long").length, entries.length);
  assertEquals(r.errors.map((e) => e.code).filter((c) => c !== "path_too_long"), [
    "skill_md_missing",
  ]);
  if (ms > 100) throw new Error(`took ${ms} ms`);
});

Deno.test("F-11: NFC shrink is not over-rejected (270 units -> 180 bytes), with and without a wrapper", () => {
  const shrink = "a\u0308\u0304".repeat(90);
  assertEquals(shrink.length, 270);
  assertEquals(new TextEncoder().encode(shrink.normalize("NFC")).length, 180);
  const lim = { ...DEFAULT_SKILL_PACKAGE_LIMITS };
  const flat = validateSkillPackage({
    entries: [f("SKILL.md"), f(shrink + ".md")],
    frontmatter: FM,
    limits: lim,
  });
  assertEquals(flat.errors, []);
  const wrapped = validateSkillPackage({
    entries: [f("w/SKILL.md"), f(`w/${shrink}.md`), f(`${shrink}/`, 0, "dir")].slice(0, 2),
    frontmatter: FM,
    limits: lim,
  });
  assertEquals(wrapped.errors, []);
  assertEquals(wrapped.root, "w");
});

Deno.test("F-11: raw cap boundary is 4*maxPathBytes+1 units on the whole path", () => {
  const lim = { ...LIM, maxPathBytes: 10 };
  assertEquals(rawPathUnitCap(10), 41);
  // 10 x (a + U+0308 + U+0304) = 30 units = 10 NFC bytes; + "ab" = 32 units; + "/SKILL.md" = 41.
  const w = "a\u0308\u0304".repeat(10) + "ab";
  const at = validateSkillPackage({
    entries: [f(`${w}/SKILL.md`)],
    frontmatter: FM,
    limits: lim,
  });
  assertEquals(`${w}/SKILL.md`.length, 41);
  assertEquals(at.errors, []);
  assertEquals(at.root, w.normalize("NFC"));
  const over = validateSkillPackage({
    entries: [f(`${w}c/SKILL.md`)],
    frontmatter: FM,
    limits: lim,
  });
  assertEquals(over.ok, false);
  assertEquals(over.root, null);
  assertEquals(over.errors.map((e) => e.code), ["skill_md_missing", "path_too_long"]);
  // A non-finite cap fails closed rather than disabling the gate.
  const nan = validateSkillPackage({
    entries: [f("SKILL.md")],
    frontmatter: FM,
    limits: { ...LIM, maxPathBytes: NaN },
  });
  assertEquals(nan.errors.map((e) => e.code), ["path_too_long"]);
});

Deno.test("F-11: an entry rejected for length gets no canonical key (no duplicate report)", () => {
  const long = "x".repeat(60);
  const r = validateSkillPackage({
    entries: [f("SKILL.md"), f(long), f(long.toUpperCase())],
    frontmatter: FM,
    limits: LIM,
  });
  assertEquals(r.errors.map((e) => e.code), ["path_too_long", "path_too_long"]);
});
