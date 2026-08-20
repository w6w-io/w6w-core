import { assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import {
  applyOverrides,
  deepMerge,
  mergeValue,
  parseOverrideKey,
  parseOverridePath,
  selectsRequest,
  setPath,
  W6WError,
} from "../mod.ts";
import type { RequestOverrides, SignableRequest } from "@w6w/types";

function req(over: Partial<SignableRequest> = {}): SignableRequest {
  return {
    url: "https://api.example.com/v1/things",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "a", nested: { keep: 1, over: 1 } }),
    ...over,
  };
}

/** The body SendGrid's `mail-send` actually builds — an array-shaped payload. */
function sendgridReq(): SignableRequest {
  return req({
    url: "https://api.sendgrid.com/v3/mail/send",
    body: JSON.stringify({
      personalizations: [{ to: [{ email: "customer@example.com" }] }],
      from: { email: "ops@acme.com" },
      subject: "Your order shipped",
      content: [{ type: "text/plain", value: "It's on the way." }],
    }),
  });
}

// ── Path parsing ───────────────────────────────────────────────────────────

Deno.test("parseOverridePath: a plain field name is one key segment", () => {
  assertEquals(parseOverridePath("subject"), [{ kind: "key", key: "subject" }]);
});

Deno.test("parseOverridePath: dots and indices become segments", () => {
  assertEquals(parseOverridePath("personalizations[0].cc"), [
    { kind: "key", key: "personalizations" },
    { kind: "index", index: 0 },
    { kind: "key", key: "cc" },
  ]);
  assertEquals(parseOverridePath("a.b.c"), [
    { kind: "key", key: "a" },
    { kind: "key", key: "b" },
    { kind: "key", key: "c" },
  ]);
  assertEquals(parseOverridePath("m[1][2]"), [
    { kind: "key", key: "m" },
    { kind: "index", index: 1 },
    { kind: "index", index: 2 },
  ]);
});

Deno.test("parseOverrideKey: a trailing `!` is the replace marker, escapable", () => {
  assertEquals(parseOverrideKey("categories!"), {
    segments: [{ kind: "key", key: "categories" }],
    replace: true,
  });
  assertEquals(parseOverrideKey("categories"), {
    segments: [{ kind: "key", key: "categories" }],
    replace: false,
  });
  // A vendor field whose own name ends in `!` stays reachable.
  assertEquals(parseOverrideKey("loud\\!"), {
    segments: [{ kind: "key", key: "loud!" }],
    replace: false,
  });
  assertEquals(parseOverrideKey("a[0].b!").replace, true);
});

Deno.test("parseOverridePath: a backslash escapes a literal dot", () => {
  // The rare vendor field whose own name carries a dot stays reachable.
  assertEquals(parseOverridePath("a\\.b"), [{ kind: "key", key: "a.b" }]);
});

Deno.test("parseOverridePath: a malformed path throws rather than becoming a literal key", () => {
  // Quietly setting a field called `items[` would produce a request the caller
  // never asked for and cannot see.
  for (const bad of ["items[", "items[x]", "a..b", "a]", "trailing\\"]) {
    assertThrows(() => parseOverridePath(bad), W6WError);
  }
});

// ── setPath ────────────────────────────────────────────────────────────────

Deno.test("setPath: sets one leaf and touches nothing else", () => {
  const root: Record<string, unknown> = {
    personalizations: [{ to: [{ email: "a@x.com" }] }],
    subject: "s",
  };
  setPath(root, parseOverridePath("personalizations[0].cc"), [{ email: "cc@x.com" }], "…");
  assertEquals(root, {
    personalizations: [{ to: [{ email: "a@x.com" }], cc: [{ email: "cc@x.com" }] }],
    subject: "s",
  });
});

Deno.test("setPath: creates intermediate containers of the right kind", () => {
  const root: Record<string, unknown> = {};
  setPath(root, parseOverridePath("a.b.c"), 1, "…");
  setPath(root, parseOverridePath("list[0].x"), 2, "…");
  assertEquals(root, { a: { b: { c: 1 } }, list: [{ x: 2 }] });
});

Deno.test("setPath: appending at the end is allowed, a gap is refused", () => {
  const root: Record<string, unknown> = { list: [{ a: 1 }] };
  setPath(root, parseOverridePath("list[1]"), { a: 2 }, "list[1]");
  assertEquals(root.list, [{ a: 1 }, { a: 2 }]);
  // Padding the gap with nulls would send a body the caller never wrote.
  const err = assertThrows(
    () => setPath(root, parseOverridePath("list[9]"), {}, "list[9]"),
    W6WError,
  );
  assertEquals(err.message.includes("2 elements"), true);
});

Deno.test("setPath: a type mismatch names the path and what was found", () => {
  const root: Record<string, unknown> = { subject: "a string" };
  const err = assertThrows(
    () => setPath(root, parseOverridePath("subject.nested"), 1, "subject.nested"),
    W6WError,
  );
  assertEquals(err.message.includes("subject.nested"), true);
  assertEquals(err.message.includes("a string"), true);
});

