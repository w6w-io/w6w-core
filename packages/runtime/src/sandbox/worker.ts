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
import type { AppDefinition, FileCapability, FileRef } from "@w6w/types";
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

/**
 * One correlation-id space, shared by `ctx.fetch` and `ctx.file` (the note in
 * this node's contract: "`ctx.file` reuses it"). The three proxies' responses
 * are shaped differently, so `pending`'s value is a discriminated union rather
 * than one fixed resolve type — `nextId` is still a single counter either way.
 */
type Pending =
  | { kind: "fetch"; resolve: (r: WireResponse) => void; reject: (e: Error) => void }
  | {
    kind: "file-read";
    resolve: (r: { ref: FileRef; bytes: Uint8Array }) => void;
    reject: (e: Error) => void;
  }
  | { kind: "file-create"; resolve: (r: FileRef) => void; reject: (e: Error) => void };

const pending = new Map<number, Pending>();
let nextId = 1;
let started = false;

/**
 * DC-5: coerce an outgoing `ctx.fetch` body onto the binary-safe wire.
 *
 * `Uint8Array` passes through untouched; any other `ArrayBufferView` (a
 * `DataView`, a typed array of another element size) becomes a `Uint8Array`
 * over the SAME bytes, respecting `byteOffset`/`byteLength` — a view over a
 * slice of a larger buffer must not widen to the whole buffer. A bare
 * `ArrayBuffer` becomes a `Uint8Array` over its full range. Everything else
 * (a string, a `URLSearchParams`, `FormData`, …) keeps today's `String(...)`
 * behaviour unchanged — this fix targets exactly the case that was silently
 * corrupting binary uploads, not every other body shape `ctx.fetch` accepts.
 * `null`/`undefined` stays `null`.
 */
function coerceBody(body: BodyInit | null | undefined): string | Uint8Array | null {
  if (body == null) return null;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return String(body);
}

function proxyFetch(enabled: boolean) {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (!enabled) {
      return Promise.reject(new Error("Network is not available in this context."));
    }
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = coerceBody(init?.body);

    const id = nextId++;
    return new Promise<WireResponse>((resolve, reject) => {
      pending.set(id, { kind: "fetch", resolve, reject });
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

/**
 * `ctx.file` — mirrors `proxyFetch`'s pending-map correlation exactly (see
 * `Pending` above), over the two-method wire pinned in this node's contract
 * (`protocol.ts`'s `file-read`/`file-create` and their responses). Disabled
 * ⇒ both methods REJECT, the same shape `proxyFetch(false)` uses — `ctx.file`
 * is always present (A1/A2), never an absent field and never a silent no-op.
 */
function proxyFile(enabled: boolean): FileCapability {
  const unavailable = () =>
    Promise.reject(new Error("File capability is not available in this context."));
  return {
    read(ref) {
      if (!enabled) return unavailable();
      const refId = typeof ref === "string" ? ref : ref.id;
      const id = nextId++;
      return new Promise<{ ref: FileRef; bytes: Uint8Array }>((resolve, reject) => {
        pending.set(id, { kind: "file-read", resolve, reject });
        post({ type: "file-read", id, ref: refId });
      });
    },
    create(bytes, meta) {
      if (!enabled) return unavailable();
      const id = nextId++;
      return new Promise<FileRef>((resolve, reject) => {
        pending.set(id, { kind: "file-create", resolve, reject });
        post({
          type: "file-create",
          id,
          bytes,
          contentType: meta.contentType,
          filename: meta.filename,
        });
      });
    },
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
  if (sel.kind === "health") {
    const declared = app.healthChecks?.find((h) => h.key === sel.key);
    if (declared?.check) {
      return (declared.check as (i: unknown, c: unknown) => unknown).bind(declared);
    }
    // A tagged Action is projected into the health surface under its tag's key
    // (defaulting to the Action's own), and its `execute` IS the probe.
    const tagged = app.actions?.find((a) => (a.healthCheck?.key ?? a.key) === sel.key);
    return tagged?.healthCheck && tagged.execute
      ? (tagged.execute as (i: unknown, c: unknown) => unknown).bind(tagged)
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
      : s.kind === "health"
      ? `health check "${s.key}"`
      : `auth "${s.key}".${s.hook}`;
    throw new Error(`Entry module has no callable ${what}.`);
  }
  const ctx = {
    fetch: proxyFetch(msg.enableFetch),
    log: (level: string, message: string, data?: unknown) =>
      post({ type: "log", level, message, data }),
    connection: msg.connection,
    invocation: msg.invocation,
    file: proxyFile(msg.enableFile),
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

  const declared = (app.healthChecks ?? []).map((h) => {
    const config = { ...h } as Record<string, unknown>;
    delete config.check;
    return {
      check: JSON.parse(JSON.stringify(config)),
      hasHook: typeof h.check === "function",
    };
  });
  // Tagged Actions become checks too, so the health surface is one list
  // regardless of how the publisher authored it.
  const tagged = (app.actions ?? [])
    .filter((a) => a.healthCheck)
    .map((a) => ({
      check: JSON.parse(JSON.stringify({
        kind: "dependency",
        ...a.healthCheck,
        key: a.healthCheck!.key ?? a.key,
        title: a.healthCheck!.title ?? a.title,
      })),
      hasHook: typeof a.execute === "function",
    }));

  // A conformance is inert data — there is no hook to strip, so the JSON
  // round-trip here only guards against non-serializable values on interfaces.
  const described: DescribedApp = {
    actions,
    auth,
    triggers,
    healthChecks: [...declared, ...tagged],
    interfaces: JSON.parse(JSON.stringify(app.interfaces ?? [])),
  };
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
      if (p && p.kind === "fetch") {
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
    case "file-read-response": {
      const p = pending.get(msg.id);
      if (p && p.kind === "file-read") {
        pending.delete(msg.id);
        p.resolve({ ref: msg.ref, bytes: msg.bytes });
      }
      return;
    }
    case "file-create-response": {
      const p = pending.get(msg.id);
      if (p && p.kind === "file-create") {
        pending.delete(msg.id);
        p.resolve(msg.ref);
      }
      return;
    }
    case "file-error": {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.reject(new Error(msg.message));
      }
      return;
    }
  }
};
