import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { capabilitySummary, capabilityWidens } from "../mod.ts";

const base = {
  network: { allow: ["API.Example.com"] },
  auth: [{ type: "oauth2", oauth2: { scopes: ["read"] } }],
  triggers: [{ type: "poll" }],
};

Deno.test("summary normalizes and folds protocol hosts", () => {
  const s = capabilitySummary({
    ...base,
    network: { allow: ["b.com", "A.com", "b.com"] },
    protocol: { baseUrl: "https://P.example.org/x", jwksUrl: "https://p.example.org/jwks" },
    capabilities: { socket: true },
    triggers: [{ delivery: "w6w-protocol" }, {}],
  });
  assertEquals(s.hosts, ["a.com", "b.com", "p.example.org"]);
  assertEquals(s.triggers, [{ kind: "protocol" }, { kind: "webhook" }]);
  assertEquals(s.sockets, true);
});

Deno.test("host added", () => {
  const r = capabilityWidens(base, { ...base, network: { allow: ["api.example.com", "x.com"] } });
  assertEquals(r, ["host added: x.com"]);
});
Deno.test("scope added", () => {
  const r = capabilityWidens(base, {
    ...base,
    auth: [{ type: "oauth2", oauth2: { scopes: ["read", "write"] } }],
  });
  assertEquals(r, ["scope added: oauth2 write"]);
});
Deno.test("new auth type", () => {
  const r = capabilityWidens(base, { ...base, auth: [...base.auth, { type: "apiKey" }] });
  assertEquals(r, ["auth type added: apiKey"]);
});
Deno.test("new webhook trigger", () => {
  const r = capabilityWidens(base, { ...base, triggers: [{ type: "poll" }, { type: "webhook" }] });
  assertEquals(r, ["trigger kind added: webhook"]);
});
Deno.test("socket added", () => {
  assertEquals(capabilityWidens(base, { ...base, capabilities: { socket: true } }), [
    "socket capability added",
  ]);
});
Deno.test("no change / narrowing → []", () => {
  assertEquals(capabilityWidens(base, base), []);
  assertEquals(capabilityWidens(base, { network: { allow: [] } }), []);
  assertEquals(capabilityWidens(capabilitySummary(base), capabilitySummary(base)), []);
});

Deno.test("serviceAccount scope added widens", () => {
  const sa = (scopes: string[]) => ({
    ...base,
    auth: [{ type: "serviceAccount", serviceAccount: { scopes } }],
  });
  assertEquals(capabilityWidens(sa(["a"]), sa(["a", "b"])), ["scope added: serviceAccount b"]);
  assertEquals(capabilityWidens(sa(["a", "b"]), sa(["a"])), []);
});

Deno.test("healthCheck host added widens", () => {
  const hc = (allow: string[]) => ({ ...base, healthChecks: [{ network: { allow } }] });
  assertEquals(capabilityWidens(hc(["a.com"]), hc(["a.com", "H.com"])), ["host added: h.com"]);
  assertEquals(capabilitySummary(hc(["z.com"])).hosts, ["api.example.com", "z.com"]);
});