// ── deepMerge ──────────────────────────────────────────────────────────────

Deno.test("deepMerge: patch wins, siblings survive, nested objects merge", () => {
  assertEquals(
    deepMerge({ a: 1, n: { x: 1, y: 2 } }, { a: 2, n: { y: 3, z: 4 } }),
    { a: 2, n: { x: 1, y: 3, z: 4 } },
  );
});

Deno.test("mergeValue: arrays merge INDEX-WISE, so a neighbour is never lost", () => {
  // The rule the whole design turns on: an override lands on top of what the
  // flow configured, and must not negate it.
  assertEquals(
    mergeValue([{ to: ["a@x.com"] }], [{ cc: ["c@x.com"] }]),
    [{ to: ["a@x.com"], cc: ["c@x.com"] }],
  );
});

Deno.test("mergeValue: an index the base has and the patch does not is kept", () => {
  assertEquals(mergeValue([{ a: 1 }, { b: 2 }], [{ a: 9 }]), [{ a: 9 }, { b: 2 }]);
});

Deno.test("mergeValue: an index past the base's end is appended", () => {
  assertEquals(mergeValue([{ a: 1 }], [{ a: 1 }, { b: 2 }]), [{ a: 1 }, { b: 2 }]);
});

Deno.test("mergeValue: a scalar list merges positionally, and the tail survives", () => {
  // The documented cost of never negating: a plain override cannot SHORTEN a
  // list. `!` is the opt-out, covered below.
  assertEquals(mergeValue(["a", "b"], ["c"]), ["c", "b"]);
});

Deno.test("mergeValue: a type change takes the patch, there being nothing to merge", () => {
  assertEquals(mergeValue({ a: 1 }, ["x"]), ["x"]);
  assertEquals(mergeValue(["x"], "plain"), "plain");
  assertEquals(mergeValue(undefined, { a: 1 }), { a: 1 });
});

// ── The case this feature exists for ───────────────────────────────────────

Deno.test("adding CC keeps the recipients the flow configured — BOTH key forms", () => {
  // The case this whole feature exists for. SendGrid keeps CC inside
  // `personalizations[0]`, so an override adding it sits right beside the `to`
  // the action built from the step's config. Neither form may lose it.
  const expected = [{
    to: [{ email: "customer@example.com" }],
    cc: [{ email: "cc1@example.com" }],
  }];
  const cc = [{ email: "cc1@example.com" }];

  const viaPlain = applyOverrides(sendgridReq(), { body: { personalizations: [{ cc }] } });
  assertEquals(JSON.parse(viaPlain.body!).personalizations, expected);

  const viaPath = applyOverrides(sendgridReq(), { body: { "personalizations[0].cc": cc } });
  assertEquals(JSON.parse(viaPath.body!).personalizations, expected);

  // ...and everything else the action built is untouched either way.
  assertEquals(JSON.parse(viaPlain.body!).subject, "Your order shipped");
  assertEquals(JSON.parse(viaPath.body!).content, [
    { type: "text/plain", value: "It's on the way." },
  ]);
});

Deno.test("`!` replaces outright — the only way to discard what the action built", () => {
  const out = applyOverrides(sendgridReq(), {
    body: { "personalizations!": [{ to: [{ email: "someone-else@example.com" }] }] },
  });
  // No `to` from the original survives: that is the instruction `!` carries.
  assertEquals(JSON.parse(out.body!).personalizations, [{
    to: [{ email: "someone-else@example.com" }],
  }]);
});

Deno.test("`!` on a path replaces just that leaf", () => {
  const out = applyOverrides(sendgridReq(), {
    body: { "personalizations[0].to!": [{ email: "only@example.com" }] },
  });
  assertEquals(JSON.parse(out.body!).personalizations, [{ to: [{ email: "only@example.com" }] }]);
});

// ── Body merging ───────────────────────────────────────────────────────────

Deno.test("applyOverrides: plain keys deep-merge into the JSON body", () => {
  const out = applyOverrides(req(), { body: { added: true, nested: { over: 2 } } });
  assertEquals(JSON.parse(out.body!), { name: "a", nested: { keep: 1, over: 2 }, added: true });
});

Deno.test("applyOverrides: a path MERGES into what is already at that leaf", () => {
  // A path names a place, not a replacement — `!` is what means replacement.
  const out = applyOverrides(req(), { body: { "nested.deeper": { x: 1 } } });
  assertEquals(JSON.parse(out.body!).nested, { keep: 1, over: 1, deeper: { x: 1 } });
});

Deno.test("applyOverrides: a path is applied after a plain key naming the same leaf", () => {
  // Fixed order — paths after plain — rather than an object-key-order accident.
  const out = applyOverrides(req(), { body: { nested: { over: 2 }, "nested.over": 9 } });
  assertEquals(JSON.parse(out.body!).nested, { keep: 1, over: 9 });
});

Deno.test("applyOverrides: the request is copied, never mutated", () => {
  const original = sendgridReq();
  const before = JSON.stringify(original);
  applyOverrides(original, { body: { "personalizations[0].cc": [{ email: "c@x.com" }] } });
  assertEquals(JSON.stringify(original), before);
});

