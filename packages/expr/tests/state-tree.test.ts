import { assert, assertEquals, assertFalse, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { isSecretValue } from "@w6w/types";
import {
  applyStateOp,
  computeStateWrites,
  effectiveStateConfig,
  foldState,
  foldStateLog,
  parseStatePath,
  STATE_FORBIDDEN_KEYS,
  STATE_LIMITS,
  STATE_RESERVED_TOP_KEYS,
  STATE_SECRET_MASK,
  type StateLogRow,
  statePathsOverlap,
  type StateTree,
  type StateWriteConfig,
  type StateWriteOp,
  staticWritePaths,
  validateInitialState,
  validateStateConfig,
} from "../mod.ts";

const W = (path: string[], value: unknown): StateWriteOp => ({ kind: "write", path, value });
const A = (path: string[], value: unknown): StateWriteOp => ({ kind: "append", path, value });
const ap = (t: StateTree, op: StateWriteOp) => applyStateOp(t, op);
const secret = { type: "secret", ciphertext: "c", iv: "i" };

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}
/** Built iteratively so the test itself cannot overflow the stack. */
function nested(depth: number): unknown {
  let v: unknown = "leaf";
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
}

// --- A1..A7, A18: merge semantics ------------------------------------------------------------

Deno.test("[A1] intake example: root merge overwrites, key mode nests", () => {
  const a = ap({ foo: "foofoo" }, W([], { foo: "bar" }));
  assertEquals(a.tree, { foo: "bar" });
  const b = ap({ foo: "foofoo" }, W(["node-2"], { foo: "bar" }));
  assertEquals(b.tree, { foo: "foofoo", "node-2": { foo: "bar" } });
});
Deno.test("[A1] compute -> fold: root then key, end to end", () => {
  const root = computeStateWrites({ mode: "root" }, { foo: "bar" });
  const key = computeStateWrites({ mode: "key", key: "node-2" }, { foo: "bar" });
  assertEquals(foldState({ foo: "foofoo" }, root.ops), { foo: "bar" });
  assertEquals(foldState({ foo: "foofoo" }, key.ops), { foo: "foofoo", "node-2": { foo: "bar" } });
});
Deno.test("[A2] merge is one level deep: a nested object is replaced whole", () => {
  const r = ap({ a: { x: 1, y: 2 }, b: 1 }, W([], { a: { z: 3 } }));
  assertEquals(r.tree, { a: { z: 3 }, b: 1 });
  const r2 = ap({ o: { a: { x: 1, y: 2 }, k: 1 } }, W(["o"], { a: { z: 3 } }));
  assertEquals(r2.tree, { o: { a: { z: 3 }, k: 1 } });
});
Deno.test("[A3] null: a merge key is deleted, a null write deletes the path, null at root refused", () => {
  assertEquals(ap({ a: 1, b: 2 }, W([], { a: null })).tree, { b: 2 });
  assertEquals(ap({ a: { b: 1, c: 2 } }, W(["a", "b"], null)).tree, { a: { c: 2 } });
  const root = ap({ a: 1 }, W([], null));
  assertEquals(root.warning?.code, "not_object");
  assertEquals(root.tree, { a: 1 });
  assertEquals(root.changes, []);
});
Deno.test("[A3] null keys are dropped when the current value is absent; deleting an absent path is silent", () => {
  assertEquals(ap({}, W(["x"], { a: 1, b: null })).tree, { x: { a: 1 } });
  assertEquals(ap({}, W([], { a: 1, b: null })).tree, { a: 1 });
  const gone = ap({ a: 1 }, W(["nope", "deep"], null));
  assertEquals(gone.tree, { a: 1 });
  assertEquals(gone.warning, undefined);
  assertEquals(gone.changes, []);
});
Deno.test("[A4] arrays replace", () => {
  assertEquals(ap({ l: [1, 2] }, W([], { l: [3] })).tree, { l: [3] });
  assertEquals(ap({ l: [1, 2] }, W(["l"], [9])).tree, { l: [9] });
});
Deno.test("[A5] append: absent, array, non-array, null_append, missing_source", () => {
  assertEquals(ap({}, A(["l"], 1)).tree, { l: [1] });
  assertEquals(ap({ l: [1] }, A(["l"], { a: 1 })).tree, { l: [1, { a: 1 }] });
  const bad = ap({ l: "x" }, A(["l"], 1));
  assertEquals(bad.warning, { code: "append_not_array", path: ["l"] });
  assertEquals(bad.tree, { l: "x" });
  assertEquals(ap({ a: 1 }, A([], 1)).warning?.code, "append_not_array");
  const cfg: StateWriteConfig = { mode: "append", path: "l" };
  assertEquals(computeStateWrites(cfg, null).warnings, [{ code: "null_append", path: ["l"] }]);
  assertEquals(computeStateWrites(cfg, undefined).warnings, [
    { code: "missing_source", path: ["l"] },
  ]);
  assertEquals(computeStateWrites(cfg, 5).ops, [A(["l"], 5)]);
  assertEquals(
    computeStateWrites({ mode: "append", path: "l", from: "a.b" }, { a: { b: 7 } }).ops,
    [
      A(["l"], 7),
    ],
  );
  assertEquals(
    computeStateWrites({ mode: "append", path: "l", from: "a.zz" }, { a: {} }).warnings[0].code,
    "missing_source",
  );
});
Deno.test("[A6] root: non-object output, dotted key creates intermediates, non-plain intermediate replaced", () => {
  for (const out of [[1], "s", 3, null, undefined]) {
    const r = computeStateWrites({ mode: "root" }, out);
    assertEquals(r.ops, []);
    assertEquals(r.warnings, [{ code: "not_object", path: [] }]);
  }
  const k = computeStateWrites({ mode: "key", key: "order.id" }, 5);
  assertEquals(k.ops, [W(["order", "id"], 5)]);
  assertEquals(foldState({}, k.ops), { order: { id: 5 } });
  assertEquals(ap({ order: "str" }, W(["order", "id"], 1)).tree, { order: { id: 1 } });
  assertEquals(ap({ order: [1] }, W(["order", "id"], 1)).tree, { order: { id: 1 } });
  assertEquals(ap({ a: 1 }, W([], [1])).warning?.code, "not_object");
});
Deno.test("[A7] pick: row order, missing source skipped, numeric segment, own-property read, from ''", () => {
  const cfg: StateWriteConfig = {
    mode: "pick",
    map: [{ from: "b", to: "y" }, { from: "nope", to: "z" }, { from: "a", to: "x" }],
  };
  const r = computeStateWrites(cfg, { a: 1, b: 2 });
  assertEquals(r.ops, [W(["y"], 2), W(["x"], 1)]);
  assertEquals(r.warnings, [{ code: "missing_source", path: ["z"] }]);
  assertEquals(
    computeStateWrites({ mode: "pick", map: [{ from: "items.1.id", to: "second" }] }, {
      items: [{ id: "a" }, { id: "b" }],
    }).ops,
    [W(["second"], "b")],
  );
  assertEquals(
    computeStateWrites({ mode: "pick", map: [{ from: "items.5", to: "s" }] }, { items: [1] })
      .warnings
      .length,
    1,
  );
  assertEquals(
    computeStateWrites({ mode: "pick", map: [{ from: "items.length", to: "n" }] }, { items: [1] })
      .ops,
    [],
  );
  const own = computeStateWrites({ mode: "pick", map: [{ from: "toString", to: "t" }] }, {});
  assertEquals(own.ops, []);
  assertEquals(own.warnings, [{ code: "missing_source", path: ["t"] }]);
  assertEquals(
    computeStateWrites({ mode: "pick", map: [{ from: "", to: "all" }] }, { q: 1 }).ops,
    [W(["all"], { q: 1 })],
  );
  assertEquals(computeStateWrites({ mode: "pick", map: [] }, { q: 1 }), { ops: [], warnings: [] });
});
Deno.test("[A18] changes: per key for a merge, single for set/delete/append", () => {
  const m = ap({ a: 1, b: 2 }, W([], { a: 9, c: 3, b: null }));
  assertEquals(m.changes, [
    { path: ["a"], old: 1, new: 9 },
    { path: ["c"], new: 3 },
    { path: ["b"], old: 2 },
  ]);
  assertEquals(Object.keys(m.changes[1]), ["path", "new"]);
  assertEquals(ap({ x: { a: 1 } }, W(["x"], { b: 2 })).changes, [{ path: ["x", "b"], new: 2 }]);
  assertEquals(ap({ x: 1 }, W(["x"], 2)).changes, [{ path: ["x"], old: 1, new: 2 }]);
  assertEquals(ap({}, W(["x", "y"], 2)).changes, [{ path: ["x", "y"], new: 2 }]);
  assertEquals(ap({ x: 1 }, W(["x"], null)).changes, [{ path: ["x"], old: 1 }]);
  assertEquals(ap({ l: [1] }, A(["l"], 2)).changes, [{ path: ["l"], old: [1], new: [1, 2] }]);
  assertEquals(ap({}, A(["l"], 2)).changes, [{ path: ["l"], new: [2] }]);
});

