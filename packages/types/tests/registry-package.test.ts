import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import {
  assertSafeEntryPath,
  parseRegistryPackageIndex,
  RegistryPackageError,
} from "../src/registry-package.ts";

const HEX = "a".repeat(64);
// Real shape written by app-build pack mode (pack.ts: id, version, execSha256, digest,
// digestVersion, sourceDigest; failures empty on success).
const app = (over: Record<string, unknown> = {}) => ({
  id: "demo",
  version: "1.2.3",
  execSha256: HEX,
  digest: "b".repeat(64),
  digestVersion: 2,
  sourceDigest: "c".repeat(64),
  ...over,
});
const idx = (apps: unknown[], failures: unknown[] = []) => ({ apps, failures });

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof RegistryPackageError) return e.code;
    throw e;
  }
  return "none";
}

Deno.test("real app-build index shape is accepted", () => {
  const raw = idx([app(), app({ id: "other", digestVersion: 1 })]);
  assertEquals(parseRegistryPackageIndex(raw), raw);
});

Deno.test("refuses nonempty failures", () => {
  const f = [{ path: "a", code: "unexpected", message: "x" }];
  assertEquals(code(() => parseRegistryPackageIndex(idx([app()], f))), "build_failures");
});

Deno.test("refuses duplicate id", () => {
  assertEquals(
    code(() => parseRegistryPackageIndex(idx([app(), app({ version: "2.0.0" })]))),
    "duplicate_id",
  );
});

Deno.test("refuses non-hex64 execSha256", () => {
  for (const bad of ["abc", "A".repeat(64), "g".repeat(64), HEX + "a", 5]) {
    assertEquals(
      code(() => parseRegistryPackageIndex(idx([app({ execSha256: bad })]))),
      "invalid_index",
    );
  }
});

Deno.test("refuses id/version with slash, backslash or ..", () => {
  for (const bad of ["a/b", "a\\b", "..", "a..b/c", "../x"]) {
    assertEquals(
      code(() => parseRegistryPackageIndex(idx([app({ id: bad })]))) !== "none",
      true,
      `id ${bad}`,
    );
    assertEquals(
      code(() => parseRegistryPackageIndex(idx([app({ version: bad })]))) !== "none",
      true,
      `version ${bad}`,
    );
  }
});

Deno.test("refuses empty and absolute segments", () => {
  for (const bad of ["", "/abs", "a//b", "a/", "."]) {
    assertThrows(() => assertSafeEntryPath(bad), RegistryPackageError);
    assertThrows(() => parseRegistryPackageIndex(idx([app({ id: bad })])), RegistryPackageError);
  }
  assertEquals(assertSafeEntryPath("a/b.js"), "a/b.js");
});
