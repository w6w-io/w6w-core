/**
 * Sandbox worker entry point. Runs INSIDE a Deno Web Worker spawned with a
 * restricted permission set (see run-hook.ts). It dynamically imports a hook
 * module, builds the `HookContext`, runs the default export, and posts the
 * result back.
 *
 * The worker itself has no network permission. When a hook calls `ctx.fetch`,
 * the request is proxied to the host, which signs and performs it, then returns
 * the response. So the credential-bearing `sign` worker and the request-making
 * action worker are both off the network — the trusted host does all I/O.
 */
import type { HostMessage, WireResponse, WorkerMessage } from "./protocol.ts";

declare const self: {
  onmessage: ((e: { data: HostMessage }) => void) | null;
  postMessage: (msg: WorkerMessage) => void;
};

const post = (msg: WorkerMessage) => self.postMessage(msg);

// In-flight proxied fetches, keyed by id.
const pending = new Map<number, {
  resolve: (r: WireResponse) => void;
  reject: (e: Error) => void;
}>();
let nextId = 1;
let started = false;

function proxyFetch(enabled: boolean) {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (!enabled) {
      return Promise.reject(new Error("Network is not available in this context."));
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body != null ? String(init.body) : null;

    const id = nextId++;
    return new Promise<WireResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ type: "fetch", id, request: { url, method, headers, body } });
    }).then((r) =>
      new Response(r.body.byteLength ? (r.body as unknown as BodyInit) : null, {
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
      })
    );
  };
}

async function run(msg: Extract<HostMessage, { type: "start" }>) {
  const { hookPath, input, connection, enableFetch } = msg;
  try {
    const mod = await import(`file://${hookPath}`);
    const fn = mod.default ?? mod.handler;
    if (typeof fn !== "function") {
      throw new Error(`Hook module "${hookPath}" has no default export function.`);
    }
    const ctx = {
      fetch: proxyFetch(enableFetch),
      log: (level: string, message: string, data?: unknown) =>
        post({ type: "log", level, message, data }),
      connection,
    };
    const value = await fn(input, ctx);
    post({ type: "result", value });
  } catch (err) {
    const error = err as Error;
    post({
      type: "error",
      error: { name: error?.name ?? "Error", message: String(error?.message ?? err) },
    });
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "start":
      if (!started) {
        started = true;
        run(msg);
      }
      return;
    case "fetch-response": {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.resolve(msg.response);
      }
      return;
    }
    case "fetch-error": {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.reject(new Error(msg.message));
      }
      return;
    }
  }
};
