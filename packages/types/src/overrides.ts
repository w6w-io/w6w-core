/**
 * Request overrides — the caller's escape hatch for request fields an Action
 * does not declare.
 *
 * An Action's `params` are a curated surface: a form an author designed, and the
 * only keys `resolveParams` lets through (every other supplied key is dropped).
 * That is right for the common path and wrong at the edges — a vendor ships a
 * field we have not modelled yet, or documents one we chose not to surface, or
 * accepts an undocumented one a customer needs. Before this existed the only way
 * to reach such a field was to abandon the app for the raw `@w6w/http` node and
 * re-supply the credential by hand, outside the Connection that already held it.
 *
 * So the escape hatch works at the WIRE, not at the params: the Action's
 * `execute` builds the request it always would, and these values are merged over
 * it just before it is signed. That is what makes it universal — no Action has
 * to opt in, declare anything, or be edited.
 *
 * **The vendor's own field names apply.** An override names the field the way
 * the vendor's API documents it, not the way the Action's form does, because it
 * is applied to the built request rather than to `params`.
 *
 * See rfcs/invocation.md §Overrides.
 */

/** Which of an Action's outbound requests the overrides are merged into. */
export type OverridesTarget =
  /** The first request the action makes. The default; most actions make one. */
  | "first"
  /** The first request whose method is not GET/HEAD — the write, for actions that look something up first. */
  | "first-write"
  /** Every request. Deliberate and rarely right; an action that paginates would carry them on each page. */
  | "all";

/**
 * Caller-supplied overrides applied to an Action's outbound request.
 *
 * Every field is optional; an envelope with nothing set is a no-op and is
 * treated as absent.
 */
export interface RequestOverrides {
  /**
   * Merged over the request body, whichever encoding it uses — a JSON object
   * body merges structurally, an `x-www-form-urlencoded` body takes top-level
   * fields (a list value becoming repeated keys, which is how form encoding
   * expresses a list).
   *
   * ## The merge ENHANCES; it does not negate
   *
   * An override lands on top of a request the flow's own configuration built,
   * so the rule is that nothing already there is lost:
   *
   *   - two objects deep-merge — keys only in the built body survive;
   *   - two arrays merge INDEX-WISE, so setting CC beside a recipient list
   *     keeps the recipients:
   *
   * ```jsonc
   * // built by the action        override                merged
   * // [{ "to": [...] }]     +    [{ "cc": [...] }]   →   [{ "to": [...], "cc": [...] }]
   * ```
   *
   *   - anything else takes the override's value, because there is nothing to
   *     merge into.
   *
   * ## Naming a field precisely, and replacing one deliberately
   *
   * A **path key** — dotted, with `[n]` for an index — names one leaf, for when
   * merging into a whole branch is more than you meant:
   *
   * ```jsonc
   * { "personalizations[0].cc": [{ "email": "cc@example.com" }] }
   * ```
   *
   * A key is a path when it contains an unescaped `.` or `[`. Escape a literal
   * dot with a backslash (`"a\\.b"`) for the rare vendor field whose own name
   * carries one. Paths are applied AFTER plain keys, so where both name the
   * same leaf the path wins — a fixed order rather than an object-key-order
   * accident.
   *
   * A trailing **`!`** replaces instead of merging, which is the only way to
   * shorten or discard a list the action built:
   *
   * ```jsonc
   * { "categories!": ["transactional"] }   // exactly this, not merged over the existing
   * ```
   *
   * Deliberate, visible, and impossible to do by accident — which is the point,
   * since the accident it prevents is silent data loss at the wire.
   */
  body?: Record<string, unknown>;
  /**
   * Merged into the request URL's query string. A `null` value REMOVES a
   * parameter the action set; anything else sets it. Host and path are never
   * touched — the app's egress allowlist stays the boundary.
   */
  query?: Record<string, string | number | boolean | null>;
  /**
   * Added to the request headers. Applied BEFORE the auth `sign` hook runs, so
   * a header the app's auth owns always wins — this can add a header, never
   * hijack authentication. See `signingFetch`.
   */
  headers?: Record<string, string>;
  /** Which outbound request receives the overrides. Defaults to `"first"`. */
  target?: OverridesTarget;
  /**
   * Restrict the merge to requests whose URL contains this substring. For an
   * action that calls several endpoints and where `target` alone is too blunt.
   */
  match?: string;
}

/** True when the envelope carries nothing to merge. */
export function isEmptyOverrides(overrides: RequestOverrides | undefined): boolean {
  if (!overrides) return true;
  for (const key of ["body", "query", "headers"] as const) {
    const v = overrides[key];
    if (v && Object.keys(v).length > 0) return false;
  }
  return true;
}
