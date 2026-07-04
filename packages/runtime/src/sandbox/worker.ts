/**
 * Sandbox worker entry point. Runs INSIDE a Deno Web Worker spawned with a
 * restricted permission set (see run-hook.ts). It imports an app's untrusted
 * entry module and either calls a located function or extracts the app's
 * serializable config.
 *
 * The worker has no network permission. When a hook calls `ctx.fetch`, the
 * request is proxied to the host, which signs and performs it. So both the
 * credential-bearing `sign` worker and the request-making action worker are off
 * the network — the trusted host does all I/O.
 */
import { AUTH_HOOK_KINDS, TRIGGER_HOOK_KINDS } from "@w6w/types";
import type { AppDefinition } from "@w6w/types";
import type {
  DescribedApp,
  HostMessage,
  Selector,
  WireResponse,
  WorkerMessage,
} from "./protocol.ts";

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

async function importApp(entryPath: string): Promise<AppDefinition> {
  const mod = await import(`file://${entryPath}`);
  const app = mod.default ?? mod.app;
  if (!app || typeof app !== "object") {
    throw new Error(`Entry module "${entryPath}" must default-export an AppDefinition object.`);
  }
  return app as AppDefinition;
}

/** Resolve the function a selector addresses, bound to its owner object. */
function locate(app: AppDefinition, sel: Selector): ((i: unknown, c: unknown) => unknown) | null {
  if (sel.kind === "action") {
    const action = app.actions?.find((a) => a.key === sel.key);
    return action?.execute
      ? (action.execute as (i: unknown, c: unknown) => unknown).bind(action)
      : null;
  }
  if (sel.kind === "trigger") {
    const trigger = app.triggers?.find((t) => t.key === sel.key);
    const fn = trigger?.[sel.hook];
    return typeof fn === "function"
      ? (fn as (i: unknown, c: unknown) => unknown).bind(trigger)
      : null;
  }
  const auth = app.auth?.find((a) => a.key === sel.key);
  const fn = auth?.[sel.hook];
  return typeof fn === "function" ? (fn as (i: unknown, c: unknown) => unknown).bind(auth) : null;
}

async function handleCall(msg: Extract<HostMessage, { op: "call" }>) {
  const app = await importApp(msg.entryPath);
  const fn = locate(app, msg.selector);
  if (!fn) {
    const s = msg.selector;
    const what = s.kind === "action"
      ? `action "${s.key}".execute`
      : s.kind === "trigger"
      ? `trigger "${s.key}".${s.hook}`
      : `auth "${s.key}".${s.hook}`;
    throw new Error(`Entry module has no callable ${what}.`);
  }
  const ctx = {
    fetch: proxyFetch(msg.enableFetch),
    log: (level: string, message: string, data?: unknown) =>
      post({ type: "log", level, message, data }),
    connection: msg.connection,
    invocation: msg.invocation,
  };
  const value = await fn(msg.input, ctx);
  post({ type: "result", value });
}

async function handleDescribeApp(msg: Extract<HostMessage, { op: "describe-app" }>) {
  const app = await importApp(msg.entryPath);

  // Strip all functions to plain config via JSON round-trip.
  const actions = (app.actions ?? []).map((a) =>
    JSON.parse(JSON.stringify({ ...a, execute: undefined }))
  );
  const auth = (app.auth ?? []).map((a) => {
    const present = AUTH_HOOK_KINDS.filter((k) => typeof a[k] === "function");
    const config = { ...a } as Record<string, unknown>;
    for (const k of AUTH_HOOK_KINDS) delete config[k];
    return { auth: JSON.parse(JSON.stringify(config)), hooks: present };
  });
  const triggers = (app.triggers ?? []).map((t) => {
    const present = TRIGGER_HOOK_KINDS.filter((k) => typeof t[k] === "function");
    const config = { ...t } as Record<string, unknown>;
    for (const k of TRIGGER_HOOK_KINDS) delete config[k];
    return { trigger: JSON.parse(JSON.stringify(config)), hooks: present };
  });

  const described: DescribedApp = { actions, auth, triggers };
  post({ type: "result", value: described });
}

async function run(msg: Extract<HostMessage, { type: "start" }>) {
  try {
    if (msg.op === "call") await handleCall(msg);
    else await handleDescribeApp(msg);
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
