import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { egressFailure, egressInfo, REDACTED } from "../src/egress.ts";
import type { SignableRequest } from "@w6w/types";
import type { WireResponse } from "../src/sandbox/protocol.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function req(overrides: Partial<SignableRequest> = {}): SignableRequest {
  return {
    url: "https://api.example.com/v3/mail/send",
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-live-123" },
    body: JSON.stringify({ subject: "hi", api_key: "sk-live-123" }),
    ...overrides,
  };
}

function res(overrides: Partial<WireResponse> = {}): WireResponse {
  return {
    status: 202,
    statusText: "Accepted",
    headers: { "x-message-id": "mid-1" },
    body: enc('{"ok":true}'),
    ...overrides,
  };
}

Deno.test("egressInfo without capture returns only the metering fields", () => {
  const info = egressInfo(req(), res(), { durationMs: 12 });
  assertEquals(info, {
    host: "api.example.com",
    method: "POST",
    status: 202,
    responseBytes: 11,
    durationMs: 12,
  });
});

Deno.test("egressInfo with capture includes request/response detail", () => {
  const info = egressInfo(req(), res(), { capture: true, durationMs: 5 });
  assertEquals(info.url, "https://api.example.com/v3/mail/send");
  assertEquals(info.requestHeaders?.["content-type"], "application/json");
  assertEquals(info.responseHeaders?.["x-message-id"], "mid-1");
  assertEquals(info.responseBody, '{"ok":true}');
  assert(info.requestBody?.includes('"subject":"hi"'));
});

Deno.test("capture redacts credential headers, query params and body fields", () => {
  const info = egressInfo(
    req({ url: "https://api.example.com/send?api_key=sk-live-123&page=2" }),
    res(),
    { capture: true, durationMs: 1 },
  );
  assertEquals(info.requestHeaders?.authorization, REDACTED);
  assert(info.url?.includes(`api_key=${encodeURIComponent(REDACTED)}`), info.url);
  assert(info.url?.includes("page=2"));
  assertEquals(JSON.parse(info.requestBody ?? "{}").api_key, REDACTED);
  assertEquals(JSON.parse(info.requestBody ?? "{}").subject, "hi");
});

Deno.test("capture redacts credential fields in a form-encoded body", () => {
  const info = egressInfo(
    req({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=refresh_token&client_secret=shh&scope=read",
    }),
    res(),
    { capture: true, durationMs: 1 },
  );
  assertEquals(info.requestBody, `grant_type=refresh_token&client_secret=${REDACTED}&scope=read`);
});

Deno.test("capture truncates bodies at the limit and flags it", () => {
  const info = egressInfo(
    req({ body: "x".repeat(100) }),
    res({ body: enc("y".repeat(100)) }),
    { capture: true, bodyLimit: 10, durationMs: 1 },
  );
  assertEquals(info.requestBody?.length, 10);
  assertEquals(info.responseBody?.length, 10);
  assertEquals(info.truncated, true);
});

Deno.test("egressFailure records a request that never produced a response", () => {
  const info = egressFailure(req(), new Error("egress_denied"), { capture: true, durationMs: 3 });
  assertEquals(info.status, 0);
  assertEquals(info.error, "egress_denied");
  assertEquals(info.requestHeaders?.authorization, REDACTED);
  assertEquals(info.responseBody, undefined);
});
