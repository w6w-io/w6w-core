import { assertEquals, assertStrictEquals } from "jsr:@std/assert@^1.0.0";
import { type Trigger, withWebhookRegistration } from "../mod.ts";

const hook: Trigger = { key: "t", title: "T", type: "webhook" };

Deno.test("a webhook with no onSubscribe is derived manual", () => {
  assertEquals(withWebhookRegistration(hook, ["handleIngest", "parseOutput"]).webhook, {
    registration: "manual",
  });
  assertEquals(withWebhookRegistration(hook, []).webhook, { registration: "manual" });
});

Deno.test("self-registering, authored, poll, protocol and unknown hooks are left as they are", () => {
  assertStrictEquals(withWebhookRegistration(hook, ["onSubscribe", "onUnsubscribe"]), hook);
  const authored: Trigger = { ...hook, webhook: { registration: "manual", instructions: "x" } };
  assertStrictEquals(withWebhookRegistration(authored, []), authored);
  const poll: Trigger = { ...hook, type: "poll" };
  assertStrictEquals(withWebhookRegistration(poll, ["poll"]), poll);
  const protocol: Trigger = { ...hook, type: "protocol", delivery: "w6w-protocol" };
  assertStrictEquals(withWebhookRegistration(protocol, []), protocol);
  assertStrictEquals(withWebhookRegistration(hook, undefined), hook);
});

Deno.test("the input is never mutated", () => {
  const t: Trigger = { ...hook };
  withWebhookRegistration(t, []);
  assertEquals(t.webhook, undefined);
});
