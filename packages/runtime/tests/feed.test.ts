import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.0";
import { feedListItems, latestPerId, parseChannelMeta, parseFeed } from "../src/feed.ts";

/** Trimmed from the live Atom feed at slack-status.com/feed/atom. */
const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <id>https://status.slack.com</id>
  <title>Slack System Status</title>
  <entry>
    <id>https://slack-status.com/2026-01/6f029c99f2b77bcd</id>
    <published>2026-01-30T07:52:19-08:00</published>
    <updated>2026-02-02T09:53:54-08:00</updated>
    <link rel="alternate" type="text/html" href="https://slack-status.com/2026-01/6f029c99f2b77bcd" />
    <title>Incident: Trouble connecting to Salesforce Channels</title>
    <summary>This issue is now resolved.&amp;nbsp;Scope: a &quot;ZC:&quot; prefix appeared.</summary>
  </entry>
  <entry>
    <id>https://slack-status.com/2026-01/aaaa</id>
    <updated>2026-01-10T02:00:00-08:00</updated>
    <title>Notice: Scheduled maintenance</title>
    <summary>Nothing to see.</summary>
  </entry>
</feed>`;

/** Trimmed from the live RSS feed at status.mistral.ai/feed.rss. */
const RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Mistral AI Status Page</title>
    <item>
      <title><![CDATA[Audio API Degraded]]></title>
      <link>https://status.mistral.ai/incident/4c854daa</link>
      <guid isPermaLink="true">https://status.mistral.ai/incident/4c854daa</guid>
      <pubDate>Sun, 26 Jul 2026 02:47:40 GMT</pubDate>
      <description><![CDATA[Status: Resolved<br/>The incident has been resolved<br/><br/>Affected services<ul><li>Audio API</li></ul>]]></description>
    </item>
    <item>
      <title><![CDATA[Audio API Degraded]]></title>
      <link>https://status.mistral.ai/incident/4c854daa</link>
      <guid isPermaLink="true">https://status.mistral.ai/incident/4c854daa</guid>
      <pubDate>Sun, 26 Jul 2026 02:46:53 GMT</pubDate>
      <description><![CDATA[Status: Investigating<br/>Requests are degraded.<br/><br/>Affected services<ul><li>Audio API</li><li>Chat API</li></ul>]]></description>
    </item>
  </channel>
</rss>`;

Deno.test("feed: reads Atom entries", () => {
  const entries = parseFeed(ATOM);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].title, "Incident: Trouble connecting to Salesforce Channels");
  assertEquals(entries[0].id, "https://slack-status.com/2026-01/6f029c99f2b77bcd");
  assertEquals(entries[0].link, "https://slack-status.com/2026-01/6f029c99f2b77bcd");
});

Deno.test("feed: Atom prefers <updated> over <published>", () => {
  // <updated> is 2026-02-02, <published> 2026-01-30 — "last changed" is the question.
  assertEquals(parseFeed(ATOM)[0].publishedAt, "2026-02-02T17:53:54.000Z");
});

Deno.test("feed: decodes entities, including the double-escaped &amp;nbsp;", () => {
  assertEquals(
    parseFeed(ATOM)[0].summary,
    `This issue is now resolved. Scope: a "ZC:" prefix appeared.`,
  );
});

Deno.test("feed: reads RSS items, unwraps CDATA, parses RFC 822 dates", () => {
  const entries = parseFeed(RSS);
  assertEquals(entries.length, 2);
  assertEquals(entries[0].title, "Audio API Degraded");
  assertEquals(entries[0].publishedAt, "2026-07-26T02:47:40.000Z");
});

Deno.test("feed: block tags become a word boundary", () => {
  // Regression: `services<ul><li>Audio API` must not read as "servicesAudio API".
  assertEquals(
    parseFeed(RSS)[0].summary,
    "Status: Resolved The incident has been resolved Affected services Audio API",
  );
});

Deno.test("feed: summaryHtml keeps markup the text form drops", () => {
  const entries = parseFeed(RSS);
  assertEquals(feedListItems(entries[0].summaryHtml), ["Audio API"]);
  assertEquals(feedListItems(entries[1].summaryHtml), ["Audio API", "Chat API"]);
});

Deno.test("feed: an explicit format overrides sniffing", () => {
  // An RSS document read as Atom finds no <entry> blocks — proves the arg is honoured.
  assertEquals(parseFeed(RSS, "atom").length, 0);
  assertEquals(parseFeed(RSS, "rss").length, 2);
});

Deno.test("feed: entries come back newest-first regardless of document order", () => {
  const entries = parseFeed(RSS);
  assertEquals(entries[0].publishedAt! > entries[1].publishedAt!, true);
});

