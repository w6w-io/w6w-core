/**
 * Atom 1.0 + RSS 2.0 reader for status feeds. See rfcs/healthcheck.md
 * § "Feed-backed checks".
 *
 * This lives in the runtime, not in each App, because the two halves of reading
 * a feed belong in different places. Parsing Atom/RSS is generic, fiddly and
 * identical for every publisher; interpreting what an entry MEANS is
 * vendor-specific. So the host parses and the App interprets — which also means
 * a publisher never reimplements this, and never reimplements it subtly wrong.
 *
 * The distinction that matters: **a feed is a log of updates, not a statement
 * of current state.** Mistral's status feed makes it concrete — 50 entries
 * describe 26 incidents, because each update to an incident is its own entry,
 * and the newest entry for a *resolved* incident still carries the incident's
 * original title ("Audio API Degraded"). Judging by the newest entry's title
 * reports an outage that ended days ago. `latestPerId` is the fold that
 * resolves this, and it is applied for every feed-backed check.
 *
 * No dependency: Deno ships no XML parser, and a health hook is not worth a
 * supply-chain edge. This is a tolerant scanner over the subset of Atom/RSS
 * that status feeds actually use — it does not validate, and it is not a
 * general XML reader.
 */
import type { HealthFeedEntry, HealthFeedFormat } from "@w6w/types";

/** Unwrap `<![CDATA[…]]>` wrappers, keeping their contents. */
function unwrapCdata(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the XML entities a feed actually uses, plus numeric escapes. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

/**
 * Block-level elements imply a word boundary; inline ones do not. Getting this
 * wrong is how `Affected services<ul><li>Audio API</li></ul>` reads back as
 * "Affected servicesAudio API".
 */
const BLOCK_TAG =
  /<\/?(?:p|div|br|hr|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|section|article|header|footer|blockquote|pre|h[1-6])\b[^>]*>/gi;

/** Markup → text: block tags become a space, inline tags simply vanish. */
function stripTags(html: string): string {
  return html
    .replace(BLOCK_TAG, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Inner XML of the first `<name>` (or `<ns:name>`) element in `block`.
 * Non-greedy, so a repeated element yields its first occurrence.
 */
function pick(block: string, name: string): string | undefined {
  const re = new RegExp(
    `<(?:[a-z0-9]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${name}>`,
    "i",
  );
  return re.exec(block)?.[1];
}

/** An attribute off the first `<name …>` element — Atom's `<link href="…"/>`. */
function pickAttr(block: string, name: string, attr: string): string | undefined {
  const el = new RegExp(`<(?:[a-z0-9]+:)?${name}\\b([^>]*)>`, "i").exec(block)?.[1];
  if (!el) return undefined;
  return new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*)["']`, "i").exec(el)?.[1];
}

/** Inner XML → plain text. */
function text(raw: string | undefined): string {
  return raw === undefined
    ? ""
    : decodeEntities(stripTags(decodeEntities(unwrapCdata(raw)))).trim();
}

/** Inner XML → markup, CDATA unwrapped and escaped markup restored. */
function html(raw: string | undefined): string {
  return raw === undefined ? "" : decodeEntities(unwrapCdata(raw)).trim();
}

function parseDate(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  // RSS uses RFC 822 (`Mon, 02 Feb 2026 09:53:54 -0800`), Atom ISO 8601 —
  // Date.parse reads both.
  const t = Date.parse(text(raw));
  return Number.isNaN(t) ? undefined : t;
}

/** Split a document into its `<entry>` (Atom) or `<item>` (RSS) blocks. */
function blocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  for (const m of xml.matchAll(re)) out.push(m[1]);
  return out;
}

const ordinal = (e: HealthFeedEntry): number =>
  e.publishedAt ? Date.parse(e.publishedAt) : -Infinity;

/**
 * Parse an Atom or RSS document into normalised entries, newest first.
 *
 * `format` defaults to `auto`, which detects the syntax from the payload rather
 * than the URL or content-type — status hosts serve both from paths that do not
 * always say which is which.
 *
 * Never throws: a document that cannot be read yields no entries, so a caller
 * reports "cannot tell" rather than inventing an outage.
 */
export function parseFeed(xml: string, format: HealthFeedFormat = "auto"): HealthFeedEntry[] {
  const isAtom = format === "atom" ||
    (format === "auto" && (/<feed\b/i.test(xml) || /<entry\b/i.test(xml)));
  const raw = isAtom ? blocks(xml, "entry") : blocks(xml, "item");

  const entries: HealthFeedEntry[] = raw.map((block) => {
    // Atom carries the body in <summary> or <content>; RSS in <description>,
    // with <content:encoded> as the richer optional form.
    const body = pick(block, "summary") ?? pick(block, "description") ??
      pick(block, "encoded") ?? pick(block, "content");
    const link = isAtom
      ? pickAttr(block, "link", "href") ?? text(pick(block, "link"))
      : text(pick(block, "link"));
    const id = text(pick(block, "id")) || text(pick(block, "guid")) || link;
    // Atom: <published> is when it started, <updated> when it last changed —
    // for "has anything happened lately" the latter is the honest field.
    const at = parseDate(pick(block, "updated")) ?? parseDate(pick(block, "published")) ??
      parseDate(pick(block, "pubDate")) ?? parseDate(pick(block, "date"));
    return {
      ...(id ? { id } : {}),
      title: text(pick(block, "title")),
      summary: text(body),
      summaryHtml: html(body),
      ...(link ? { link } : {}),
      ...(at !== undefined ? { publishedAt: new Date(at).toISOString() } : {}),
    };
  });

  // Feeds are conventionally newest-first but nothing guarantees it. Undated
  // entries sort last rather than being dropped — they are still evidence.
  return entries.sort((a, b) => ordinal(b) - ordinal(a));
}

/**
 * Fold successive updates down to the newest entry per `id` — the shape a
 * status feed actually describes. Entries with no id are kept as themselves,
 * since there is nothing to fold them onto.
 */
export function latestPerId(entries: readonly HealthFeedEntry[]): HealthFeedEntry[] {
  const newest = new Map<string, HealthFeedEntry>();
  const loose: HealthFeedEntry[] = [];
  for (const e of entries) {
    if (!e.id) {
      loose.push(e);
      continue;
    }
    const seen = newest.get(e.id);
    if (!seen || ordinal(e) > ordinal(seen)) newest.set(e.id, e);
  }
  return [...newest.values(), ...loose].sort((a, b) => ordinal(b) - ordinal(a));
}

/**
 * Text of every `<li>` in a fragment — how feeds list affected components.
 * Exposed because it operates on `summaryHtml`, which only the App knows how to
 * interpret.
 */
export function feedListItems(fragment: string): string[] {
  return [...fragment.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((m) => stripTags(decodeEntities(m[1])).trim())
    .filter(Boolean);
}
