import { assert, assertEquals, assertFalse } from "jsr:@std/assert@^1.0.0";
import {
  appDeclaresProtocol,
  isProtocolTrigger,
  parseAppArtifactManifest,
  protocolDeclarationErrors,
  protocolEventType,
} from "../mod.ts";
import type { ProtocolManifest, Trigger } from "../mod.ts";

const OK_BLOCK: ProtocolManifest = {
  baseUrl: "https://partner.example.test/api",
  jwksUrl: "https://partner.example.test/.well-known/w6w-jwks.json",
  versions: [1],
};
const manifest = (over: Record<string, unknown> = {}) => ({
  protocol: OK_BLOCK,
  network: { allow: ["partner.example.test"] },
  ...over,
});
const one: Trigger = {
  key: "order-placed",
  title: "Order placed",
  delivery: "w6w-protocol",
  protocol: { events: ["order.placed"] },
};
const two: Trigger = {
  key: "guest-event",
  title: "Guest event",
  delivery: "w6w-protocol",
  protocol: { events: ["a.x", "a.y"] },
  params: [{
    key: "eventType",
    label: "Event",
    type: "select",
    options: [{ value: "a.x", label: "X" }, { value: "a.y", label: "Y" }],
  }],
};
const errs = (m: Record<string, unknown>, ts: Array<[Trigger, string[]?]> = []) =>
  protocolDeclarationErrors(m, ts.map(([trigger, hooks]) => ({ trigger, hooks: hooks ?? [] })));

Deno.test("isProtocolTrigger: delivery OR a pre-derived type", () => {
  assert(isProtocolTrigger({ delivery: "w6w-protocol" }));
  assert(isProtocolTrigger({ type: "protocol" })); // m1: delivery-only read fails here
  assertFalse(isProtocolTrigger({ type: "webhook" }));
  assertFalse(isProtocolTrigger({}));
});

Deno.test("appDeclaresProtocol: block OR any protocol trigger", () => {
  assert(appDeclaresProtocol({ protocol: OK_BLOCK }, []));
  assert(appDeclaresProtocol({}, [{ type: "webhook" }, { delivery: "w6w-protocol" }]));
  assertFalse(appDeclaresProtocol({}, [{ type: "poll" }]));
});

Deno.test("a clean declaration has no errors", () => {
  assertEquals(errs(manifest(), [[one], [two]]), []);
});

Deno.test("host must appear literally in network.allow (m2)", () => {
  const evil = manifest({
    protocol: { ...OK_BLOCK, baseUrl: "https://api.example.test.evil.test" },
    network: { allow: ["partner.example.test", "api.example.test"] },
  });
  assert(errs(evil).some((e) => e.includes("baseUrl") && e.includes("network.allow")));
  for (const allow of [["*"], ["*.example.test"], ["example.test"], []]) {
    assert(errs(manifest({ network: { allow } })).length >= 2, `allow ${allow}`);
  }
  // case-insensitive equality is fine
  assertEquals(errs(manifest({ network: { allow: ["PARTNER.Example.test"] } })), []);
});

Deno.test("https required; http only for a loopback literal (m5)", () => {
  const withUrl = (u: string, allow: string[]) =>
    manifest({
      protocol: { ...OK_BLOCK, baseUrl: u },
      network: { allow: [...allow, "partner.example.test"] },
    });
  assert(errs(withUrl("http://partner.example.test", []))[0].includes("https"));
  assertEquals(errs(withUrl("http://127.0.0.1:8080", ["127.0.0.1"])), []);
  assertEquals(errs(withUrl("http://localhost:1", ["localhost"])), []);
  assertEquals(errs(withUrl("http://[::1]:1", ["[::1]"])), []);
  assert(errs(withUrl("http://127.0.0.1.evil.test", ["127.0.0.1.evil.test"])).length > 0);
  assert(errs(withUrl("ftp://partner.example.test", [])).length > 0);
});

