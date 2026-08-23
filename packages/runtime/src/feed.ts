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

/**
 * An attribute value out of an already-captured attribute string (one element's ` rel="…"
 * href="…"` span). Factored out of `pickAttr` so a caller that needs to inspect more than one
 * element of a kind — `parseChannelMeta`'s `rel`-preference among several `<link>`s — reads the
 * same attribute pattern without re-deriving it.
 */
function attrValue(attrs: string, attr: string): string | undefined {
  return new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs)?.[1];
}

/** An attribute off the first `<name …>` element — Atom's `<link href="…"/>`. */
function pickAttr(block: string, name: string, attr: string): string | undefined {
  const el = new RegExp(`<(?:[a-z0-9]+:)?${name}\\b([^>]*)>`, "i").exec(block)?.[1];
  return el === undefined ? undefined : attrValue(el, attr);
}

/**
 * Attribute strings for EVERY `<name …>` element in `block`, in document order — the same
 * element-open pattern `pickAttr` matches once, extended to every occurrence via the `g` flag.
 * Exists so `parseChannelMeta` can choose among several `<link>` elements by their `rel`
 * attribute instead of only ever seeing the first one `pickAttr` would return.
 */
function pickAllAttrs(block: string, name: string): string[] {
  const re = new RegExp(`<(?:[a-z0-9]+:)?${name}\\b([^>]*)>`, "gi");
  return [...block.matchAll(re)].map((m) => m[1]);
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
 * Channel-level metadata a status feed states about itself — Atom's `<link
 * rel="alternate">`/`<title>` at the feed root, RSS's `<channel><link>`/
 * `<channel><title>` — i.e. the vendor's own status PAGE, distinct from this
 * feed document's own URL. This exists because `HealthFeedInput.channelLink`
 * is the FIRST source a host tries when assembling a check's status-page
 * link, ahead of `check.network.allow[0]` (rfcs/healthcheck.md § "Feed-backed
 * checks").
 *
 * Scoped to the document's PREAMBLE — everything before the first `<entry>`
 * (Atom) or `<item>` (RSS). This is the whole correctness content of the
 * function: an entry carries its own per-incident `<link>`/`<title>` in
 * exactly the shape the channel's does, so a whole-document scan would
 * silently return the newest INCIDENT's link instead of the channel's — the
 * same "log of updates, not current state" trap `latestPerId` exists to
 * resolve one level up, except here there is no fold to fall back on: a wrong
 * channel link is just wrong.
 *
 * Reuses `pick`/`pickAttr`/`pickAllAttrs`/`attrValue` against the preamble
 * slice rather than a bespoke scan — the slice is what makes that reuse safe
 * (every `<link>`/`<title>` found in it IS the channel's, never an entry's).
 *
 * Never throws, matching `parseFeed`'s own contract: a document stating
 * neither element yields `{}`.
 */
export function parseChannelMeta(xml: string): { link?: string; title?: string } {
  const cut = xml.search(/<(?:entry|item)\b/i);
  const head = cut === -1 ? xml : xml.slice(0, cut);
  const isAtom = /<feed\b/i.test(head);

  // Atom: a channel preamble commonly carries MORE than one <link> — a
  // self-referencing `rel="self"` (the feed document's own URL) is
  // conventional alongside `rel="alternate"` (the vendor's status PAGE), and
  // nothing guarantees `alternate` comes first in document order. So this
  // must select BY `rel`, not by position: scan every <link> in the
  // preamble for one whose `rel` is exactly "alternate" and prefer ITS href;
  // only when no such element exists does it fall back to the first <link
  // href=…> found (whatever its `rel`, or none), then to a text body for the
  // minimal feeds that carry only one <link>. RSS has no `href` attribute at
  // all, so its channel link is always text.
  const alternate = isAtom
    ? pickAllAttrs(head, "link").find((el) => attrValue(el, "rel") === "alternate")
    : undefined;
  const link = isAtom
    ? (alternate ? attrValue(alternate, "href") : pickAttr(head, "link", "href")) ??
      text(pick(head, "link"))
    : text(pick(head, "link"));
  const title = text(pick(head, "title"));

  return {
    ...(link ? { link } : {}),
    ...(title ? { title } : {}),
  };
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
