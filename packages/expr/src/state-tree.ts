/**
 * The run state tree: one JSON object a workflow run accumulates through `Node.state` writes,
 * plus the pure merge/fold every consumer (engine, server, editor, embed) shares.
 *
 * Pure and dependency-free (it imports only this package's own `{{ }}` grammar; the secret
 * predicate is injected). Nothing here mutates an input, and `computeStateWrites`,
 * `applyStateOp`, `foldState`, `foldStateLog` and `validateInitialState` never throw, for any input: ops and rows also arrive from persisted
 * rows and hub patches, so the sink guards the same keys and bounds the compute side does.
 * Properties are only ever created as own data properties of keys that passed those guards.
 */
import {
  coalesceOperandRefs,
  hasRefusedChainToken,
  parseTemplate,
  type TemplateEscape,
} from "./template.ts";

export type StateTree = Record<string, unknown>;

export type StateWriteConfig =
  | { mode: "off" }
  | { mode: "root" }
  | { mode: "key"; key: string }
  | { mode: "pick"; map: Array<{ from: string; to: string }> }
  | { mode: "append"; path: string; from?: string };

export type StateWarningCode =
  | "not_object"
  | "missing_source"
  | "null_append"
  | "append_not_array"
  | "write_too_large"
  | "run_too_large"
  | "too_deep"
  | "key_too_long"
  | "forbidden_key"
  | "log_truncated";

export interface StateWriteOp {
  kind: "write" | "append" | "warn";
  /** `[]` is the root. */
  path: string[];
  /** Set iff `kind === "warn"`. */
  warning?: StateWarningCode;
  /** Already secret-stripped and per-write capped. */
  value: unknown;
  /** For each item index (body ops hoisted onto the For each record). */
  item?: number;
  /** Body step id (with `item`). */
  step?: string;
}

export interface StateWarning {
  code: StateWarningCode;
  path: string[];
}

/** A key that is absent from `old` / `new` was absent from the tree. */
export interface StateChange {
  path: string[];
  old?: unknown;
  new?: unknown;
}

export interface StateLogRow {
  seq: number;
  nodeId: string | null;
  item?: number;
  step?: string;
  path: string[];
  old?: unknown;
  new?: unknown;
  warning?: StateWarningCode;
}

export interface StateConfigIssue {
  code: string;
  message: string;
}

export const STATE_LIMITS: Readonly<{
  readonly writeChars: 65536;
  readonly runChars: 1048576;
  readonly initialChars: 65536;
  readonly depth: 32;
  readonly keyLength: 128;
  readonly logRows: 1000;
  readonly logChars: 4194304;
}> = Object.freeze(
  {
    writeChars: 65536,
    runChars: 1048576,
    initialChars: 65536,
    depth: 32,
    keyLength: 128,
    logRows: 1000,
    logChars: 4194304,
  } as const,
);

export const STATE_SECRET_MASK = "__stored__";
export const STATE_FORBIDDEN_KEYS: readonly ["__proto__", "constructor", "prototype"] = Object
  .freeze(["__proto__", "constructor", "prototype"] as const);
export const STATE_RESERVED_TOP_KEYS: readonly ["nodes", "trigger", "foreach"] = Object.freeze(
  ["nodes", "trigger", "foreach"] as const,
);

const WARNING_CODES: readonly StateWarningCode[] = [
  "not_object",
  "missing_source",
  "null_append",
  "append_not_array",
  "write_too_large",
  "run_too_large",
  "too_deep",
  "key_too_long",
  "forbidden_key",
  "log_truncated",
];

/** Visits one scan may make before it gives up (a shared-reference DAG can be exponential). */
const SCAN_BUDGET = 200_000;
/** Recursion never goes deeper than this, so a 10 000-deep or cyclic value cannot overflow. */
const WALK_DEPTH_CUTOFF = 33;

// --- primitives -----------------------------------------------------------------------------

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isForbiddenKey(k: string): boolean {
  return (STATE_FORBIDDEN_KEYS as readonly string[]).includes(k);
}

/** The only way a property is created: an own data property, never a setter or `__proto__`. */
function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

function shallowCopy(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) setOwn(out, k, o[k]);
  return out;
}