Deno.test("no userinfo, query, fragment; must parse", () => {
  for (
    const u of [
      "https://u:p@partner.example.test",
      "https://partner.example.test/?a=1",
      "https://partner.example.test/#f",
      "https://partner.example.test?",
      "not a url",
    ]
  ) {
    assert(
      errs(manifest({ protocol: { ...OK_BLOCK, jwksUrl: u } })).length > 0,
      u,
    );
  }
});

Deno.test("versions: non-empty integer array containing 1", () => {
  for (const versions of [[], [2], [1.5, 1], "1", undefined]) {
    assert(
      errs(manifest({ protocol: { ...OK_BLOCK, versions } })).some((e) => e.includes("versions")),
    );
  }
  assertEquals(errs(manifest({ protocol: { ...OK_BLOCK, versions: [1, 2] } })), []);
});

Deno.test("trigger rules: block present, delivery exact, events, hooks, eventType select", () => {
  // no app block
  assert(errs({}, [[one]]).some((e) => e.includes("no `protocol` block")));
  // type protocol without delivery
  const noDelivery = { ...one, delivery: undefined, type: "protocol" as const };
  assert(errs(manifest(), [[noDelivery]]).some((e) => e.includes("`delivery`")));
  // events
  for (const events of [[], [""], [1], undefined]) {
    const t = { ...one, protocol: { events } } as unknown as Trigger;
    assert(errs(manifest(), [[t]]).some((e) => e.includes("protocol.events")));
  }
  // forbidden hooks (m4)
  for (const h of ["onSubscribe", "onUnsubscribe", "poll"]) {
    assert(errs(manifest(), [[one, [h]]]).some((e) => e.includes(h)), h);
  }
  assertEquals(errs(manifest(), [[one, ["parseOutput"]]]), []);
  // several events need the select (m6)
  const bare = { ...two, params: [] };
  assert(errs(manifest(), [[bare]]).some((e) => e.includes("eventType")));
  const wrongType = { ...two, params: [{ ...two.params![0], type: "string" as const }] };
  assert(errs(manifest(), [[wrongType]]).some((e) => e.includes("eventType")));
  const stray = {
    ...two,
    params: [{ ...two.params![0], options: [{ value: "b.z", label: "Z" }] }],
  };
  assert(errs(manifest(), [[stray]]).some((e) => e.includes("subset")));
});

Deno.test("protocolEventType (m7)", () => {
  assertEquals(protocolEventType(one, undefined), "order.placed");
  assertEquals(protocolEventType(one, { eventType: "other" }), "order.placed");
  assertEquals(protocolEventType(two, { eventType: "a.y" }), "a.y");
  assertEquals(protocolEventType(two, { eventType: "not.listed" }), undefined);
  assertEquals(protocolEventType(two, {}), undefined);
  assertEquals(protocolEventType(two, { eventType: 3 }), undefined);
  assertEquals(protocolEventType({}, {}), undefined);
});

Deno.test("artifact arm keeps the declaration byte-equal (A4)", () => {
  const H = "a".repeat(64);
  const art = {
    artifactVersion: 1,
    id: "io.w6w.x",
    version: "1.0.0",
    manifest: { id: "io.w6w.x", version: "1.0.0", name: "x", ...manifest() },
    actions: [],
    auth: [],
    healthChecks: [],
    triggers: [{ trigger: one, hooks: [] }, { trigger: two, hooks: ["parseOutput"] }],
    interfaces: [],
    exec: { sha256: H, bytes: 10, format: "esm" },
    sourceDigest: H,
    buildInfo: { builder: "b", denoVersion: "2.8.2", minify: false, sourcemap: false },
  };
  const text = JSON.stringify(art);
  const r = parseAppArtifactManifest(JSON.parse(text));
  assert(r.ok);
  assertEquals(JSON.stringify(r.value), text);
  assertEquals(r.value.manifest.protocol, OK_BLOCK);
  assertEquals(r.value.triggers[1].trigger.delivery, "w6w-protocol");
});
