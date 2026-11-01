/**
 * Output-shape comparison — the ONE keys+types comparator between a declared
 * `OutputField[]` and an observed shape (app-build sample-vs-output, server
 * drift). Keys and type names only: values never enter a result.
 * See rfcs/action.md (Amendment — 2026-11-01).
 */
import type { OutputField } from "./action.ts";

export type ObservedType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "object"
  | "array"
  | "unknown";

/** dotted path -> type; an array's element fields sit under "<path>.0.<key>" */
export type ObservedShape = Record<string, ObservedType>;

export interface OutputShapeDiff {
  missing: string[];
  extra: string[];
  typeMismatch: { key: string; declared: string; observed: string }[];
}

/** Maximum path depth (segments) `observedShapeOfValue` expands. */
const MAX_DEPTH = 8;

function typeOf(value: unknown): ObservedType {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "unknown";
  }
}

function record(shape: ObservedShape, path: string, type: ObservedType): void {
  const seen = Object.hasOwn(shape, path) ? shape[path] : undefined;
  if (seen === undefined || seen === "null") shape[path] = type;
  else if (type !== "null" && seen !== type) shape[path] = "unknown";
}

function walk(shape: ObservedShape, path: string, value: unknown, depth: number): void {
  const type = typeOf(value);
  record(shape, path, type);
  if (depth >= MAX_DEPTH) return;
  if (type === "array") {
    for (const el of value as unknown[]) walk(shape, `${path}.0`, el, depth + 1);
  } else if (type === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      walk(shape, `${path}.${k}`, v, depth + 1);
    }
  }
}

/** The observed keys+types of a value. Plain objects expand; arrays merge their elements under `.0`. */
export function observedShapeOfValue(value: unknown): ObservedShape {
  const shape: ObservedShape = {};
  if (typeOf(value) !== "object") return shape;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(shape, k, v, 1);
  return shape;
}

const parentOf = (path: string): string | undefined => {
  const i = path.lastIndexOf(".");
  return i < 0 ? undefined : path.slice(0, i);
};

/** Compare a declared `OutputField[]` against an observed shape. Keys and type names only. */
export function compareOutputShape(
  declared: readonly OutputField[],
  observed: ObservedShape,
): OutputShapeDiff {
  const decl = new Map<string, string>();
  for (const f of declared) {
    decl.set(f.key, f.type);
    if (f.type === "array" && f.items && f.items.length > 0) {
      decl.set(`${f.key}.0`, "object");
      for (const it of f.items) decl.set(`${f.key}.0.${it.key}`, it.type);
    }
  }
  const hasChild = new Set<string>();
  for (const p of decl.keys()) {
    const par = parentOf(p);
    if (par !== undefined) hasChild.add(par);
  }
  const has = (o: object, k: string) => Object.hasOwn(o, k);

  const diff: OutputShapeDiff = { missing: [], extra: [], typeMismatch: [] };
  for (const [path, type] of decl) {
    const par = parentOf(path);
    if (!has(observed, path)) {
      if (par === undefined || (has(observed, par) && observed[par] === "object")) {
        diff.missing.push(path);
      }
      continue;
    }
    const obs = observed[path];
    if (obs !== "null" && obs !== "unknown" && type !== "file" && obs !== type) {
      diff.typeMismatch.push({ key: path, declared: type, observed: obs });
    }
  }
  for (const path of Object.keys(observed)) {
    if (decl.has(path)) continue;
    const par = parentOf(path);
    if (par === undefined || (decl.has(par) && hasChild.has(par))) diff.extra.push(path);
  }
  return diff;
}
