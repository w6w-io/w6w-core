// Import-free on purpose: this file is loaded both from disk (loadApp) and as exec code
// (a data: URL in a read-less Worker). Plain JS, default export, no module specifiers.
const echo = {
  key: "echo",
  type: "perform",
  title: "Echo",
  description: "Returns the given text; the non-ASCII round-trip witness.",
  params: [{ key: "text", label: "Text", type: "string", required: true }],
  output: [{ key: "text", type: "string", label: "Text" }],
  execute(input) {
    return { text: input.text };
  },
};

const fetchIt = {
  key: "fetch-it",
  type: "perform",
  title: "Fetch",
  description: "GETs a URL through ctx.fetch (signed) and returns the JSON body.",
  params: [{ key: "url", label: "URL", type: "string", required: true }],
  output: [{ key: "body", type: "object", label: "Body" }],
  async execute(input, ctx) {
    const res = await ctx.fetch(input.url);
    return { status: res.status, body: await res.json() };
  },
};

const readProbe = {
  key: "read-probe",
  type: "perform",
  title: "Read probe",
  description: "Tries to read each path from inside the Worker; reports error name or 'ok'.",
  params: [{ key: "paths", label: "Paths", type: "array", item: { type: "string" }, required: true }],
  output: [{ key: "results", type: "array", label: "Results" }],
  execute(input) {
    return {
      results: input.paths.map((p) => {
        try {
          Deno.readTextFileSync(p);
          return "ok";
        } catch (e) {
          return e.name;
        }
      }),
    };
  },
};

const makeFile = {
  key: "make-file",
  type: "perform",
  title: "Make file",
  description: "ctx.file.create — host-mediated, must work with no Worker read permission.",
  params: [],
  output: [{ key: "ref", type: "object", label: "FileRef" }],
  async execute(_input, ctx) {
    const ref = await ctx.file.create(new Uint8Array([1, 2, 3]), {
      contentType: "application/octet-stream",
      filename: "x.bin",
    });
    return { ref };
  },
};

const apiKey = {
  key: "api-key",
  type: "apiKey",
  displayName: "API Key",
  apiKey: { in: "header", name: "Authorization", prefix: "Bearer " },
  fields: [{ key: "apiKey", label: "API Key", type: "secret", required: true }],
  sign({ request, credential }) {
    request.headers["authorization"] = `Bearer ${credential.apiKey}`;
    return request;
  },
  test({ credential }) {
    return { ok: true, label: `key ${credential.apiKey} café ✓` };
  },
  refresh({ credential }) {
    return { apiKey: `${credential.apiKey}-refreshed` };
  },
  // Two-step socket handshake: send a frame, then finish once the peer's reply arrives.
  handshake({ received }) {
    if (!received) return { done: false, send: new Uint8Array([1, 2, 3]) };
    return { done: true, leftover: received };
  },
};

const wh = {
  key: "wh",
  title: "Webhook",
  onSubscribe({ subscriptionId }) {
    return { webhookId: "wh_" + subscriptionId };
  },
  onUnsubscribe() {},
  handleIngest({ raw }) {
    return [{ method: raw.method, via: "exec" }];
  },
};

const ping = {
  key: "ping",
  title: "Ping",
  kind: "service",
  check() {
    return { state: "ok", message: "pong café ✓" };
  },
};

export default {
  actions: [echo, fetchIt, readProbe, makeFile],
  auth: [apiKey],
  triggers: [wh],
  healthChecks: [ping],
};