/** `null` when the segment list is unusable as a write path. */
function pathProblem(path: unknown): StateWarningCode | null {
  if (!Array.isArray(path)) return "not_object";
  for (const seg of path) {
    if (typeof seg !== "string") return "not_object";
    if (isForbiddenKey(seg)) return "forbidden_key";
    if (seg.length > STATE_LIMITS.keyLength) return "key_too_long";
    if (seg === "") return "not_object";
  }
  if (path.length > STATE_LIMITS.depth) return "too_deep";
  return null;
}

export function parseStatePath(dotted: string): string[] | null {
  if (typeof dotted !== "string" || dotted === "") return null;
  const segs = dotted.split(".");
  for (const s of segs) {
    if (s === "" || isForbiddenKey(s) || s.length > STATE_LIMITS.keyLength) return null;
  }
  return segs;
}

/** Why a dotted path failed `parseStatePath`, as the warning code a write records. */
function unparseableCode(dotted: unknown): StateWarningCode {
  if (typeof dotted === "string") {
    for (const s of dotted.split(".")) {
      if (isForbiddenKey(s)) return "forbidden_key";
      if (s.length > STATE_LIMITS.keyLength) return "key_too_long";
    }
  }
  return "missing_source";
}

// --- the one bounded walker -------------------------------------------------------------------

interface Scan {
  /** A structural copy with secrets masked (when a predicate was given). */
  value: unknown;
  forbidden?: string;
  longKey?: string;
  /** depth(primitive) = 0, depth(object or array) = 1 + max child depth. */
  depth: number;
  overDepth: boolean;
  overBudget: boolean;
}

function scan(root: unknown, isSecret?: (v: unknown) => boolean): Scan {
  const r: Scan = { value: undefined, depth: 0, overDepth: false, overBudget: false };
  let budget = SCAN_BUDGET;
  const ancestors = new Set<object>();
  const secret = (v: unknown): boolean => {
    if (!isSecret) return false;
    try {
      return isSecret(v) === true;
    } catch {
      return true; // fail closed
    }
  };
  const walk = (v: unknown, lvl: number): [unknown, number] => {
    if (--budget < 0) {
      r.overBudget = true;
      return [null, 0];
    }
    if (secret(v)) return [STATE_SECRET_MASK, 0];
    if (typeof v !== "object" || v === null) return [v, 0];
    // A Date-like value: JSON.stringify calls toJSON; the round-trip result is re-scanned.
    if (!Array.isArray(v) && typeof (v as { toJSON?: unknown }).toJSON === "function") {
      return [v, 0];
    }
    if (lvl >= WALK_DEPTH_CUTOFF || ancestors.has(v)) {
      r.overDepth = true; // a cycle is infinitely deep
      return [null, WALK_DEPTH_CUTOFF + 1];
    }
    ancestors.add(v);
    let childDepth = 0;
    let out: unknown;
    if (Array.isArray(v)) {
      const arr: unknown[] = [];
      for (let i = 0; i < v.length && !r.overBudget; i++) {
        const [c, d] = walk(v[i], lvl + 1);
        arr.push(c);
        if (d > childDepth) childDepth = d;
      }
      out = arr;
    } else {
      const obj: Record<string, unknown> = {};
      for (const k of Object.keys(v)) {
        if (r.overBudget) break;
        if (isForbiddenKey(k)) {
          r.forbidden ??= k;
          continue;
        }
        if (k.length > STATE_LIMITS.keyLength) {
          r.longKey ??= k;
          continue;
        }
        const [c, d] = walk((v as Record<string, unknown>)[k], lvl + 1);
        setOwn(obj, k, c);
        if (d > childDepth) childDepth = d;
      }
      out = obj;
    }
    ancestors.delete(v);
    return [out, childDepth + 1];
  };
  const [value, depth] = walk(root, 0);
  r.value = value;
  r.depth = depth;
  return r;
}

/** The code the first failing structural check names, in P3 order, or null. */
function structuralCode(s: Scan, pathLen: number): StateWarningCode | null {
  if (s.forbidden !== undefined) return "forbidden_key";
  if (s.longKey !== undefined) return "key_too_long";
  if (s.overDepth || pathLen + s.depth > STATE_LIMITS.depth) return "too_deep";
  if (s.overBudget) return "write_too_large";
  return null;
}

type Normalized = { ok: true; value: unknown } | { ok: false; code: StateWarningCode };

