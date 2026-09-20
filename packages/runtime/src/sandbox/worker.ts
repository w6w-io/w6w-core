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
import { AUTH_HOOK_KINDS, isFileRef, TRIGGER_HOOK_KINDS } from "@w6w/types";
import type { AppDefinition, FileCapability, FileRef, SocketHandle } from "@w6w/types";
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
 * One correlation-id space, shared by `ctx.fetch`, `ctx.socket` and `ctx.file`
 * (the note in this node's contract: "`ctx.file` reuses it"). The proxies'
 * responses are shaped differently, so `pending`'s value is a discriminated
 * union rather than one fixed resolve type — `nextId` is still a single
 * counter either way, which is load-bearing: it's what guarantees a
 * `write`/`read`/`close`/`fetch`/`file-*` reply can never be delivered to the
 * wrong pending call even when a hook interleaves capabilities.
 */
type Pending =
  | { kind: "fetch"; resolve: (r: WireResponse) => void; reject: (e: Error) => void }
  | { kind: "socket"; resolve: (value: unknown) => void; reject: (e: Error) => void }
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
 * Build `ctx.socket`. Returns `undefined` when the host disabled it, rather
 * than a stub that throws on first use — `HookContext.socket` is optional
 * precisely so an app can feature-detect with `if (ctx.socket)`, and a
 * present-but-throwing value would make that check lie.
 *
 * Each method is a one-shot request/response over the same `pending` map and
 * `nextId` counter `proxyFetch` uses, so a `write`/`read`/`close` in flight
 * can never be resolved by the wrong reply.
 */
function proxySocket(enabled: boolean): SocketHandle | undefined {
  if (!enabled) return undefined;

  type SocketWorkerMessage = Extract<
    WorkerMessage,
    { type: "socket-write" | "socket-read" | "socket-close" }
  >;
  function call<T>(msg: SocketWorkerMessage): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      pending.set(msg.id, { kind: "socket", resolve: resolve as (value: unknown) => void, reject });
      post(msg);
    });
  }

  return {
    write(bytes: Uint8Array): Promise<void> {
      return call<void>({ type: "socket-write", id: nextId++, bytes });
    },
    read(max?: number): Promise<Uint8Array | null> {
      return call<Uint8Array | null>({ type: "socket-read", id: nextId++, max });
    },
    close(): Promise<void> {
      return call<void>({ type: "socket-close", id: nextId++ });
    },
  };
}

/**
 * `ctx.file` — mirrors `proxyFetch`'s pending-map correlation exactly (see
 * `Pending` above), over the two-method wire pinned in this node's contract
 * (`protocol.ts`'s `file-read`/`file-create` and their responses). Disabled
 * ⇒ both methods REJECT, the same shape `proxyFetch(false)` uses — `ctx.file`
 * is always present (A1/A2), never an absent field and never a silent no-op.
 *
 * ROUND 1 / B1: the app script calling this is untrusted by construction, so
 * a TypeScript parameter type (`read(ref: FileRef | string)`) is not a
 * security boundary — it is erased at runtime and enforces nothing against
 * code we don't trust. Both entry points runtime-narrow their argument
 * BEFORE the `post(...)` call, rejecting the same way (a rejecting Promise,
 * never a thrown synchronous error) `proxyFetch(false)` already does for a
 * disabled capability, so a malformed call and a disabled capability are one
 * class of failure, not two.
 *
 * ROUND 2 / B3: this narrowing is an ERGONOMIC fast path, not the boundary —
 * it runs in the SAME Deno Worker realm as the untrusted app module, so every
 * global it resolves against (`Uint8Array`, `Symbol.hasInstance`, the getter
 * on an object literal) is itself app-writable. A getter-based TOCTOU (a
 * `ref` whose `.id` returns a string on `isFileRef`'s read and an object on
 * this method's own re-read) and a fake-branded `Uint8Array`
 * (`Object.create(Uint8Array.prototype)`) both pass these checks and still
 * reach the wire. The actual boundary is `run-hook.ts`'s `worker.onmessage`
 * switch, which re-checks the SAME value on the host side, after it has
 * crossed `structuredClone` — the one point the app cannot reach or rewrite.
 * These checks stay for a faster, clearer error on an honest app's mistake.
 */
function proxyFile(enabled: boolean): FileCapability {
  const unavailable = () =>
    Promise.reject(new Error("File capability is not available in this context."));
  const malformed = (message: string) => Promise.reject(new Error(message));
  return {
    read(ref) {
      if (!enabled) return unavailable();
      let refId: string;
      if (typeof ref === "string") {
        refId = ref;
      } else if (isFileRef(ref)) {
        // isFileRef checks `typeof id === "string"` at the moment it reads
        // `.id` — but a getter can return a different value on a second
        // read (a same-realm TOCTOU this worker-side check cannot see), so
        // this line does NOT itself guarantee the wire's `ref` field can
        // only ever carry a string. `run-hook.ts`'s host-side re-check,
        // after `structuredClone` has evaluated any getter exactly once and
        // frozen the result, is what actually enforces that.
        refId = ref.id;
      } else {
        return malformed("ctx.file.read: ref must be a FileRef or a string id.");
      }
      const id = nextId++;
      return new Promise<{ ref: FileRef; bytes: Uint8Array }>((resolve, reject) => {
        pending.set(id, { kind: "file-read", resolve, reject });
        post({ type: "file-read", id, ref: refId });
      });
    },
    create(bytes, meta) {
      if (!enabled) return unavailable();
      // A string, a plain object, or any other ArrayBufferView subtype is a
      // caller error here — DC-5's permissive `coerceBody` is a different
      // code path (ctx.fetch bodies); ctx.file.create stays strict, because
      // its contract is "you already have bytes."
      if (!(bytes instanceof Uint8Array)) {
        return malformed("ctx.file.create: bytes must be a Uint8Array.");
      }
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
    socket: proxySocket(msg.enableSocket),
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
    case "socket-write-response":
    case "socket-close-response": {
      const p = pending.get(msg.id);
      if (p && p.kind === "socket") {
        pending.delete(msg.id);
        p.resolve(undefined);
      }
      return;
    }
    case "socket-read-response": {
      const p = pending.get(msg.id);
      if (p && p.kind === "socket") {
        pending.delete(msg.id);
        p.resolve(msg.bytes);
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
    case "socket-write-error":
    case "socket-read-error":
    case "socket-close-error":
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
