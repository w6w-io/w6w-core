/**
 * Bracket indexing in a reference path: `messages[0].id` and `user["name"]` read as
 * `messages.0.id` and `user.name` — the dot form every path walker splits on. An index or
 * quoted key that holds `.`, `{` or `}` is left as written: it has no dot spelling.
 */
const BRACKET = /\[\s*(?:(\d+)|"([^"\\.{}]*)"|'([^'\\.{}]*)')\s*\]/g;

/** The dot spelling of a path written with `[n]` / `["key"]` / `['key']` segments. */
export function normalizeRefPath(path: string): string {
  if (!path.includes("[")) return path;
  return path.replace(
    BRACKET,
    (whole, n: string | undefined, dq: string | undefined, sq: string | undefined, at: number) =>
      at === 0 ? whole : `.${n ?? dq ?? sq}`,
  );
}
