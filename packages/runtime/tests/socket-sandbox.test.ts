/**
 * Proves the `ctx.socket` sandbox transport landed by T1.2.1: the worker can
 * only write/read/close a stream the host handed it (never open one of its
 * own), the shared request-id counter routes fetch and socket replies to
 * their own callers, and an absent/throwing host callback is always an
 * error — never a hang and never a silent success. This node opens no real
 * socket; every `onSocket` here is a fake supplied by the test, exactly as
 * T1.2.1's own scope requires (T1.2.2 wires the real one).
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { invoke, loadApp, runHook, W6WError } from "../mod.ts";
import { runWorker } from "../src/sandbox/run-hook.ts";
import type { LoadedApp } from "../src/loader.ts";
import type { WireResponse } from "../src/sandbox/protocol.ts";
import type { Invocation } from "@w6w/types";

/** The fixture is loaded by `loadApp`, so it is always the `dir` arm of `LoadedApp.code`. */
function dirCode(app: LoadedApp) {
  if (app.code.kind !== "dir") throw new Error("expected a dir-loaded app");
  return app.code;
}

const DIR = fromFileUrl(new URL("../../../fixtures/apps/socket-posture", import.meta.url));

function inv(action: string, params?: Record<string, unknown>): Invocation {
  return { manifestVersion: "1", app: "io.w6w.socket-posture", action, params };
}

function fakeFetchResponse(body: string): WireResponse {
  return { status: 200, statusText: "OK", headers: {}, body: new TextEncoder().encode(body) };
}

// (a) The raw path still dies in the sandbox — mirrors runtime.test.ts's
// "sandbox denies direct (un-proxied) network access", one layer down at
// the socket. `net: false` denies `Deno.connect` exactly as it denies
// `fetch`; a `net: true` in `NO_NET_PERMS` would make this pass instead.
Deno.test("sandbox denies direct (un-proxied) socket access", async () => {
  const app = await loadApp(DIR);
  const err = await assertRejects(
    () => invoke(app, inv("raw-connect-attempt")),
    W6WError,
  );
  assertEquals(err.code, "hook_failed");
  assertEquals(err.phase, "execute");
});

// (b) The proxy is the only route, and it works: the host's `onSocket`
// callback observes the EXACT bytes the action wrote, and the round trip
// resolves with what the callback handed back — proving the wire, not just
// that a promise eventually settles.
Deno.test("ctx.socket proxies write/read through onSocket with the exact bytes", async () => {
  const app = await loadApp(DIR);
  const written: Uint8Array[] = [];
  const result = await runHook<{ socketPresent: boolean; echoed: string | null }>({
    entryPath: dirCode(app).entryPath,
    selector: { kind: "action", key: "proxied-echo" },
    input: { message: "hello wire" },
    readScope: dirCode(app).dir,
    onSocket: (req) => {
      if (req.op === "write") {
        written.push(req.bytes);
        return Promise.resolve({ op: "write" });
      }
      if (req.op === "read") return Promise.resolve({ op: "read", bytes: written[0] ?? null });
      return Promise.resolve({ op: "close" });
    },
  });
  assertEquals(result.socketPresent, true);
  assertEquals(result.echoed, "hello wire");
  assertEquals(written.length, 1);
  assertEquals(new TextDecoder().decode(written[0]), "hello wire");
});

// (c) `runHook`'s convenience wrapper always derives `enableSocket` from
// `!!opts.onSocket`, so nothing through it can ever produce "ctx.socket
// exists but the host forgot to service it." Drive `runWorker` directly to
// build exactly that scenario, and assert the SPECIFIC error code a real
// reply carries (`hook_failed`) — not just "some W6WError" — under a short
// `timeoutMs`. A mutant that silently drops the error reply doesn't hang
// forever here; it hangs until the timeout, then rejects with
// `hook_timeout` instead, which this assertion tells apart from the
// immediate `hook_failed` a correct guard produces.
Deno.test("ctx.socket calls reject (not hang) when enableSocket is true but onSocket is absent", async () => {
  const app = await loadApp(DIR);
  const err = await assertRejects(
    () =>
      runWorker<unknown>({
        type: "start",
        op: "call",
        entryPath: dirCode(app).entryPath,
        selector: { kind: "action", key: "proxied-echo" },
        input: { message: "x" },
        enableFetch: false,
        enableSocket: true,
        enableFile: false,
      }, {
        readScope: dirCode(app).dir,
        timeoutMs: 2_000,
        // onSocket intentionally omitted.
      }),
    W6WError,
  );
  assertEquals(err.code, "hook_failed");
});

// (d) One hook issuing `ctx.fetch` and `ctx.socket.read()` interleaved gets
// each reply routed to its own promise off the SHARED `nextId` counter — a
// two-counter implementation (a separate `nextSocketId`) collides on the
// first concurrent pair and this test observes the swap/collision as a
// wrong value on one side or the other.
Deno.test("ctx.fetch and ctx.socket.read() interleaved each resolve with their own reply", async () => {
  const app = await loadApp(DIR);
  const result = await runHook<{ echoed: string | null; fetched?: string }>({
    entryPath: dirCode(app).entryPath,
    selector: { kind: "action", key: "proxied-echo" },
    input: { message: "socket-value", fetchUrl: "https://example.invalid/whatever" },
    readScope: dirCode(app).dir,
    onFetch: () => Promise.resolve(fakeFetchResponse("fetch-value")),
    onSocket: (req) => {
      if (req.op === "write") return Promise.resolve({ op: "write" });
      if (req.op === "read") {
        return Promise.resolve({ op: "read", bytes: new TextEncoder().encode("socket-echo") });
      }
      return Promise.resolve({ op: "close" });
    },
  });
  assertEquals(result.echoed, "socket-echo");
  assertEquals(result.fetched, "fetch-value");
});

// (e) Optionality is real, not a throwing stub: with no `onSocket` at all,
// `enableSocket` is false and `ctx.socket` is `undefined` — observed
// directly via the fixture's `socketPresent` flag, not inferred from a
// thrown error that could have any cause.
Deno.test("ctx.socket is undefined when enableSocket is false", async () => {
  const app = await loadApp(DIR);
  const result = await runHook<{ socketPresent: boolean; echoed: string | null }>({
    entryPath: dirCode(app).entryPath,
    selector: { kind: "action", key: "proxied-echo" },
    input: { message: "unused" },
    readScope: dirCode(app).dir,
  });
  assertEquals(result.socketPresent, false);
  assertEquals(result.echoed, null);
});

// (f) A throwing host callback crosses the boundary as an error carrying
// its message, not a swallowed failure or a hang.
Deno.test("a throwing onSocket callback rejects the hook's ctx.socket call with its message", async () => {
  const app = await loadApp(DIR);
  const err = await assertRejects(
    () =>
      runHook({
        entryPath: dirCode(app).entryPath,
        selector: { kind: "action", key: "proxied-echo" },
        input: { message: "x" },
        readScope: dirCode(app).dir,
        onSocket: () => {
          throw new Error("host socket exploded");
        },
      }),
    W6WError,
  );
  assertEquals(err.code, "hook_failed");
  assert(err.message.includes("host socket exploded"));
});
