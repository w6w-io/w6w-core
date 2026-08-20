/**
 * Applying {@link RequestOverrides} to an outbound request.
 *
 * The escape hatch works at the WIRE rather than at an Action's params, because
 * that is the only place it can be universal: `resolveParams` restricts params
 * to the Action's declared surface, and an Action's `execute` builds its body
 * from whatever it was given. Merging over the request the action already built
 * needs no Action to opt in, declare anything, or be edited.
 *
 * Two boundaries this never crosses:
 *   - **Auth.** The merge runs BEFORE the `sign` hook, so any header the app's
 *     auth injects overwrites one supplied here. Overrides can add a header;
 *     they can never hijack authentication.
 *   - **Egress.** Only the query string is touched. Host, port and path are left
 *     exactly as the action wrote them, so the app's `network.allow` allowlist
 *     stays the boundary it was — an override envelope cannot redirect a signed,
 *     credentialed request at a host of the caller's choosing.
 */
import type { RequestOverrides, SignableRequest } from "@w6w/types";
import { W6WError } from "./errors.ts";

/** Requests whose body an action does not normally send. */
const BODYLESS = new Set(["GET", "HEAD"]);

// ── Paths ──────────────────────────────────────────────────────────────────

/** One step of an override path: an object key, or an array index. */
export type PathSegment = { kind: "key"; key: string } | { kind: "index"; index: number };

/** An override key, parsed: where it points, and whether it merges or replaces. */
export interface OverrideKey {
  segments: PathSegment[];
  /** The `!` suffix — replace this value outright instead of merging into it. */
  replace: boolean;
}

/**
 * Parse an override key into path segments plus its merge disposition.
 *
 * A key is a PATH when it carries an unescaped `.` or `[`; otherwise it is a
 * plain top-level field name (with any backslash escapes resolved, so a vendor
 * field whose own name contains a dot is still reachable as `"a\\.b"`).
 *
 * A trailing unescaped `!` means REPLACE — see {@link mergeValue} for why the
 * default is to merge and this is the opt-out.
 *
 * Throws on a malformed path rather than falling back to treating it as a
 * literal key: `"items["` almost certainly meant to be a path, and quietly
 * setting a field of that name would produce a request the caller never asked
 * for and cannot see.
 */
export function parseOverrideKey(key: string): OverrideKey {
  // The `!` is stripped BEFORE path parsing so it can never be mistaken for
  // part of a segment name. Escaped (`"loud\\!"`), it is just a character.
  let replace = false;
  let source = key;
  if (source.endsWith("!") && !source.endsWith("\\!")) {
    replace = true;
    source = source.slice(0, -1);
  }
  return { segments: parseOverridePath(source), replace };
}

/** Parse an override key's path segments alone. See {@link parseOverrideKey}. */
export function parseOverridePath(key: string): PathSegment[] {
  const segments: PathSegment[] = [];
  let current = "";
  let sawSeparator = false;

  const pushKey = (required: boolean) => {
    if (current === "") {
      // An empty segment only makes sense directly after an index (`a[0].b`
      // pushes nothing between `]` and `.`), never at the start or doubled.
      if (required) throw invalidPath(key, "empty segment");
      return;
    }
    segments.push({ kind: "key", key: current });
    current = "";
  };

  for (let i = 0; i < key.length; i++) {
    const ch = key[i];
    if (ch === "\\") {
      if (i + 1 >= key.length) throw invalidPath(key, "trailing escape");
      current += key[++i];
      continue;
    }
    if (ch === ".") {
      sawSeparator = true;
      pushKey(segments.length === 0 || current !== "" || key[i - 1] !== "]");
      continue;
    }
    if (ch === "[") {
      sawSeparator = true;
      pushKey(segments.length === 0);
      const close = key.indexOf("]", i);
      if (close === -1) throw invalidPath(key, "unterminated `[`");
      const raw = key.slice(i + 1, close);
      if (!/^\d+$/.test(raw)) throw invalidPath(key, `\`[${raw}]\` is not an array index`);
      segments.push({ kind: "index", index: Number(raw) });
      i = close;
      continue;
    }
    if (ch === "]") throw invalidPath(key, "unmatched `]`");
    current += ch;
  }
  pushKey(sawSeparator && current === "" && !key.endsWith("]"));
  if (segments.length === 0) throw invalidPath(key, "empty key");
  return segments;
}