// --- A8: caps --------------------------------------------------------------------------------

Deno.test("[A8] writeChars passes at 65536 serialized chars and fails at 65537", () => {
  const at = { a: "x".repeat(STATE_LIMITS.writeChars - 8) }; // {"a":"..."} = len + 8
  assertEquals(JSON.stringify(at).length, 65536);
  assertEquals(computeStateWrites({ mode: "root" }, at).ops.length, 1);
  const over = { a: "x".repeat(STATE_LIMITS.writeChars - 7) };
  const r = computeStateWrites({ mode: "root" }, over);
  assertEquals(r.ops, []);
  assertEquals(r.warnings, [{ code: "write_too_large", path: [] }]);
});
Deno.test("[A8] runChars reverts with run_too_large and leaves the tree deep-equal", () => {
  const big = (n: number) => ({ s: "x".repeat(n) });
  let tree: StateTree = {};
  for (let i = 0; i < 17; i++) tree = ap(tree, W([`k${i}`], big(60000))).tree;
  const before = JSON.parse(JSON.stringify(tree));
  assert(JSON.stringify(tree).length < STATE_LIMITS.runChars);
  const r = ap(tree, W(["more"], big(60000)));
  assertEquals(r.warning, { code: "run_too_large", path: ["more"] });
  assertEquals(r.changes, []);
  assertEquals(r.tree, before);
  assertStrictEquals(r.tree, tree);
  // exactly at the cap passes: pad the next key so the total is runChars.
  const room = STATE_LIMITS.runChars - JSON.stringify(tree).length;
  const key = "p";
  const overhead = 7; // `,"p":""`
  const exact = ap(tree, W([key], "y".repeat(room - overhead)));
  assertEquals(exact.warning, undefined);
  assertEquals(JSON.stringify(exact.tree).length, STATE_LIMITS.runChars);
  assertEquals(ap(tree, W([key], "y".repeat(room - overhead + 1))).warning?.code, "run_too_large");
});
Deno.test("[A8] depth passes at 32 and fails at 33, counting path segments", () => {
  // root mode: path length 0, so value depth 32 passes, 33 fails.
  assertEquals(computeStateWrites({ mode: "root" }, nested(32)).ops.length, 1);
  assertEquals(computeStateWrites({ mode: "root" }, nested(33)).warnings[0].code, "too_deep");
  // key mode with a 3-segment key: value depth 29 passes, 30 fails (3 + 29 = 32).
  const cfg: StateWriteConfig = { mode: "key", key: "a.b.c" };
  assertEquals(computeStateWrites(cfg, nested(29)).ops.length, 1);
  assertEquals(computeStateWrites(cfg, nested(30)).warnings[0].code, "too_deep");
  // a bare path of 32 segments passes, 33 fails.
  const seg = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`).join(".");
  assertEquals(computeStateWrites({ mode: "key", key: seg(32) }, 1).ops.length, 1);
  assertEquals(computeStateWrites({ mode: "key", key: seg(33) }, 1).warnings[0].code, "too_deep");
  // the sink counts the same way
  assertEquals(ap({}, W(["a", "b", "c"], nested(29))).warning, undefined);
  assertEquals(ap({}, W(["a", "b", "c"], nested(30))).warning?.code, "too_deep");
});
Deno.test("[A8] key length 128 passes and 129 fails, in a value and in a path", () => {
  const k128 = "k".repeat(128);
  const k129 = "k".repeat(129);
  assertEquals(computeStateWrites({ mode: "root" }, { [k128]: 1 }).ops.length, 1);
  assertEquals(
    computeStateWrites({ mode: "root" }, { [k129]: 1 }).warnings[0].code,
    "key_too_long",
  );
  assertEquals(computeStateWrites({ mode: "key", key: k128 }, 1).ops.length, 1);
  assertEquals(
    computeStateWrites({ mode: "key", key: `x.${k129}` }, 1).warnings[0].code,
    "key_too_long",
  );
  assertEquals(parseStatePath(k128), [k128]);
  assertEquals(parseStatePath(k129), null);
  assertEquals(ap({}, W([k129], 1)).warning?.code, "key_too_long");
  assertEquals(ap({}, W(["x"], { [k129]: 1 })).warning?.code, "key_too_long");
  assertEquals(ap({}, W([k128], 1)).warning, undefined);
});
Deno.test("[A8] cycle, BigInt and a 10 000-deep value return a warning and never throw", () => {
  const cyc: Record<string, unknown> = { a: 1 };
  cyc.self = cyc;
  const cycArr: unknown[] = [];
  cycArr.push(cycArr);
  for (const v of [cyc, cycArr, nested(10_000)]) {
    const r = computeStateWrites({ mode: "key", key: "k" }, v);
    assertEquals(r.ops, []);
    assertEquals(r.warnings, [{ code: "too_deep", path: ["k"] }]);
    assertEquals(ap({}, W(["k"], v)).warning?.code, "too_deep");
  }
  const big = computeStateWrites({ mode: "key", key: "k" }, { n: 10n });
  assertEquals(big.ops, []);
  assertEquals(big.warnings[0].code, "write_too_large");
  // a shared-reference fan-out that is exponential when walked as a tree
  let dag: unknown = { leaf: 1 };
  for (let i = 0; i < 30; i++) dag = { l: dag, r: dag };
  assertEquals(computeStateWrites({ mode: "key", key: "k" }, dag).ops, []);
});

// --- A9: pollution ---------------------------------------------------------------------------

Deno.test("[A9] forbidden keys never reach Object.prototype, in compute, apply and log fold", () => {
  const protoNames = Object.getOwnPropertyNames(Object.prototype);
  const polluted = () => ({} as Record<string, unknown>).polluted;
  const trees: unknown[] = [];
  const bad = [
    '{"__proto__":{"polluted":1}}',
    '{"a":{"__proto__":{"polluted":1}}}',
    '{"a":[{"constructor":{"prototype":{"polluted":1}}}]}',
    '{"x":{"prototype":1}}',
  ].map((s) => JSON.parse(s));
  for (const v of bad) {
    for (const cfg of [{ mode: "root" }, { mode: "key", key: "k" }] as StateWriteConfig[]) {
      const r = computeStateWrites(cfg, v);
      assertEquals(r.ops, []);
      assertEquals(r.warnings[0].code, "forbidden_key");
    }
    const a = ap({ keep: 1 }, W(["k"], v));
    assertEquals(a.warning?.code, "forbidden_key");
    assertEquals(a.tree, { keep: 1 });
    trees.push(a.tree, ap({ keep: 1 }, W([], v)).tree, foldState({ keep: 1 }, [W([], v)]));
    const rows: StateLogRow[] = [
      { seq: 0, nodeId: null, path: [], new: { keep: 1 } },
      { seq: 1, nodeId: "n", path: ["k"], new: v },
      { seq: 2, nodeId: "n", path: [], new: v },
    ];
    const t = foldStateLog(rows);
    assertEquals(t, { keep: 1 });
    trees.push(t);
  }
  for (const name of STATE_FORBIDDEN_KEYS) {
    assertStrictEquals(parseStatePath(name), null);
    assertStrictEquals(parseStatePath(`a.${name}.b`), null);
    const direct = ap({ keep: 1 }, W(["a", name], 1));
    assertEquals(direct.warning?.code, "forbidden_key");
    assertEquals(direct.tree, { keep: 1 });
    assertEquals(ap({ keep: 1 }, A([name], 1)).warning?.code, "forbidden_key");
    assertEquals(ap({ keep: 1 }, W([name], null)).warning?.code, "forbidden_key");
    const t = foldStateLog([
      { seq: 0, nodeId: null, path: [], new: { keep: 1 } },
      { seq: 1, nodeId: "n", path: [name, "polluted"], new: 1 },
      { seq: 2, nodeId: "n", path: ["a", name], new: 1 },
    ]);
    assertEquals(t, { keep: 1 });
    trees.push(direct.tree, t);
    assertEquals(
      computeStateWrites({ mode: "key", key: `a.${name}` }, 1).warnings[0].code,
      "forbidden_key",
    );
  }
  assertEquals(
    computeStateWrites({ mode: "pick", map: [{ from: "a", to: "__proto__.x" }] }, { a: 1 })
      .warnings[0]
      .code,
    "forbidden_key",
  );
  assertEquals(polluted(), undefined);
  assertEquals(Object.getOwnPropertyNames(Object.prototype), protoNames);
  for (const t of trees) assertStrictEquals(Object.getPrototypeOf(t), Object.prototype);
});

// --- A10: secrets ----------------------------------------------------------------------------

Deno.test("[A10] envelopes become the mask at the top level, inside objects and inside arrays", () => {
  const opts = { isSecret: isSecretValue };
  assertEquals(STATE_SECRET_MASK, "__stored__");
  const top = computeStateWrites({ mode: "key", key: "k" }, secret, opts);
  assertEquals(top.ops, [W(["k"], "__stored__")]);
  const obj = computeStateWrites({ mode: "root" }, { a: secret, b: { c: secret }, n: 1 }, opts);
  assertEquals(obj.ops[0].value, { a: "__stored__", b: { c: "__stored__" }, n: 1 });
  const arr = computeStateWrites({ mode: "key", key: "k" }, [secret, [secret], 1], opts);
  assertEquals(arr.ops[0].value, ["__stored__", ["__stored__"], 1]);
  const pick = computeStateWrites(
    { mode: "pick", map: [{ from: "s", to: "t" }] },
    { s: secret },
    opts,
  );
  assertEquals(pick.ops, [W(["t"], "__stored__")]);
  const app = computeStateWrites({ mode: "append", path: "l" }, { s: secret }, opts);
  assertEquals(app.ops, [A(["l"], { s: "__stored__" })]);
  assert(!JSON.stringify(obj).includes("ciphertext"));
});
Deno.test("[A10] no predicate strips nothing; whole-output envelope in root mode is not_object", () => {
  assertEquals(computeStateWrites({ mode: "key", key: "k" }, secret).ops, [W(["k"], secret)]);
  const r = computeStateWrites({ mode: "root" }, secret, { isSecret: isSecretValue });
  assertEquals(r.ops, []);
  assertEquals(r.warnings, [{ code: "not_object", path: [] }]);
  // a throwing predicate fails closed
  const t = computeStateWrites({ mode: "key", key: "k" }, { a: 1 }, {
    isSecret: () => {
      throw new Error("boom");
    },
  });
  assertEquals(t.ops, [W(["k"], "__stored__")]);
});
Deno.test("[A10] a stripped value that is still too large is capped after the strip", () => {
  const v = { a: secret, pad: "x".repeat(STATE_LIMITS.writeChars) };
  const r = computeStateWrites({ mode: "root" }, v, { isSecret: isSecretValue });
  assertEquals(r.warnings[0].code, "write_too_large");
  // the envelope is bigger than the mask: stripping is what brings it under the cap
  const fat = { type: "secret", ciphertext: "c".repeat(70000), iv: "i" };
  const ok = computeStateWrites({ mode: "key", key: "k" }, fat, { isSecret: isSecretValue });
  assertEquals(ok.ops, [W(["k"], "__stored__")]);
  assertEquals(
    computeStateWrites({ mode: "key", key: "k" }, fat).warnings[0].code,
    "write_too_large",
  );
});

// --- A11: purity -----------------------------------------------------------------------------

Deno.test("[A11] deep-frozen inputs do not throw and are unchanged", () => {
  const output = deepFreeze({ a: { b: [1, { c: 2 }] }, d: null });
  const tree = deepFreeze({ a: { x: 1 }, l: [1], keep: { k: 1 } });
  const snapshot = JSON.stringify([output, tree]);
  const ops = deepFreeze([
    W([], { a: { z: 1 }, d: null }),
    A(["l"], 2),
    W(["keep", "k"], null),
    W(["new", "deep"], { q: [1] }),
  ]);
  const cfg = deepFreeze({ mode: "pick", map: [{ from: "a.b.1", to: "p.q" }] }) as StateWriteConfig;
  const c = computeStateWrites(cfg, output);
  assertEquals(c.ops, [W(["p", "q"], { c: 2 })]);
  const f = foldState(tree, ops);
  assertEquals(f, { a: { z: 1 }, l: [1, 2], keep: {}, new: { deep: { q: [1] } } });
  const rows = deepFreeze([
    { seq: 0, nodeId: null, path: [], new: { a: 1 } },
    { seq: 1, nodeId: "n", path: ["b"], new: { c: 1 } },
  ]) as StateLogRow[];
  assertEquals(foldStateLog(rows), { a: 1, b: { c: 1 } });
  for (const op of ops) ap(tree, op);
  assertEquals(JSON.stringify([output, tree]), snapshot);
  assertEquals(f.l, [1, 2]);
  assertEquals(tree.l, [1]);
});
Deno.test("[A11] mutating output after compute leaves the ops unchanged", () => {
  const output = { a: { b: 1 }, list: [1, 2] };
  const r = computeStateWrites({ mode: "root" }, output);
  const r2 = computeStateWrites({ mode: "append", path: "l", from: "list" }, output);
  const r3 = computeStateWrites({ mode: "pick", map: [{ from: "a", to: "x" }] }, output);
  const before = JSON.stringify([r.ops, r2.ops, r3.ops]);
  output.a.b = 99;
  output.list.push(3);
  (r.ops[0].value as { a: { b: number } }).a.b; // read only
  assertEquals(JSON.stringify([r.ops, r2.ops, r3.ops]), before);
  assert((r.ops[0].value as { a: unknown }).a !== output.a);
  assert(r3.ops[0].value !== output.a);
  assert(r2.ops[0].value !== output.list);
});
Deno.test("[A11] an op value equals its JSON round-trip (a Date becomes its ISO string)", () => {
  const d = new Date("2026-01-02T03:04:05.000Z");
  const out = { when: d, n: NaN, u: undefined, nested: { d } };
  const r = computeStateWrites({ mode: "root" }, out);
  assertEquals(r.ops[0].value, JSON.parse(JSON.stringify(out)));
  assertEquals((r.ops[0].value as { when: string }).when, "2026-01-02T03:04:05.000Z");
  const dateOnly = computeStateWrites({ mode: "key", key: "k" }, d);
  assertEquals(dateOnly.ops, [W(["k"], "2026-01-02T03:04:05.000Z")]);
  // the sink output shares nothing with the op it was given
  const opv = { a: { b: 1 } };
  const t = ap({}, W(["x"], opv)).tree as { x: { a: object } };
  assert(t.x !== opv && t.x.a !== opv.a);
});

// --- A12..A16: helpers -----------------------------------------------------------------------

Deno.test("[A12] effectiveStateConfig", () => {
  assertEquals(effectiveStateConfig("@w6w/data", "set", undefined), { mode: "root" });
  assertEquals(effectiveStateConfig("@w6w/data", "set", { mode: "off" }), { mode: "off" });
  assertEquals(effectiveStateConfig("slack", "post", undefined), { mode: "off" });
  assertEquals(effectiveStateConfig("@w6w/data", "other", undefined), { mode: "off" });
  assertEquals(effectiveStateConfig(undefined, undefined, undefined), { mode: "off" });
  const given: StateWriteConfig = { mode: "key", key: "k" };
  assertStrictEquals(effectiveStateConfig("slack", "post", given), given);
  assertStrictEquals(effectiveStateConfig("@w6w/data", "set", given), given);
});
Deno.test("[A13] validateStateConfig: each issue code, all five valid modes, extras ignored", () => {
  const codes = (c: unknown) => validateStateConfig(c).map((i) => i.code);
  for (const bad of [null, undefined, [], "root", 3]) assertEquals(codes(bad), ["not_object"]);
  assertEquals(codes({ mode: "nope" }), ["unknown_mode"]);
  assertEquals(codes({}), ["unknown_mode"]);
  assertEquals(codes({ mode: "key" }), ["invalid_path"]);
  assertEquals(codes({ mode: "key", key: "" }), ["invalid_path"]);
  assertEquals(codes({ mode: "key", key: "a..b" }), ["invalid_path"]);
  assertEquals(codes({ mode: "key", key: "__proto__" }), ["invalid_path"]);
  assertEquals(codes({ mode: "key", key: "k".repeat(129) }), ["invalid_path"]);
  assertEquals(codes({ mode: "append" }), ["invalid_path"]);
  assertEquals(codes({ mode: "append", path: "l", from: 3 }), ["invalid_path"]);
  assertEquals(codes({ mode: "append", path: "l", from: "a..b" }), ["invalid_path"]);
  assertEquals(codes({ mode: "pick" }), ["invalid_map"]);
  assertEquals(codes({ mode: "pick", map: {} }), ["invalid_map"]);
  assertEquals(codes({ mode: "pick", map: [3] }), ["invalid_map"]);
  assertEquals(codes({ mode: "pick", map: [{ from: "a" }] }), ["invalid_map"]);
  assertEquals(codes({ mode: "pick", map: [{ to: "a" }] }), ["invalid_map"]);
  assertEquals(codes({ mode: "pick", map: [{ from: "a", to: "" }] }), ["invalid_map"]);
  assertEquals(codes({ mode: "pick", map: [{ from: "a", to: "a.__proto__" }] }), ["invalid_map"]);
  assertEquals(codes({ mode: "pick", map: [{ from: "a..b", to: "x" }] }), ["invalid_map"]);
  for (const i of validateStateConfig({ mode: "key" })) assert(i.message.includes("key"));
  assert(
    validateStateConfig({ mode: "pick", map: [{ from: "a", to: "" }] })[0].message.includes(
      "map[0].to",
    ),
  );
  const ok: unknown[] = [
    { mode: "off" },
    { mode: "root" },
    { mode: "key", key: "order.id" },
    { mode: "pick", map: [{ from: "", to: "a" }, { from: "x.y", to: "b.c" }] },
    { mode: "pick", map: [] },
    { mode: "append", path: "l" },
    { mode: "append", path: "l", from: "" },
    { mode: "append", path: "l", from: "a.0" },
    { mode: "root", extra: 1, junk: [] },
    { mode: "key", key: "k", other: true },
  ];
  for (const c of ok) assertEquals(validateStateConfig(c), []);
});
Deno.test("[A14] staticWritePaths for all five modes", () => {
  assertEquals(staticWritePaths({ mode: "off" }), []);
  assertEquals(staticWritePaths({ mode: "root" }), [[]]);
  assertEquals(staticWritePaths({ mode: "key", key: "a.b" }), [["a", "b"]]);
  assertEquals(
    staticWritePaths({ mode: "pick", map: [{ from: "x", to: "p.q" }, { from: "y", to: "r" }] }),
    [["p", "q"], ["r"]],
  );
  assertEquals(staticWritePaths({ mode: "append", path: "l.m" }), [["l", "m"]]);
  // unparseable paths are omitted and nothing throws
  assertEquals(staticWritePaths({ mode: "key", key: "a..b" }), []);
  assertEquals(
    staticWritePaths({ mode: "pick", map: [{ from: "x", to: "" }, { from: "x", to: "ok" }] }),
    [
      ["ok"],
    ],
  );
  assertEquals(staticWritePaths({ mode: "append", path: "__proto__" }), []);
  assertEquals(staticWritePaths(null as unknown as StateWriteConfig), []);
  assertEquals(staticWritePaths({ mode: "pick" } as unknown as StateWriteConfig), []);
});
Deno.test("[A14] statePathsOverlap: prefix, equal, disjoint, root", () => {
  assert(statePathsOverlap(["a"], ["a", "b"]));
  assert(statePathsOverlap(["a", "b"], ["a"]));
  assert(statePathsOverlap(["a", "b"], ["a", "b"]));
  assertFalse(statePathsOverlap(["a"], ["b"]));
  assertFalse(statePathsOverlap(["a", "b"], ["a", "c"]));
  assertFalse(statePathsOverlap(["ab"], ["a"]));
  assert(statePathsOverlap([], ["x", "y"]));
  assert(statePathsOverlap(["x"], []));
  assert(statePathsOverlap([], []));
});
Deno.test("[A14] frozen constants and reserved keys", () => {
  assert(Object.isFrozen(STATE_LIMITS) && Object.isFrozen(STATE_FORBIDDEN_KEYS));
  assert(Object.isFrozen(STATE_RESERVED_TOP_KEYS));
  assertEquals([...STATE_FORBIDDEN_KEYS], ["__proto__", "constructor", "prototype"]);
  assertEquals([...STATE_RESERVED_TOP_KEYS], ["nodes", "trigger", "foreach"]);
  assertEquals({ ...STATE_LIMITS }, {
    writeChars: 65536,
    runChars: 1048576,
    initialChars: 65536,
    depth: 32,
    keyLength: 128,
    logRows: 1000,
    logChars: 4194304,
  });
  assertEquals(STATE_LIMITS.logChars, 4194304);
});
Deno.test("[A15] foldState and foldStateLog", () => {
  const ops = [W([], { a: 1 }), A(["l"], 1), A(["l"], 2), W(["a"], null)];
  assertEquals(foldState({ z: 0 }, ops), { z: 0, l: [1, 2] });
  const rows: StateLogRow[] = [
    { seq: 0, nodeId: null, path: [], new: { z: 0 } },
    { seq: 1, nodeId: "n1", path: ["a"], new: 1 },
    { seq: 2, nodeId: "n1", path: ["l"], new: [1] },
    { seq: 3, nodeId: "n2", path: ["l"], old: [1], new: [1, 2] },
    { seq: 4, nodeId: "n2", path: ["a"], old: 1 },
    { seq: 5, nodeId: "n3", path: ["x"], new: 1, warning: "too_deep" },
    { seq: 6, nodeId: "n3", path: ["y"], new: 1 },
  ];
  assertEquals(foldStateLog(rows), { z: 0, l: [1, 2], y: 1 });
  assertEquals(foldStateLog(rows, 0), { z: 0 });
  assertEquals(foldStateLog(rows, 1), { z: 0, a: 1 });
  assertEquals(foldStateLog(rows, 3), { z: 0, a: 1, l: [1, 2] });
  assertEquals(foldStateLog(rows, 4), { z: 0, l: [1, 2] });
  assertEquals(foldStateLog(rows, 5), { z: 0, l: [1, 2] });
  const shuffled = [rows[4], rows[0], rows[6], rows[2], rows[5], rows[1], rows[3]];
  assertEquals(foldStateLog(shuffled), foldStateLog(rows));
  assertEquals(foldStateLog(shuffled, 3), foldStateLog(rows, 3));
  assertEquals(shuffled[0], rows[4]); // the caller's array is not sorted in place
  assertEquals(foldStateLog([]), {});
  assertEquals(foldStateLog([{ seq: 0, nodeId: null, path: [], new: [1] }]), {});
  // a non-0 row at root replaces with a plain value and is ignored for a non-plain one
  assertEquals(
    foldStateLog([
      { seq: 0, nodeId: null, path: [], new: { a: 1 } },
      { seq: 1, nodeId: "n", path: [], new: { b: 2 } },
    ]),
    { b: 2 },
  );
  assertEquals(
    foldStateLog([
      { seq: 0, nodeId: null, path: [], new: { a: 1 } },
      { seq: 1, nodeId: "n", path: [], new: "str" },
    ]),
    { a: 1 },
  );
  const frozen = deepFreeze(JSON.parse(JSON.stringify(rows)));
  foldStateLog(frozen);
});
Deno.test("[A15] fold of the live ops equals the fold of the log rows they emit", () => {
  const cfgOps = [
    ...computeStateWrites({ mode: "root" }, { a: 1, b: { c: 2 } }).ops,
    ...computeStateWrites({ mode: "key", key: "o.p" }, { q: 1 }).ops,
    ...computeStateWrites({ mode: "append", path: "l" }, 1).ops,
    ...computeStateWrites({ mode: "append", path: "l" }, 2).ops,
    W(["a"], null),
    W(["b"], { c: null, d: 4 }),
    W(["o"], { r: 1 }),
  ];
  let tree: StateTree = { seed: 1 };
  const log: StateLogRow[] = [{ seq: 0, nodeId: null, path: [], new: tree }];
  for (const op of cfgOps) {
    const r = ap(tree, op);
    tree = r.tree;
    for (const ch of r.changes) {
      log.push({
        seq: log.length,
        nodeId: "n",
        path: ch.path,
        ...("old" in ch ? { old: ch.old } : {}),
        ...("new" in ch ? { new: ch.new } : {}),
      });
    }
  }
  assertEquals(foldStateLog(log), tree);
  assertEquals(foldState({ seed: 1 }, cfgOps), tree);
});
Deno.test("[A16] a warn op changes nothing, echoes its warning, and foldState skips it", () => {
  const tree = { a: 1 };
  const warn: StateWriteOp = {
    kind: "warn",
    path: ["x"],
    warning: "missing_source",
    value: undefined,
  };
  const r = ap(tree, warn);
  assertStrictEquals(r.tree, tree);
  assertEquals(r.changes, []);
  assertEquals(r.warning, { code: "missing_source", path: ["x"] });
  assertEquals(foldState(tree, [warn, W(["b"], 1), warn]), { a: 1, b: 1 });
  // an unknown warning code is a silent no-op
  const odd = ap(tree, { kind: "warn", path: [], warning: "bogus" as never, value: 1 });
  assertEquals(odd.warning, undefined);
  assertEquals(odd.changes, []);
  assertStrictEquals(odd.tree, tree);
  const noCode = ap(tree, { kind: "warn", path: [], value: 1 });
  assertEquals(noCode.warning, undefined);
});

// --- A17: fixture ----------------------------------------------------------------------------

Deno.test("[A17] conflict fixture: C1..C10 once each, every node state validates", () => {
  const fx = JSON.parse(
    Deno.readTextFileSync(new URL("./fixtures/state-write-conflicts.json", import.meta.url)),
  ) as {
    version: number;
    cases: Array<{
      name: string;
      workflow: { nodes: Array<{ id: string; state?: unknown }> };
      expect: Array<{ code: string; nodes: string[]; path: string[] }>;
    }>;
  };
  assertEquals(fx.version, 1);
  for (let k = 1; k <= 10; k++) {
    assertEquals(fx.cases.filter((c) => c.name.startsWith(`C${k} `)).length, 1, `C${k}`);
  }
  for (const c of fx.cases) {
    assertEquals(typeof c.name, "string");
    assert(Array.isArray(c.expect));
    for (const n of c.workflow.nodes) {
      if (n.state !== undefined) {
        assertEquals(validateStateConfig(n.state), [], `${c.name} ${n.id}`);
      }
    }
  }
  // the validator is not vacuous over the fixture: the shapes it covers are really present
  const withState = fx.cases.flatMap((c) => c.workflow.nodes).filter((n) => n.state !== undefined);
  assert(withState.length >= 10);
  const warn = (n: number) => fx.cases.find((c) => c.name.startsWith(`C${n} `))!.expect;
  assertEquals(warn(3), [{ code: "state_parallel_write", nodes: ["b", "c"], path: ["x"] }]);
  assertEquals(warn(9), [{ code: "state_reserved_key", nodes: ["b"], path: ["nodes"] }]);
});

// --- A19: validateInitialState ---------------------------------------------------------------

Deno.test("[A19] validateInitialState: one test per issue code", () => {
  const codes = (v: unknown) => validateInitialState(v).map((i) => i.code);
  assertEquals(codes({}), []);
  assertEquals(codes({ a: { b: [1, "x", null] } }), []);
  for (const v of [[], [{ a: 1 }], null, "s", 3, undefined, new Date(0)]) {
    assertEquals(codes(v), ["not_object"]);
  }
  assertEquals(codes(JSON.parse('{"a":{"__proto__":{"x":1}}}')), ["forbidden_key"]);
  assert(
    validateInitialState(JSON.parse('{"a":{"constructor":1}}'))[0].message.includes("constructor"),
  );
  assertEquals(codes({ ["k".repeat(129)]: 1 }), ["key_too_long"]);
  assertEquals(codes({ a: nested(40) }), ["too_deep"]);
  assertEquals(codes({ a: "x".repeat(STATE_LIMITS.initialChars) }), ["initial_too_large"]);
  // every applicable check is reported, in check order
  const multi = JSON.parse('{"__proto__":1}');
  multi["k".repeat(129)] = 1;
  multi.pad = "x".repeat(STATE_LIMITS.initialChars);
  assertEquals(codes(multi), ["forbidden_key", "key_too_long", "initial_too_large"]);
});
Deno.test("[A19] validateInitialState: initialChars boundary", () => {
  const at = { a: "x".repeat(STATE_LIMITS.initialChars - 8) };
  assertEquals(JSON.stringify(at).length, 65536);
  assertEquals(validateInitialState(at), []);
  const over = { a: "x".repeat(STATE_LIMITS.initialChars - 7) };
  assertEquals(validateInitialState(over).map((i) => i.code), ["initial_too_large"]);
});
Deno.test("[A19] validateInitialState: depth 32 passes, 33 fails; cycles and 10 000-deep do not throw", () => {
  assertEquals(validateInitialState(nested(32)), []);
  assertEquals(validateInitialState(nested(33)).map((i) => i.code), ["too_deep"]);
  const cyc: Record<string, unknown> = {};
  cyc.me = cyc;
  assertEquals(validateInitialState(cyc).map((i) => i.code), ["too_deep"]);
  assertEquals(validateInitialState(nested(10_000)).map((i) => i.code), ["too_deep"]);
  assertEquals(validateInitialState({ n: 1n }).map((i) => i.code), ["initial_too_large"]);
});
Deno.test("[A19] validateInitialState does not strip or refuse secrets", () => {
  assertEquals(validateInitialState({ s: secret }), []);
});