/** P3: strip secrets, refuse keys and depth, then round-trip through JSON and cap the size. */
function normalizeValue(
  value: unknown,
  pathLen: number,
  isSecret?: (v: unknown) => boolean,
): Normalized {
  try {
    const s = scan(value, isSecret);
    const code = structuralCode(s, pathLen);
    if (code) return { ok: false, code };
    const json = JSON.stringify(s.value);
    if (json === undefined) return { ok: false, code: "missing_source" };
    if (json.length > STATE_LIMITS.writeChars) return { ok: false, code: "write_too_large" };
    const parsed: unknown = JSON.parse(json);
    // toJSON may have produced keys the first walk never saw.
    const again = structuralCode(scan(parsed), pathLen);
    if (again) return { ok: false, code: again };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, code: "write_too_large" };
  }
}

// --- config helpers ---------------------------------------------------------------------------

function issue(code: string, message: string): StateConfigIssue {
  return { code, message };
}

function validFromPath(from: unknown): boolean {
  return typeof from === "string" && (from === "" || parseStatePath(from) !== null);
}

export function validateStateConfig(config: unknown): StateConfigIssue[] {
  if (!isPlain(config)) return [issue("not_object", "state must be an object")];
  const mode = config.mode;
  switch (mode) {
    case "off":
    case "root":
      return [];
    case "key": {
      const key = config.key;
      if (typeof key !== "string" || parseStatePath(key) === null) {
        return [issue("invalid_path", "state.key must be a dotted path of non-empty keys")];
      }
      return [];
    }
    case "pick": {
      const map = config.map;
      if (!Array.isArray(map)) return [issue("invalid_map", "state.map must be an array")];
      const out: StateConfigIssue[] = [];
      map.forEach((row: unknown, i: number) => {
        if (!isPlain(row)) {
          out.push(issue("invalid_map", `state.map[${i}] must be an object`));
          return;
        }
        if (!validFromPath(row.from)) {
          out.push(
            issue("invalid_map", `state.map[${i}].from must be "" or a dotted path`),
          );
        }
        if (typeof row.to !== "string" || parseStatePath(row.to) === null) {
          out.push(issue("invalid_map", `state.map[${i}].to must be a dotted path`));
        }
      });
      return out;
    }
    case "append": {
      const out: StateConfigIssue[] = [];
      if (typeof config.path !== "string" || parseStatePath(config.path) === null) {
        out.push(issue("invalid_path", "state.path must be a dotted path of non-empty keys"));
      }
      if (config.from !== undefined && !validFromPath(config.from)) {
        out.push(issue("invalid_path", 'state.from must be "" or a dotted path'));
      }
      return out;
    }
    default:
      return [
        issue("unknown_mode", "state.mode must be one of off, root, key, pick, append"),
      ];
  }
}

export function effectiveStateConfig(
  app: string | undefined,
  action: string | undefined,
  config: StateWriteConfig | undefined,
): StateWriteConfig {
  if (config !== undefined && config !== null) return config;
  return app === "@w6w/data" && action === "set" ? { mode: "root" } : { mode: "off" };
}

export function staticWritePaths(config: StateWriteConfig): string[][] {
  try {
    if (!isPlain(config)) return [];
    const c = config as Record<string, unknown>;
    switch (c.mode) {
      case "root":
        return [[]];
      case "key": {
        const p = typeof c.key === "string" ? parseStatePath(c.key) : null;
        return p ? [p] : [];
      }
      case "append": {
        const p = typeof c.path === "string" ? parseStatePath(c.path) : null;
        return p ? [p] : [];
      }
      case "pick": {
        if (!Array.isArray(c.map)) return [];
        const out: string[][] = [];
        for (const row of c.map) {
          const to = isPlain(row) && typeof row.to === "string" ? parseStatePath(row.to) : null;
          if (to) out.push(to);
        }
        return out;
      }
      default:
        return [];
    }
  } catch {
    return [];
  }
}

export function statePathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --- compute ----------------------------------------------------------------------------------

const INDEX_SEGMENT = /^(0|[1-9][0-9]*)$/;