function invalidPath(key: string, why: string): W6WError {
  return new W6WError(
    "param_invalid",
    "resolution",
    `Override key "${key}" is not a valid path: ${why}.`,
  );
}

/** True when these segments address something other than a plain top-level field. */
export function isPath(segments: PathSegment[]): boolean {
  return segments.length > 1 || segments[0].kind === "index";
}

/**
 * Set `value` at `segments` inside `root`, creating intermediate containers.
 *
 * An index beyond the end of its array is refused rather than padded: filling
 * the gap with nulls would send a body the caller did not write, and silently
 * appending instead would put the value somewhere other than the index they
 * named. Appending AT the end (`index === length`) is the one growth allowed,
 * because that is unambiguous.
 */
export function setPath(
  root: Record<string, unknown>,
  segments: PathSegment[],
  value: unknown,
  original: string,
): void {
  let cursor: unknown = root;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    const next = segments[i + 1];
    // What the NEXT step needs the child to be — an index step needs an array.
    const wantArray = next?.kind === "index";

    if (seg.kind === "key") {
      if (!isPlainObject(cursor)) {
        throw new W6WError(
          "param_invalid",
          "resolution",
          `Override path "${original}" expects an object at "${seg.key}", but the request has ` +
            `${describe(cursor)} there.`,
        );
      }
      if (last) {
        cursor[seg.key] = value;
        return;
      }
      const existing = cursor[seg.key];
      if (existing === undefined || existing === null) cursor[seg.key] = wantArray ? [] : {};
      cursor = cursor[seg.key];
      continue;
    }

    if (!Array.isArray(cursor)) {
      throw new W6WError(
        "param_invalid",
        "resolution",
        `Override path "${original}" indexes [${seg.index}], but the request has ` +
          `${describe(cursor)} there, not an array.`,
      );
    }
    if (seg.index > cursor.length) {
      throw new W6WError(
        "param_invalid",
        "resolution",
        `Override path "${original}" sets index ${seg.index}, but that array has ` +
          `${cursor.length} element${cursor.length === 1 ? "" : "s"}. ` +
          `Set an existing index, or ${cursor.length} to append.`,
      );
    }
    if (last) {
      cursor[seg.index] = value;
      return;
    }
    if (cursor[seg.index] === undefined || cursor[seg.index] === null) {
      cursor[seg.index] = wantArray ? [] : {};
    }
    cursor = cursor[seg.index];
  }
}

/**
 * Read whatever currently sits at `segments`, or `undefined` if the path does
 * not resolve. Never throws: a path that does not exist yet is the normal case
 * (it is about to be created), not an error.
 */
export function readPath(root: unknown, segments: PathSegment[]): unknown {
  let cursor: unknown = root;
  for (const seg of segments) {
    if (seg.kind === "key") {
      if (!isPlainObject(cursor)) return undefined;
      cursor = cursor[seg.key];
      continue;
    }
    if (!Array.isArray(cursor)) return undefined;
    cursor = cursor[seg.index];
  }
  return cursor;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
}

// ── Merging ────────────────────────────────────────────────────────────────

