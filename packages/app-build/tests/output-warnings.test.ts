/**
 * Output-contract warnings: no `output`, `items` on a non-array, `sample` not matching `output`.
 * Warn only — never a failure, never in `index.json`. Fixtures are generated in temp dirs.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.0";
import { dirname, fromFileUrl, join } from "jsr:@std/path@^1.0.0";
import { buildApp, buildApps } from "../mod.ts";

const CLI = fromFileUrl(new URL("../cli.ts", import.meta.url));

const PKG = JSON.stringify({
  name: "@w6w-fixtures/demo",
  version: "1.0.0",
  description: "fixture",
  license: "MIT",
  author: { name: "w6w" },
  categories: ["developer-tools"],
  w6w: {
    id: "io.test.demo",
    displayName: "Demo",
    appearance: { icon: { url: "https://cdn.example.invalid/i.png" } },
    entry: "./index.ts",
  },
});

/** An app whose index.ts exports `actions` / `triggers` given as source text. */
async function app(actions: string, triggers = "[]", id = "io.test.demo") {
  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "w6w-outwarn-" }));
  const dir = join(tmp, "app");
  const files: Record<string, string> = {
    "package.json": PKG.replace("io.test.demo", id),
    "deno.json": "{}",
    "index.ts": `const t = (x: object) => ({ params: [], execute() { return {}; }, ...x });
export default { actions: ${actions}.map(t), triggers: ${triggers}.map((x: object) => ({ ...x })) };\n`,
  };
  for (const [rel, c] of Object.entries(files)) {
    await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), c);
  }
  return { tmp, dir, out: join(tmp, "out") };
}

const act = (key: string, extra = "") => `{ key: "${key}", title: "${key}"${extra} }`;
const trg = (key: string, extra = "") => `{ key: "${key}", title: "${key}"${extra} }`;