Deno.test("latestPerId: folds successive updates down to one per incident", () => {
  const entries = parseFeed(RSS);
  assertEquals(entries.length, 2, "two updates in the document");
  const incidents = latestPerId(entries);
  assertEquals(incidents.length, 1, "describing one incident");
  // The NEWEST update wins. This is the bug the fold exists to prevent: the
  // title still says "Degraded" while the incident is resolved.
  assertEquals(incidents[0].summary.startsWith("Status: Resolved"), true);
  assertEquals(incidents[0].title, "Audio API Degraded");
});

Deno.test("latestPerId: keeps entries that carry no id", () => {
  const entries = parseFeed(
    `<rss><channel><item><title>a</title></item><item><title>b</title></item></channel></rss>`,
  );
  assertEquals(latestPerId(entries).length, 2);
});

Deno.test("feed: unreadable input yields no entries rather than throwing", () => {
  assertEquals(parseFeed("<!DOCTYPE html><html><body>not a feed</body></html>").length, 0);
  assertEquals(parseFeed("").length, 0);
});

// --- parseChannelMeta (channel-level link/title, not an entry's) -----------

/**
 * Same document as ATOM, plus a genuine channel-level `<link rel="alternate">`
 * placed BEFORE the first `<entry>`. Its own first entry keeps a DIFFERENT
 * link, so a correct scan must return the channel's, never the entry's.
 */
const ATOM_WITH_CHANNEL = `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <id>https://status.slack.com</id>
  <title>Slack System Status</title>
  <link rel="alternate" type="text/html" href="https://slack-status.com" />
  <entry>
    <id>https://slack-status.com/2026-01/6f029c99f2b77bcd</id>
    <published>2026-01-30T07:52:19-08:00</published>
    <updated>2026-02-02T09:53:54-08:00</updated>
    <link rel="alternate" type="text/html" href="https://slack-status.com/2026-01/6f029c99f2b77bcd" />
    <title>Incident: Trouble connecting to Salesforce Channels</title>
    <summary>This issue is now resolved.</summary>
  </entry>
</feed>`;

/** Same shape as RSS, plus a genuine `<channel><link>`. */
const RSS_WITH_CHANNEL = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Mistral AI Status Page</title>
    <link>https://status.mistral.ai</link>
    <item>
      <title><![CDATA[Audio API Degraded]]></title>
      <link>https://status.mistral.ai/incident/4c854daa</link>
      <guid isPermaLink="true">https://status.mistral.ai/incident/4c854daa</guid>
      <pubDate>Sun, 26 Jul 2026 02:47:40 GMT</pubDate>
    </item>
  </channel>
</rss>`;

Deno.test("parseChannelMeta: ATOM's trap — no channel <link>, only a per-entry one", () => {
  // The existing ATOM fixture has no channel-level <link>, only its first
  // entry's. A whole-document scan would wrongly return the entry's URL.
  const channel = parseChannelMeta(ATOM);
  assertEquals(channel.link, undefined);
  assertEquals(channel.title, "Slack System Status");
});

Deno.test("parseChannelMeta: reads Atom's channel-level <link rel=alternate>, not the entry's", () => {
  const channel = parseChannelMeta(ATOM_WITH_CHANNEL);
  assertEquals(channel.link, "https://slack-status.com");
  assertNotEquals(channel.link, "https://slack-status.com/2026-01/6f029c99f2b77bcd");
});

Deno.test("parseChannelMeta: RSS's trap — no <channel><link>, only a per-item one", () => {
  const channel = parseChannelMeta(RSS);
  assertEquals(channel.title, "Mistral AI Status Page");
  assertEquals(channel.link, undefined);
});

Deno.test("parseChannelMeta: reads RSS's <channel><link>", () => {
  const channel = parseChannelMeta(RSS_WITH_CHANNEL);
  assertEquals(channel.link, "https://status.mistral.ai");
  assertEquals(channel.title, "Mistral AI Status Page");
});

Deno.test("parseChannelMeta: a document with no channel elements returns {} without throwing", () => {
  assertEquals(
    parseChannelMeta(`<rss><channel><item><title>x</title></item></channel></rss>`),
    {},
  );
  assertEquals(parseChannelMeta(""), {});
});

// --- ROUND 2: Atom `rel="alternate"` selection, order-independent --------
//
// Round 1's `parseChannelMeta` picked whichever `<link>` came first in the
// preamble, unconditionally. A preamble commonly carries a `rel="self"`
// link (the feed document's own URL — self-referencing is conventional)
// alongside the true `rel="alternate"` status page, in either order. These
// fixtures pin that the selection is driven by `rel`, not position.

/**
 * `rel="self"` FIRST, `rel="alternate"` SECOND — round 1's bug returns the
 * self href here.
 */
const ATOM_SELF_THEN_ALTERNATE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <id>https://status.slack.com</id>
  <title>Slack System Status</title>
  <link rel="self" href="https://slack-status.com/feed/atom" />
  <link rel="alternate" type="text/html" href="https://slack-status.com" />
  <entry>
    <id>https://slack-status.com/2026-01/6f029c99f2b77bcd</id>
    <link rel="alternate" type="text/html" href="https://slack-status.com/2026-01/6f029c99f2b77bcd" />
    <title>Incident: Trouble connecting to Salesforce Channels</title>
  </entry>
</feed>`;

