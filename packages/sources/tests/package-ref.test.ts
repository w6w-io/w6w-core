import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  assertNoDependencies,
  assertNoNodeModules,
  assertNoPackageImports,
  assertSafeEntryPath,
  packageKey,
  parsePackageRef,
  selectVersion,
} from "../src/package-ref.ts";
import { SourceError } from "../src/types.ts";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as SourceError).code;
  }
  return "none";
};

Deno.test("parse: scoped/unscoped, range, #id", () => {
  assertEquals(parsePackageRef("npm:foo"), { registry: "npm", name: "foo" });
  assertEquals(parsePackageRef("npm:@a/b@^1.2#my-app"), {
    registry: "npm",
    name: "@a/b",
    range: "^1.2",
    appId: "my-app",
  });
  assertEquals(parsePackageRef("jsr:@w6w/x@1.0.0").range, "1.0.0");
  assertEquals(packageKey(parsePackageRef("jsr:@w6w/x@1#a")), "jsr:@w6w/x");
});

Deno.test("parse: invalid names are bad_ref", () => {
  for (
    const r of [
      "npm:",
      "npm:Foo",
      "npm:_x",
      "npm:.x",
      "npm:@a/.b",
      "npm:a/b",
      "npm:@a",
      "npm:@a/b/c",
      "npm:a%20b",
      "npm:" + "a".repeat(215),
      "jsr:foo",
      "npm:foo#",
      "npm:foo@",
      "gh:foo",
    ]
  ) assertEquals(code(() => parsePackageRef(r)), "bad_ref", r);
  parsePackageRef("npm:" + "a".repeat(214));
});

const V = { "1.0.0": {}, "1.2.0": { deprecated: "old" }, "1.3.0-beta.1": {}, "2.0.0": {} };

Deno.test("select: npm latest tag, ranges, prerelease, deprecated", () => {
  const tags = { latest: "1.2.0", next: "2.0.0" };
  assertEquals(selectVersion("npm", V, undefined, tags), "1.2.0");
  assertEquals(selectVersion("npm", V, "next", tags), "2.0.0");
  assertEquals(selectVersion("npm", V, "^1", tags), "1.2.0");
  assertEquals(selectVersion("npm", V, "1.0.0", tags), "1.0.0");
  assertEquals(selectVersion("npm", V, "^1.3.0-beta.0", tags), "1.3.0-beta.1");
  assertEquals(code(() => selectVersion("npm", V, "^3", tags)), "not_found");
  assertEquals(code(() => selectVersion("npm", V)), "not_found");
});

Deno.test("select: jsr highest non-yanked stable, never yanked", () => {
  const v = { "1.0.0": {}, "1.1.0": {}, "1.2.0": { yanked: true }, "2.0.0-rc.1": {} };
  assertEquals(selectVersion("jsr", v), "1.1.0");
  assertEquals(selectVersion("jsr", v, "^1"), "1.1.0");
  assertEquals(code(() => selectVersion("jsr", v, "1.2.0")), "not_found");
  assertEquals(selectVersion("jsr", v, "2.0.0-rc.1"), "2.0.0-rc.1");
  assertEquals(selectVersion("jsr", ["1.0.0", "1.0.1"]), "1.0.1");
});

Deno.test("dependency policy: six fields, even empty", () => {
  for (
    const f of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
      "bundledDependencies",
      "bundleDependencies",
    ]
  ) {
    assertEquals(code(() => assertNoDependencies({ [f]: {} })), "npm_dependencies_forbidden", f);
  }
  assertNoDependencies({ name: "x", scripts: {} });
  assertEquals(
    code(() => assertNoPackageImports({ imports: { a: "npm:x@1" } })),
    "npm_dependencies_forbidden",
  );
  assertEquals(
    code(() => assertNoPackageImports({ imports: { a: "jsr:@s/x" } })),
    "npm_dependencies_forbidden",
  );
  assertNoPackageImports({ imports: { a: "./a.ts" } });
  assertNoPackageImports({});
  assertEquals(
    code(() => assertNoNodeModules("w6w/node_modules/x/a.js")),
    "npm_dependencies_forbidden",
  );
  assertNoNodeModules("w6w/node_modules_x/a.js");
});

Deno.test("entry path: rooted key stripped once; unsafe refused", () => {
  assertEquals(assertSafeEntryPath("/w6w/a/app.js"), "w6w/a/app.js");
  assertEquals(assertSafeEntryPath("w6w/a.js"), "w6w/a.js");
  for (
    const p of [
      "",
      "/",
      "//w6w/a",
      "/w6w/../x",
      "/w6w/%2e%2e/x",
      "/w6w/%2E/x",
      "/w6w%2fa",
      "/w6w%5ca",
      "/w6w\\a",
      "/w6w//a",
      "/w6w/./a",
      "C:/x",
      "/w6w/a\0b",
    ]
  ) assertEquals(code(() => assertSafeEntryPath(p)), "unsafe_entry", JSON.stringify(p));
  assertThrows(() => assertSafeEntryPath("/a/../b"), SourceError);
});

Deno.test("A3: selectVersion uses own-property lookup (toString/constructor are not versions; invalid range -> bad_ref)", () => {
  const info = { "1.0.0": {} };
  for (const r of ["toString", "constructor", "hasOwnProperty"]) {
    assertEquals(code(() => selectVersion("npm", info, r, { latest: "1.0.0" })), "bad_ref", r);
    assertEquals(code(() => selectVersion("jsr", info, r)), "bad_ref", r);
  }
  assertEquals(
    code(() => selectVersion("npm", info, undefined, { latest: "toString" })),
    "not_found",
  );
});