Deno.test("applyOverrides: a non-object JSON body is left alone", () => {
  for (const body of ["[1,2,3]", '"a string"', "not json at all"]) {
    assertEquals(applyOverrides(req({ body }), { body: { extra: true } }).body, body);
  }
});

Deno.test("applyOverrides: overrides become the body when the action sent none", () => {
  const out = applyOverrides(req({ body: null, headers: {} }), { body: { only: 1 } });
  assertEquals(JSON.parse(out.body!), { only: 1 });
  assertEquals(out.headers["content-type"], "application/json");
});

Deno.test("applyOverrides: a GET with no body stays bodiless", () => {
  const out = applyOverrides(req({ method: "GET", body: null, headers: {} }), {
    body: { ignored: 1 },
  });
  assertEquals(out.body, null);
});

// ── Form bodies ────────────────────────────────────────────────────────────

function formReq(body = "From=%2B1&Body=hi"): SignableRequest {
  return req({ headers: { "content-type": "application/x-www-form-urlencoded" }, body });
}

Deno.test("applyOverrides: the same `body` field merges a form body, arrays repeating", () => {
  // One `body` for both encodings — the merge knows which one the request uses.
  const out = applyOverrides(formReq(), {
    body: { MediaUrl: ["https://x/a.jpg", "https://x/b.jpg"], Body: "replaced" },
  });
  const p = new URLSearchParams(out.body!);
  assertEquals(p.get("From"), "+1");
  assertEquals(p.get("Body"), "replaced");
  assertEquals(p.getAll("MediaUrl"), ["https://x/a.jpg", "https://x/b.jpg"]);
});

Deno.test("applyOverrides: a path or an object against a form body is refused", () => {
  // Form encoding is flat and carries only text, so both are unrepresentable —
  // said out loud rather than silently stringified to "[object Object]".
  assertThrows(() => applyOverrides(formReq(), { body: { "a.b": 1 } }), W6WError);
  assertThrows(() => applyOverrides(formReq(), { body: { a: { b: 1 } } }), W6WError);
});

// ── Query, headers, and the boundaries ─────────────────────────────────────

Deno.test("applyOverrides: query params are set, and null deletes one", () => {
  const out = applyOverrides(req({ url: "https://api.example.com/v1/things?limit=10&drop=me" }), {
    query: { limit: 50, extra: "x", drop: null },
  });
  const u = new URL(out.url);
  assertEquals(u.searchParams.get("limit"), "50");
  assertEquals(u.searchParams.get("extra"), "x");
  assertEquals(u.searchParams.get("drop"), null);
});

Deno.test("applyOverrides: host and path are untouchable", () => {
  // The app's egress allowlist is the boundary; an override must not be able to
  // redirect a signed, credentialed request at a host of the caller's choosing.
  const out = applyOverrides(req(), {
    query: { x: "1" },
    headers: { host: "evil.example.com" },
  });
  const u = new URL(out.url);
  assertEquals(u.host, "api.example.com");
  assertEquals(u.pathname, "/v1/things");
});

Deno.test("applyOverrides: a header replaces case-insensitively", () => {
  const out = applyOverrides(
    req({ headers: { "Content-Type": "application/json", "X-Keep": "1" } }),
    { headers: { "content-type": "application/vnd.api+json" } },
  );
  const keys = Object.keys(out.headers).filter((k) => k.toLowerCase() === "content-type");
  assertEquals(keys.length, 1, "must not carry two spellings of one header");
  assertEquals(out.headers[keys[0]], "application/vnd.api+json");
  assertEquals(out.headers["X-Keep"], "1");
});

// ── Target selection ───────────────────────────────────────────────────────

Deno.test("selectsRequest: `first` (the default) selects only request 0", () => {
  const o: RequestOverrides = {};
  assertEquals(selectsRequest(o, req(), { index: 0, writeIndex: 0 }), true);
  assertEquals(selectsRequest(o, req(), { index: 1, writeIndex: 1 }), false);
});

Deno.test("selectsRequest: `first-write` skips the lookups an action does first", () => {
  const o: RequestOverrides = { target: "first-write" };
  assertEquals(selectsRequest(o, req({ method: "GET" }), { index: 0, writeIndex: 0 }), false);
  assertEquals(selectsRequest(o, req(), { index: 1, writeIndex: 0 }), true);
  assertEquals(selectsRequest(o, req(), { index: 2, writeIndex: 1 }), false);
});

Deno.test("selectsRequest: `all` selects every request, `match` narrows by URL", () => {
  assertEquals(selectsRequest({ target: "all" }, req(), { index: 7, writeIndex: 3 }), true);
  const m: RequestOverrides = { target: "all", match: "/v1/things" };
  assertEquals(selectsRequest(m, req(), { index: 0, writeIndex: 0 }), true);
  assertEquals(
    selectsRequest(m, req({ url: "https://api.example.com/v1/other" }), {
      index: 0,
      writeIndex: 0,
    }),
    false,
  );
});