/**
 * Same two `<link>`s, reordered — `rel="alternate"` FIRST, `rel="self"`
 * SECOND. Proves the preference is genuinely `rel`-driven rather than a
 * first-wins accident that happens to look right on the fixture above.
 */
const ATOM_ALTERNATE_THEN_SELF = `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <id>https://status.slack.com</id>
  <title>Slack System Status</title>
  <link rel="alternate" type="text/html" href="https://slack-status.com" />
  <link rel="self" href="https://slack-status.com/feed/atom" />
  <entry>
    <id>https://slack-status.com/2026-01/6f029c99f2b77bcd</id>
    <link rel="alternate" type="text/html" href="https://slack-status.com/2026-01/6f029c99f2b77bcd" />
    <title>Incident: Trouble connecting to Salesforce Channels</title>
  </entry>
</feed>`;

/**
 * A preamble carrying only ONE `<link>`, and it is not `rel="alternate"` —
 * the pre-round-2 fallback ("first `<link href=…>`, whatever its `rel`")
 * must still fire when no alternate-rel element exists at all.
 */
const ATOM_SINGLE_NON_ALTERNATE_LINK = `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <id>https://status.slack.com</id>
  <title>Slack System Status</title>
  <link rel="self" href="https://slack-status.com/feed/atom" />
  <entry>
    <id>https://slack-status.com/2026-01/6f029c99f2b77bcd</id>
    <title>Incident: Trouble connecting to Salesforce Channels</title>
  </entry>
</feed>`;

/**
 * THREE `<link>`s, TWO of them `rel="alternate"` with different hrefs —
 * breaks the tie between "prefer the FIRST rel=alternate" and "prefer the
 * LAST rel=alternate". None of the two-link fixtures above can tell those
 * two implementations apart (each has only one alternate-rel link), so a
 * mutant that matches by `rel` correctly but picks the wrong one of several
 * would otherwise pass every case above undetected.
 */
const ATOM_TWO_ALTERNATES = `<?xml version="1.0" encoding="UTF-8"?>
<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom">
  <id>https://status.slack.com</id>
  <title>Slack System Status</title>
  <link rel="self" href="https://slack-status.com/feed/atom" />
  <link rel="alternate" type="text/html" href="https://slack-status.com/first-alt" />
  <link rel="alternate" type="text/html" href="https://slack-status.com/second-alt" />
  <entry>
    <id>https://slack-status.com/2026-01/6f029c99f2b77bcd</id>
    <title>Incident: Trouble connecting to Salesforce Channels</title>
  </entry>
</feed>`;

Deno.test("parseChannelMeta: prefers rel=alternate over a preceding rel=self", () => {
  const channel = parseChannelMeta(ATOM_SELF_THEN_ALTERNATE);
  assertEquals(channel.link, "https://slack-status.com");
  assertNotEquals(channel.link, "https://slack-status.com/feed/atom");
});

Deno.test("parseChannelMeta: rel=alternate preference is order-independent", () => {
  const channel = parseChannelMeta(ATOM_ALTERNATE_THEN_SELF);
  assertEquals(channel.link, "https://slack-status.com");
  assertNotEquals(channel.link, "https://slack-status.com/feed/atom");
});

Deno.test("parseChannelMeta: falls back to the only <link> when no rel=alternate exists", () => {
  const channel = parseChannelMeta(ATOM_SINGLE_NON_ALTERNATE_LINK);
  assertEquals(channel.link, "https://slack-status.com/feed/atom");
});

Deno.test("parseChannelMeta: among two rel=alternate links, the first wins", () => {
  const channel = parseChannelMeta(ATOM_TWO_ALTERNATES);
  assertEquals(channel.link, "https://slack-status.com/first-alt");
  assertNotEquals(channel.link, "https://slack-status.com/second-alt");
});