/**
 * Merge one value over another. **Enhancing, never negating** — that is the
 * whole rule, and everything below follows from it.
 *
 * An override arrives on top of a request the flow's own configuration built.
 * Losing part of that configuration because an override touched its neighbour
 * is the failure mode worth designing against: it is silent, it happens at the
 * wire where nobody is looking, and the value that vanished was one the author
 * deliberately set. So:
 *
 *   - two objects DEEP-MERGE — keys only in the base survive;
 *   - two arrays merge INDEX-WISE — `[{to}]` + `[{cc}]` is `[{to, cc}]`, not
 *     `[{cc}]`. Indices the base has and the patch does not are KEPT; indices
 *     past the base's end are appended;
 *   - anything else (a scalar, or a type change) takes the patch value, because
 *     there is nothing to merge.
 *
 * The cost is that a plain override cannot SHORTEN or wholly replace a list:
 * `["a","b"]` + `["c"]` is `["c","b"]`. When replacing is what you mean, say so
 * with the `!` suffix (`"categories!"`) — deliberate, visible, and impossible
 * to do by accident.
 */
export function mergeValue(base: unknown, patch: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(patch)) return deepMerge(base, patch);
  if (Array.isArray(base) && Array.isArray(patch)) return mergeArrays(base, patch);
  return patch;
}

function mergeArrays(base: unknown[], patch: unknown[]): unknown[] {
  const out = [...base];
  for (let i = 0; i < patch.length; i++) {
    out[i] = i < base.length ? mergeValue(base[i], patch[i]) : patch[i];
  }
  return out;
}

/** Deep-merge `patch` over `base`. See {@link mergeValue} for the rules. */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = mergeValue(out[k], v);
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One override field, resolved to where it goes and how it lands. */
export interface BodyOverride {
  /** The key as written, for error messages. */
  original: string;
  segments: PathSegment[];
  replace: boolean;
  value: unknown;
}

/**
 * Split an override body into the plain fields (merged into the built body) and
 * the path fields (set leaf by leaf, afterwards).
 */
export function splitBodyOverrides(
  body: Record<string, unknown>,
): { plain: BodyOverride[]; paths: BodyOverride[] } {
  const plain: BodyOverride[] = [];
  const paths: BodyOverride[] = [];
  for (const [original, value] of Object.entries(body)) {
    const { segments, replace } = parseOverrideKey(original);
    (isPath(segments) ? paths : plain).push({ original, segments, replace, value });
  }
  return { plain, paths };
}

/** Whether this request is the one the envelope's `target`/`match` selects. */
export function selectsRequest(
  overrides: RequestOverrides,
  request: SignableRequest,
  state: { index: number; writeIndex: number },
): boolean {
  if (overrides.match && !request.url.includes(overrides.match)) return false;
  switch (overrides.target ?? "first") {
    case "all":
      return true;
    case "first-write":
      return state.writeIndex === 0 && !BODYLESS.has(request.method.toUpperCase());
    default:
      return state.index === 0;
  }
}

/**
 * Return a copy of `request` with the envelope's overrides applied.
 *
 * The request is never mutated: the caller holds the original for the egress
 * log, and a merge that silently rewrote it would make the log claim the action
 * sent something it did not.
 */
export function applyOverrides(
  request: SignableRequest,
  overrides: RequestOverrides,
): SignableRequest {
  let { url, headers, body } = request;

  if (overrides.query && Object.keys(overrides.query).length) {
    // Parse-and-rebuild rather than string-append: it normalises repeats and,
    // more importantly, `u.searchParams` cannot reach host or path, so there is
    // no shape of input here that redirects the request.
    const u = new URL(url);
    for (const [k, v] of Object.entries(overrides.query)) {
      if (v === null) u.searchParams.delete(k);
      else u.searchParams.set(k, String(v));
    }
    url = u.toString();
  }

  if (overrides.headers && Object.keys(overrides.headers).length) {
    headers = { ...headers };
    for (const [k, v] of Object.entries(overrides.headers)) {
      if (v === undefined || v === null) continue;
      // Case-insensitively replace, so `content-type` and `Content-Type` cannot
      // both end up on the request.
      const existing = Object.keys(headers).find((h) => h.toLowerCase() === k.toLowerCase());
      if (existing) delete headers[existing];
      headers[k] = String(v);
    }
  }

  if (overrides.body && Object.keys(overrides.body).length) {
    const contentType = (headerValue(headers, "content-type") ?? "").toLowerCase();
    body = contentType.includes("application/x-www-form-urlencoded")
      ? applyFormOverrides(body, overrides.body)
      : applyJsonOverrides(request, body, overrides.body, headers, (h) => (headers = h));
  }

  return { ...request, url, headers, body };
}

