import type { ActionDefinition, AppDefinition, AuthDefinition } from "@w6w/types";

/** Same shape as the sendgrid fixture's api-key auth: `sign` stamps a Bearer header. */
const apiKey: AuthDefinition = {
  key: "api-key",
  type: "apiKey",
  displayName: "API Key",
  apiKey: { in: "header", name: "Authorization", prefix: "Bearer " },
  fields: [{ key: "apiKey", label: "API Key", type: "secret", required: true }],
  sign({ request, credential }) {
    const { apiKey } = credential as { apiKey: string };
    request.headers["authorization"] = `Bearer ${apiKey}`;
    return request;
  },
  test() {
    return { ok: true };
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One hook, many behaviours, chosen by `input.form.mode`. `execute` returns a
 * shape the hook never does, so a test can tell which of the two the worker ran.
 */
const form: ActionDefinition = {
  key: "form",
  type: "perform",
  title: "Form",
  params: [
    { key: "mode", label: "Mode", type: "string" },
    {
      key: "channel",
      label: "Channel",
      type: "string",
      options: { source: "resolveFields" },
    },
  ],
  execute() {
    return { ranExecute: true };
  },
  async resolveFields(input, ctx) {
    const f = input.form as Record<string, unknown>;
    switch (f.mode) {
      case "isolation": {
        // Reaches the wire through the signing fetch; the label records what the
        // hook can see of the connection (its keys, never the credential).
        const res = await ctx.fetch(`${f.base}/channels`);
        const keys = ctx.connection ? Object.keys(ctx.connection) : [];
        return {
          fields: {
            channel: {
              options: [{
                value: "c1",
                label: `status:${res.status}|keys:${keys.join(",")}`,
              }],
            },
          },
        };
      }
      case "egress":
        await ctx.fetch(String(f.url));
        return { fields: {} };
      case "throw":
        throw new Error(String(f.message));
      case "hang":
        await sleep(Number(f.ms));
        return { fields: {} };
      case "raw":
        // Returned verbatim so the host-side sanitiser sees attacker-shaped data.
        return f.raw as never;
      default:
        return {
          fields: { channel: { options: [{ value: "general", label: "General" }] } },
        };
    }
  },
};

/** An action with no hook at all. */
const plain: ActionDefinition = {
  key: "plain",
  type: "perform",
  title: "Plain",
  params: [],
  execute() {
    return { plain: true };
  },
};

/** A hand-written `resolveFields: true` with no function behind it. */
const fake = {
  key: "fake",
  type: "perform",
  title: "Fake",
  params: [],
  resolveFields: true,
  execute() {
    return { fake: true };
  },
} as unknown as ActionDefinition;

export default {
  actions: [form, plain, fake],
  auth: [apiKey],
} satisfies AppDefinition;
