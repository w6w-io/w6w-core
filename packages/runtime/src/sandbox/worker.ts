/**
 * Sandbox worker entry point. Runs INSIDE a Deno Web Worker spawned with a
 * restricted permission set (see run-hook.ts). It imports untrusted app
 * modules and either calls them or extracts their (serializable) config.
 *
 * The worker has no network permission. When a hook calls `ctx.fetch`, the
 * request is proxied to the host, which signs and performs it. So both the
 * credential-bearing `sign` worker and the request-making action worker are off
 * the network — the trusted host does all I/O.
 */
import type { DescribedAction, HostMessage, WireResponse, WorkerMessage } from "./protocol.ts";

declare const self: {
  onmessage: ((e: { data: HostMessage }) => void) | null;
  postMessage: (msg: WorkerMessage) => void;
};

const post = (msg: WorkerMessage) => self.postMessage(msg);

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

async function importDefault(path: string): Promise<unknown> {
  const mod = await import(`file://${path}`);
  return mod.default ?? mod.handler;
}

async function handleCall(msg: Extract<HostMessage, { op: "call" }>) {
  const target = await importDefault(msg.hookPath);
  const fn = msg.method
    ? (target as Record<string, unknown> | undefined)?.[msg.method]
    : target;
  if (typeof fn !== "function") {
    const what = msg.method ? `method "${msg.method}"` : "default export";
    throw new Error(`Module "${msg.hookPath}" has no callable ${what}.`);
  }
  const ctx = {
    fetch: proxyFetch(msg.enableFetch),
    log: (level: string, message: string, data?: unknown) =>
      post({ type: "log", level, message, data }),
    connection: msg.connection,
  };
  const value = await (fn as (i: unknown, c: unknown) => unknown).call(
    msg.method ? target : undefined,
    msg.input,
    ctx,
  );
  post({ type: "result", value });
}

async function handleDescribeActions(msg: Extract<HostMessage, { op: "describe-actions" }>) {
  const described: DescribedAction[] = [];
  for (const path of msg.paths) {
    const def = await importDefault(path);
    if (!def || typeof def !== "object") {
      throw new Error(`Action module "${path}" must default-export an ActionDefinition object.`);
    }
    // Strip the execute function (and anything non-serializable) to a plain config.
    const definition = JSON.parse(JSON.stringify({ ...def, execute: undefined }));
    described.push({ path, definition });
  }
  post({ type: "result", value: described });
}

async function run(msg: Extract<HostMessage, { type: "start" }>) {
  try {
    if (msg.op === "call") await handleCall(msg);
    else await handleDescribeActions(msg);
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