/** Own properties only; a numeric segment indexes an array. `undefined` = missing. */
function readFrom(output: unknown, segs: readonly string[]): unknown {
  let cur = output;
  for (const seg of segs) {
    if (Array.isArray(cur)) {
      if (!INDEX_SEGMENT.test(seg)) return undefined;
      const idx = Number(seg);
      if (idx >= cur.length) return undefined;
      cur = cur[idx];
    } else if (typeof cur === "object" && cur !== null && Object.hasOwn(cur, seg)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

function readFromSpec(output: unknown, from: unknown): unknown {
  if (from === "" || from === undefined) return output;
  const segs = typeof from === "string" ? parseStatePath(from) : null;
  return segs ? readFrom(output, segs) : undefined;
}

export function computeStateWrites(
  config: StateWriteConfig,
  output: unknown,
  opts?: { isSecret?: (v: unknown) => boolean },
): { ops: StateWriteOp[]; warnings: StateWarning[] } {
  const ops: StateWriteOp[] = [];
  const warnings: StateWarning[] = [];
  const isSecret = opts?.isSecret;
  const warn = (code: StateWarningCode, path: string[]) => warnings.push({ code, path });
  const emit = (kind: "write" | "append", path: string[], raw: unknown) => {
    const n = normalizeValue(raw, path.length, isSecret);
    if (!n.ok) return warn(n.code, path);
    ops.push({ kind, path, value: n.value });
  };
  const target = (dotted: unknown): string[] | null => {
    const p = typeof dotted === "string" ? parseStatePath(dotted) : null;
    if (!p) warn(unparseableCode(dotted), []);
    return p;
  };
  try {
    if (!isPlain(config)) return { ops, warnings };
    const c = config as Record<string, unknown>;
    switch (c.mode) {
      case "root": {
        if (output === undefined) {
          warn("not_object", []);
          break;
        }
        const n = normalizeValue(output, 0, isSecret);
        if (!n.ok) {
          warn(n.code, []);
        } else if (!isPlain(n.value)) {
          warn("not_object", []);
        } else {
          ops.push({ kind: "write", path: [], value: n.value });
        }
        break;
      }
      case "key": {
        const p = target(c.key);
        if (!p) break;
        if (output === undefined) warn("missing_source", p);
        else emit("write", p, output);
        break;
      }
      case "pick": {
        if (!Array.isArray(c.map)) break;
        for (const row of c.map) {
          if (!isPlain(row)) {
            warn("missing_source", []);
            continue;
          }
          const to = target(row.to);
          if (!to) continue;
          const v = typeof row.from === "string" && (row.from === "" || parseStatePath(row.from))
            ? readFromSpec(output, row.from)
            : undefined;
          if (v === undefined) warn("missing_source", to);
          else emit("write", to, v);
        }
        break;
      }
      case "append": {
        const p = target(c.path);
        if (!p) break;
        const v = typeof c.from === "string" && c.from !== "" && !parseStatePath(c.from)
          ? undefined
          : readFromSpec(output, c.from);
        if (v === undefined) warn("missing_source", p);
        else if (v === null) warn("null_append", p);
        else emit("append", p, v);
        break;
      }
      default:
        break;
    }
  } catch {
    // never throw: whatever was decided so far stands
  }
  return { ops, warnings };
}

// --- apply ------------------------------------------------------------------------------------

/** The value at `path`, walking plain objects only. */
function lookup(tree: Record<string, unknown>, path: readonly string[]): {
  found: boolean;
  value?: unknown;
} {
  let cur: unknown = tree;
  for (const seg of path) {
    if (!isPlain(cur) || !Object.hasOwn(cur, seg)) return { found: false };
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

function setAt(node: unknown, path: readonly string[], idx: number, val: unknown): unknown {
  if (idx === path.length) return val;
  const cur = isPlain(node) ? node : {};
  const copy = shallowCopy(cur);
  const k = path[idx];
  setOwn(copy, k, setAt(Object.hasOwn(cur, k) ? cur[k] : undefined, path, idx + 1, val));
  return copy;
}

function deleteAt(node: Record<string, unknown>, path: readonly string[], idx: number) {
  const copy = shallowCopy(node);
  const k = path[idx];
  if (idx === path.length - 1) delete copy[k];
  else setOwn(copy, k, deleteAt(node[k] as Record<string, unknown>, path, idx + 1));
  return copy;
}

function serializedLength(tree: unknown): number {
  try {
    return JSON.stringify(tree)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

type Applied = { tree: StateTree; changes: StateChange[]; warning?: StateWarning };

export function applyStateOp(tree: StateTree, op: StateWriteOp): Applied {
  const base: StateTree = isPlain(tree) ? tree : {};
  const refuse = (code: StateWarningCode, path: unknown): Applied => ({
    tree: base,
    changes: [],
    warning: { code, path: Array.isArray(path) ? path.map(String) : [] },
  });
  try {
    if (!op || typeof op !== "object") return refuse("not_object", []);
    if (op.kind === "warn") {
      return WARNING_CODES.includes(op.warning as StateWarningCode)
        ? refuse(op.warning as StateWarningCode, op.path)
        : { tree: base, changes: [] };
    }
    if (op.kind !== "write" && op.kind !== "append") return refuse("not_object", op.path);
    const p = op.path;
    const pc = pathProblem(p);
    if (pc) return refuse(pc, p);
    if (op.value === undefined) return refuse("missing_source", p);
    const s = scan(op.value);
    const sc = structuralCode(s, p.length);
    if (sc) return refuse(sc, p);
    const v = s.value;
    const cur = lookup(base, p);

    let next: StateTree;
    const changes: StateChange[] = [];
    const old = (c: { found: boolean; value?: unknown }) => (c.found ? { old: c.value } : {});

    if (op.kind === "append") {
      if (cur.found && !Array.isArray(cur.value)) return refuse("append_not_array", p);
      const arr = cur.found ? [...(cur.value as unknown[]), v] : [v];
      next = setAt(base, p, 0, arr) as StateTree;
      changes.push({ path: [...p], ...old(cur), new: arr });
    } else if (v === null) {
      if (p.length === 0) return refuse("not_object", p);
      if (!cur.found) return { tree: base, changes: [] };
      next = deleteAt(base, p, 0);
      changes.push({ path: [...p], old: cur.value });
    } else if (isPlain(v)) {
      const incoming = v as Record<string, unknown>;
      if (cur.found && isPlain(cur.value)) {
        const curObj = cur.value;
        const merged = shallowCopy(curObj);
        for (const k of Object.keys(incoming)) {
          const had = Object.hasOwn(curObj, k);
          const base0 = { path: [...p, k], ...(had ? { old: curObj[k] } : {}) };
          if (incoming[k] === null) {
            delete merged[k];
            changes.push(base0);
          } else {
            setOwn(merged, k, incoming[k]);
            changes.push({ ...base0, new: incoming[k] });
          }
        }
        next = p.length === 0 ? merged : (setAt(base, p, 0, merged) as StateTree);
      } else {
        const stripped: Record<string, unknown> = {};
        for (const k of Object.keys(incoming)) {
          if (incoming[k] !== null) setOwn(stripped, k, incoming[k]);
        }
        next = setAt(base, p, 0, stripped) as StateTree;
        const keys = Object.keys(stripped);
        if (!cur.found && keys.length > 0) {
          for (const k of keys) changes.push({ path: [...p, k], new: stripped[k] });
        } else {
          changes.push({ path: [...p], ...old(cur), new: stripped });
        }
      }
    } else {
      if (p.length === 0) return refuse("not_object", p);
      next = setAt(base, p, 0, v) as StateTree;
      changes.push({ path: [...p], ...old(cur), new: v });
    }
    if (serializedLength(next) > STATE_LIMITS.runChars) return refuse("run_too_large", p);
    return { tree: next, changes };
  } catch {
    return refuse("run_too_large", op?.path);
  }
}

export function foldState(base: StateTree, ops: Iterable<StateWriteOp>): StateTree {
  let tree: StateTree = isPlain(base) ? base : {};
  try {
    for (const op of ops) {
      if (op?.kind === "warn") continue;
      tree = applyStateOp(tree, op).tree;
    }
  } catch {
    // an unreadable iterable ends the fold where it stands
  }
  return tree;
}

export function foldStateLog(rows: readonly StateLogRow[], uptoSeq?: number): StateTree {
  let tree: StateTree = {};
  try {
    const list = (Array.isArray(rows) ? rows : [])
      .filter((r) => r && typeof r === "object" && typeof r.seq === "number" && !isNaN(r.seq))
      .sort((a, b) => a.seq - b.seq);
    for (const row of list) {
      if (uptoSeq !== undefined && row.seq > uptoSeq) break;
      if (row.warning !== undefined) continue;
      const hasNew = row.new !== undefined && row.new !== null;
      if (row.seq === 0 && row.nodeId === null) {
        if (hasNew && isPlain(row.new)) {
          const s = scan(row.new);
          tree = structuralCode(s, 0) ? {} : (s.value as StateTree);
        } else {
          tree = {};
        }
        continue;
      }
      const p = row.path;
      if (pathProblem(p) !== null) continue;
      if (p.length === 0) {
        if (hasNew && isPlain(row.new)) {
          const s = scan(row.new);
          if (!structuralCode(s, 0)) tree = s.value as StateTree;
        }
        continue;
      }
      if (!hasNew) {
        if (lookup(tree, p).found) tree = deleteAt(tree, p, 0);
        continue;
      }
      const s = scan(row.new);
      if (structuralCode(s, p.length)) continue;
      tree = setAt(tree, p, 0, s.value) as StateTree;
    }
  } catch {
    // a malformed row set leaves the tree as folded so far
  }
  return tree;
}

// --- starting data ----------------------------------------------------------------------------

/**
 * The twelve run-scope roots (core/rfcs/workflow.md, the run state tree amendment). A `{{ }}`
 * marker whose first segment is none of these is a vendor placeholder and stays literal, exactly
 * as in a `with` value; it is never an expression of ours.
 */
const RUN_SCOPE_ROOTS: ReadonlySet<string> = new Set([
  "var",
  "vars",
  "state",
  "const",
  "nodes",
  "steps",
  "trigger",
  "secrets",
  "documents",
  "inputs",
  "output",
  "foreach",
]);

/** The roots `Workflow.initialState` may read (2026-11-01 seed-expressions addendum). */
const INITIAL_STATE_ROOTS: ReadonlySet<string> = new Set(["var", "vars", "const", "documents"]);

const rootOf = (ref: string) => ref.split(".")[0];

/** A `{{ }}` part the engine would resolve: the same per-marker rule as a `with` string. */
function isOurPart(part: { kind: string; ref?: string; expr?: unknown }): boolean {
  switch (part.kind) {
    case "secret":
      return true;
    case "expr": {
      const refs = coalesceOperandRefs(part.expr);
      return refs === null || refs.every((r) => RUN_SCOPE_ROOTS.has(rootOf(r)));
    }
    case "var":
      return !hasRefusedChainToken(part.ref ?? "") && RUN_SCOPE_ROOTS.has(rootOf(part.ref ?? ""));
    default:
      return false;
  }
}

const OUR_MARKERS: TemplateEscape = { isOurs: isOurPart, backslash: "keep" };

/** Why `ref` may not be read by `initialState`, or `null` when it may. */
function initialRefProblem(ref: unknown): string | null {
  if (typeof ref !== "string") return "a computed path";
  const segs = ref.split(".");
  if (segs[0] === "secrets") return "secret";
  if (segs[0] === "nodes") {
    return segs.length >= 3 && segs[1] !== "" && segs[2] === "meta"
      ? null
      : `"${ref}" (only nodes.<id>.meta is static)`;
  }
  if (INITIAL_STATE_ROOTS.has(segs[0]) && segs.length >= 2 && segs[1] !== "") return null;
  return `"${ref}"`;
}

/** Every JSONLogic `var` operand path in `e` (a non-string path is pushed as-is). */
function logicRefs(e: unknown, out: unknown[]): void {
  if (Array.isArray(e)) {
    for (const x of e) logicRefs(x, out);
    return;
  }
  if (!isPlain(e)) return;
  for (const k of Object.keys(e)) {
    if (k === "var") {
      const a = e[k];
      out.push(Array.isArray(a) ? a[0] : a);
      if (Array.isArray(a)) { for (const x of a.slice(1)) logicRefs(x, out); }
    } else logicRefs(e[k], out);
  }
}

/**
 * The references an `initialState` value would read, walked with the engine's own arms: an
 * `{ type: "expr", parts }` value, `{ "$": path }`, `{ "$expr": logic }`, and a string every one
 * of whose `{{ }}` markers names a run-scope root (any other string is literal, whole). A sealed
 * envelope is a leaf. Only called on a value the bounded scan accepted (no cycle, depth <= 32).
 */
function initialRefIssues(v: unknown, path: string, out: StateConfigIssue[]): void {
  const refs: unknown[] = [];
  let secret = false;
  const takeParts = (parts: readonly { kind: string; ref?: string; expr?: unknown }[]) => {
    for (const p of parts) {
      if (p.kind === "secret") secret = true;
      else if (p.kind === "var") refs.push(p.ref ?? "");
      else if (p.kind === "expr") logicRefs(p.expr, refs);
    }
  };
  if (Array.isArray(v)) {
    v.forEach((x, i) => initialRefIssues(x, `${path}[${i}]`, out));
    return;
  }
  if (isPlain(v)) {
    const keys = Object.keys(v);
    if (v.type === "secret" && typeof v.ciphertext === "string" && typeof v.iv === "string") return;
    if (v.type === "expr" && Array.isArray(v.parts)) {
      takeParts(v.parts.filter(isPlain) as { kind: string }[]);
    } else if (keys.length === 1 && keys[0] === "$") {
      refs.push(v.$);
    } else if (keys.length === 1 && keys[0] === "$expr") {
      logicRefs(v.$expr, refs);
    } else {
      for (const k of keys) initialRefIssues(v[k], path ? `${path}.${k}` : k, out);
      return;
    }
  } else if (typeof v === "string" && v.includes("{{")) {
    const parts = parseTemplate(v, "editor", OUR_MARKERS);
    if (parts.some((p) => p.kind !== "text" && !isOurPart(p))) return; // literal, whole
    takeParts(parts);
  } else {
    return;
  }
  const at = `initialState.${path}`;
  if (secret || refs.some((r) => initialRefProblem(r) === "secret")) {
    out.push(
      issue(
        "secret_ref",
        `${at} reads a secret, and a secret may never enter the run state tree (take it in ` +
          "the `with` param of the step that needs it)",
      ),
    );
  }
  for (const r of refs) {
    const problem = initialRefProblem(r);
    if (problem === null || problem === "secret") continue;
    out.push(
      issue(
        "disallowed_root",
        `${at} reads ${problem}: initialState is resolved once before the first step, so it may ` +
          "read only var, vars, const, documents and nodes.<id>.meta",
      ),
    );
  }
}

/**
 * Validates `Workflow.initialState` with the same bounded walker the write path uses, so the
 * engine and the server refuse exactly the same set. It does not strip sealed envelopes (the read
 * edge does). A `{{ }}` expression in it (2026-11-01 seed-expressions addendum) may read only
 * `var`/`vars`, `const`, `documents` and `nodes.<id>.meta`; a secret reference is refused.
 */
export function validateInitialState(v: unknown): StateConfigIssue[] {
  if (!isPlain(v)) return [issue("not_object", "initialState must be a JSON object")];
  const out: StateConfigIssue[] = [];
  try {
    const s = scan(v);
    if (s.forbidden !== undefined) {
      out.push(issue("forbidden_key", `initialState holds the forbidden key "${s.forbidden}"`));
    }
    if (s.longKey !== undefined) {
      out.push(
        issue(
          "key_too_long",
          `initialState holds a key longer than ${STATE_LIMITS.keyLength} characters ("${
            s.longKey.slice(0, 32)
          }...")`,
        ),
      );
    }
    const tooDeep = s.overDepth || s.depth > STATE_LIMITS.depth;
    if (tooDeep) {
      out.push(issue("too_deep", `initialState is nested deeper than ${STATE_LIMITS.depth}`));
    }
    let tooLarge = s.overBudget;
    if (!tooLarge && !tooDeep) {
      try {
        tooLarge = (JSON.stringify(v)?.length ?? 0) > STATE_LIMITS.initialChars;
      } catch {
        tooLarge = true;
      }
    }
    if (tooLarge) {
      out.push(
        issue("initial_too_large", `initialState exceeds ${STATE_LIMITS.initialChars} characters`),
      );
    }
    if (!tooDeep && s.forbidden === undefined) {
      for (const k of Object.keys(v)) initialRefIssues(v[k], k, out);
    }
  } catch {
    out.push(issue("initial_too_large", "initialState could not be read"));
  }
  return out;
}