/** Merge into a JSON object body. */
function applyJsonOverrides(
  request: SignableRequest,
  body: string | null | undefined,
  patch: Record<string, unknown>,
  headers: Record<string, string>,
  setHeaders: (h: Record<string, string>) => void,
): string | null | undefined {
  const parsed = parseJsonObject(body);
  const { plain, paths } = splitBodyOverrides(patch);

  let target: Record<string, unknown>;
  if (parsed) {
    target = { ...parsed };
  } else if (!body && !BODYLESS.has(request.method.toUpperCase())) {
    // No body at all on a method that takes one: the overrides ARE the body.
    target = {};
    if (!headerValue(headers, "content-type")) {
      setHeaders({ ...headers, "content-type": "application/json" });
    }
  } else {
    // A body that is an ARRAY, a bare scalar, or a non-JSON encoding has no key
    // space to merge with, and guessing (wrapping it, appending to it) would
    // corrupt a request that was valid. Left alone on purpose.
    return body;
  }

  for (const field of plain) {
    const key = (field.segments[0] as { key: string }).key;
    // `!` is the opt-out: take the value whole instead of merging into what the
    // action built. Without it, merging is the default precisely so a flow's
    // own configuration cannot be silently negated by an override beside it.
    target[key] = field.replace ? field.value : mergeValue(target[key], field.value);
  }

  // Paths run AFTER the plain fields, so where both name the same leaf the path
  // wins — a fixed order rather than an object-key-order accident. A path names
  // ONE leaf, so it sets that leaf; `!` there is the same instruction said twice
  // and is accepted for symmetry.
  for (const field of paths) {
    const existing = field.replace ? undefined : readPath(target, field.segments);
    const next = field.replace ? field.value : mergeValue(existing, field.value);
    setPath(target, field.segments, next, field.original);
  }
  return JSON.stringify(target);
}

/**
 * Merge into an `x-www-form-urlencoded` body. Form encoding is flat, so only
 * top-level fields apply and an array value becomes repeated keys — which is
 * how every API that takes a list this way expects it (Twilio's `MediaUrl`).
 */
function applyFormOverrides(
  body: string | null | undefined,
  patch: Record<string, unknown>,
): string {
  const params = new URLSearchParams(typeof body === "string" ? body : "");
  for (const [key, value] of Object.entries(patch)) {
    const { segments } = parseOverrideKey(key);
    if (isPath(segments)) {
      throw new W6WError(
        "param_invalid",
        "resolution",
        `Override "${key}" uses a path, but this request sends a form-encoded body, ` +
          `which is flat — use a plain field name.`,
      );
    }
    const name = (segments[0] as { key: string }).key;
    params.delete(name);
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null) continue;
      if (isPlainObject(item)) {
        throw new W6WError(
          "param_invalid",
          "resolution",
          `Override "${key}" is an object, but this request sends a form-encoded body, ` +
            `which carries only text — send a string, a number, a boolean, or a list of those.`,
        );
      }
      params.append(name, String(item));
    }
  }
  return params.toString();
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers ?? {}).find((h) => h.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/** The body parsed as a JSON OBJECT, or undefined for anything else. */
function parseJsonObject(body: string | null | undefined): Record<string, unknown> | undefined {
  if (typeof body !== "string" || !body.trim()) return undefined;
  try {
    const parsed = JSON.parse(body);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