async function warningsOf(actions: string, triggers?: string): Promise<string[]> {
  const f = await app(actions, triggers);
  try {
    return (await buildApp(f.dir, f.out)).warnings ?? [];
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
}

Deno.test("output warnings: missing output on an action and a trigger is named; [] and {source} are not", async () => {
  const w = await warningsOf(
    `[${act("bare")}, ${act("none", ", output: []")}, ${act("dyn", ', output: { source: "x" }')}]`,
    `[${trg("tbare")}, ${trg("tnone", ", output: []")}]`,
  );
  assertEquals(w.length, 2, w.join("\n"));
  assert(w.some((x) => x.startsWith("actions[bare]") && x.includes("no output")));
  assert(w.some((x) => x.startsWith("triggers[tbare]") && x.includes("no output")));
});

Deno.test("output warnings: an app where every entry declares output has no warnings key", async () => {
  const f = await app(`[${act("a", ", output: []")}]`, `[${trg("t", ", output: []")}]`);
  try {
    const r = await buildApp(f.dir, f.out);
    assertEquals("warnings" in r, false);
    assertEquals("outputWarnings" in r, false);
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});

Deno.test("output warnings: items on a non-array warns (top level and nested); on an array does not", async () => {
  const out = `output: [
    { key: "ok", type: "array", label: "ok", items: [{ key: "id", type: "string", label: "id" }] },
    { key: "bad", type: "object", label: "bad", items: [{ key: "id", type: "string", label: "id" }] },
    { key: "deep", type: "array", label: "deep", items: [
      { key: "inner", type: "string", label: "inner", items: [] }] }]`;
  const w = await warningsOf(`[${act("a", ", " + out)}]`, `[${trg("t", ", " + out)}]`);
  assertEquals(w.length, 4, w.join("\n"));
  assert(w.some((x) => x.startsWith("actions[a]") && x.includes('"bad"')));
  assert(w.some((x) => x.startsWith("actions[a]") && x.includes('"deep[].inner"')));
  assert(w.some((x) => x.startsWith("triggers[t]") && x.includes('"bad"')));
  assert(!w.some((x) => x.includes('"ok"')));
});

const SAMPLE_OUT = `output: [
  { key: "id", type: "string", label: "id" },
  { key: "venue.name", type: "string", label: "n" },
  { key: "rows", type: "array", label: "rows", items: [{ key: "n", type: "number", label: "n" }] }]`;

Deno.test("output warnings: sample missing a key or mismatching a type warns once per entry", async () => {
  const w = await warningsOf(
    `[${act("miss", `, ${SAMPLE_OUT}, sample: { id: "1", rows: [{ n: 1 }] }`)},
      ${act("type", `, ${SAMPLE_OUT}, sample: { id: 1, venue: { name: "v" }, rows: [{ n: 1 }] }`)},
      ${
      act("inner", `, ${SAMPLE_OUT}, sample: { id: "1", venue: { name: "v" }, rows: [{ n: "x" }] }`)
    }]`,
    `[${trg("tmiss", `, ${SAMPLE_OUT}, sample: { venue: { name: "v" }, rows: [] }`)}]`,
  );
  assertEquals(w.length, 4, w.join("\n"));
  assert(w.some((x) => x.startsWith("actions[miss]") && x.includes("missing venue")), w.join("\n"));
  assert(w.some((x) => x.startsWith("actions[type]") && x.includes("id (declared string")));
  assert(w.some((x) => x.startsWith("actions[inner]") && x.includes("rows.0.n")));
  assert(w.some((x) => x.startsWith("triggers[tmiss]") && x.includes("missing id")));
});

Deno.test("output warnings: extra sample keys, a matching sample and no sample do not warn", async () => {
  const w = await warningsOf(
    `[${
      act(
        "extra",
        `, ${SAMPLE_OUT}, sample: { id: "1", more: 1, venue: { name: "v", x: 1 }, rows: [{ n: 1, y: 2 }] }`,
      )
    },
      ${
      act("same", `, ${SAMPLE_OUT}, sample: { id: "1", venue: { name: "v" }, rows: [{ n: 1 }] }`)
    },
      ${act("nosample", `, ${SAMPLE_OUT}`)}]`,
  );
  assertEquals(w, []);
});

Deno.test("output warnings: index.json carries no warnings and is byte-identical across out dirs", async () => {
  const f = await app(`[${act("a")}, ${act("b")}]`, `[${trg("t")}]`);
  try {
    const r1 = await buildApps([{ path: "app", appDir: f.dir }], join(f.tmp, "o1"));
    await buildApps([{ path: "app", appDir: f.dir }], join(f.tmp, "o2"));
    assert(r1.built[0].result.warnings !== undefined);
    const a = await Deno.readTextFile(join(f.tmp, "o1", "index.json"));
    const b = await Deno.readTextFile(join(f.tmp, "o2", "index.json"));
    assertEquals(a, b);
    assert(!a.toLowerCase().includes("warning"));
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});

async function cli(args: string[]) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", CLI, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const td = new TextDecoder();
  return { code: out.code, stdout: td.decode(out.stdout), stderr: td.decode(out.stderr) };
}

Deno.test("cli: one stderr line per app with warnings (counts as digits), exit 0, stdout unchanged", async () => {
  const f = await app(
    `[${act("a")}, ${act("b")}, ${act("c")}, ${act("s", `, ${SAMPLE_OUT}, sample: { id: "1" }`)}]`,
    `[${trg("t1")}, ${trg("t2")}]`,
  );
  try {
    const r = await cli([f.dir, "-o", f.out]);
    assertEquals(r.code, 0, r.stderr);
    assertStringIncludes(r.stdout, "built 1/1");
    const lines = r.stderr.split("\n").filter((l) => l.trim() !== "");
    assertEquals(lines.length, 1, r.stderr);
    assertStringIncludes(lines[0], f.dir);
    assertStringIncludes(lines[0], "3 actions and 2 triggers without output");
    assertStringIncludes(lines[0], "1 samples not matching");
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});

Deno.test("cli: --pack prints one line per warning app and none for a clean app", async () => {
  const bad = await app(`[${act("a")}, ${act("b")}]`);
  const good = await app(`[${act("a", ", output: []")}]`, "[]", "io.test.good");
  try {
    const pack = join(bad.tmp, "w6w-pack.json");
    await Deno.writeTextFile(
      pack,
      JSON.stringify({ apps: [bad.dir, good.dir].map((p) => ({ path: p })) }),
    );
    const r = await cli(["--pack", pack, "-o", join(bad.tmp, "po")]);
    const lines = r.stderr.split("\n").filter((l) => l.trim() !== "");
    assertEquals(r.code, 0, r.stderr);
    assertEquals(lines.length, 1, r.stderr);
    assertStringIncludes(lines[0], "2 actions and 0 triggers without output");
  } finally {
    await Deno.remove(bad.tmp, { recursive: true });
    await Deno.remove(good.tmp, { recursive: true });
  }
});

Deno.test("cli: an app without warnings prints nothing on stderr", async () => {
  const f = await app(`[${act("a", ", output: []")}]`);
  try {
    const r = await cli([f.dir, "-o", f.out]);
    assertEquals(r.code, 0);
    assertEquals(r.stderr, "");
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});
