/**
 * Shared source-ref validation rules and the cache-containment predicate.
 * Internal to `@w6w/sources` — deliberately not re-exported from `mod.ts`.
 */
import { isAbsolute, relative } from "jsr:@std/path@^1.0.0";
import { SourceError } from "./types.ts";

const OWNER_RE = /^[A-Za-z0-9_.-]+$/;
const DOT_ONLY_RE = /^\.+$/;

/** True for a repo-host owner / repo / group segment: safe charset and not dot-only. */
export function isSafeSegment(s: string): boolean {
  return OWNER_RE.test(s) && !DOT_ONLY_RE.test(s);
}

/**
 * True for a git ref (`feature/x`, `v1.2`, a SHA): non-empty, and every
 * `/`-separated segment is non-empty and not `.` or `..`.
 */
export function isSafeGitRef(ref: string): boolean {
  if (ref === "") return false;
  return ref.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

/** Throw `bad_ref` unless `ref` passes {@link isSafeGitRef}. */
export function assertSafeGitRef(ref: string, whole: string): void {
  if (!isSafeGitRef(ref)) {
    throw new SourceError("bad_ref", `Invalid ref segment in source ref: ${whole}`);
  }
}

/**
 * Whether `candidate` is strictly inside `root` (not `root` itself), judged by
 * `relative()` — a bare prefix test would accept `/s/cache-evil` for `/s/cache`.
 */
export function isStrictlyInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
