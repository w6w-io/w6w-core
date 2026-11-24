import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { invoke, loadApp, W6WError } from "../mod.ts";
import type { Connection, Invocation } from "@w6w/types";

// A read-only request with no response headers after `hedgeAfterMs` gets a
// second copy; the first to answer wins (runtime.ts `hedgedFetch`).

const EGRESS_DIR = fromFileUrl(new URL("../../../fixtures/apps/egress", import.meta.url));

const connection: Connection = {
  manifestVersion: "1",
  id: "conn_test",
  app: "io.w6w.egress",
  owner: "user_1",
  state: "connected",
  createdAt: "2026-05-24T00:00:00Z",
  auth: "api-key-header",
  credential: { apiKey: "k" },
};

const inv: Invocation = {
  manifestVersion: "1",
  app: "io.w6w.egress",
  action: "call",
  connection: connection.id,
  params: { url: "http://public.test/orders" },
};

/** A fetch whose Nth call answers after `delays[N]` ms (Infinity: only when aborted). */
function scripted(delays: number[]) {
  const calls: { aborted: boolean }[] = [];
  const fetchImpl: typeof fetch = (_input, init) => {
    const i = calls.length;
    const call = { aborted: false };
    calls.push(call);
    const signal = (init as RequestInit).signal!;
    return new Promise<Response>((resolve, reject) => {
      const t = Number.isFinite(delays[i])
        ? setTimeout(() => resolve(new Response(`answer-${i}`, { status: 200 })), delays[i])
        : undefined;
      signal.addEventListener("abort", () => {
        call.aborted = true;
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  };
  return { calls, fetchImpl };
}

async function run(fetchImpl: typeof fetch, hedgeAfterMs?: number, timeoutMs = 20_000) {
  const app = { ...(await loadApp(EGRESS_DIR)), netAllowlist: ["public.test"] };
  const egressGuard = {
    allowPrivate: false,
    resolve: () => Promise.resolve(["93.184.216.34"]),
    fetchImpl,
  };
  return invoke(app, inv, { connection, egressGuard, timeoutMs, hedgeAfterMs }) as Promise<{
    value: { status: number; body: string };
  }>;
}

Deno.test("hedge: a stalled GET gets a second copy, which answers; the stall is aborted", async () => {
  const { calls, fetchImpl } = scripted([Infinity, 20]);
  const t0 = performance.now();
  const res = await run(fetchImpl, 100);
  assertEquals(res.value.body, "answer-1");
  assertEquals(calls.length, 2);
  assert(calls[0].aborted, "the stalled copy is aborted once the hedge answers");
  assert(performance.now() - t0 < 5_000);
});

Deno.test("hedge: when the original answers first it wins and the copy is aborted", async () => {
  const { calls, fetchImpl } = scripted([250, Infinity]);
  const res = await run(fetchImpl, 100);
  assertEquals(res.value.body, "answer-0");
  assertEquals(calls.length, 2);
  assert(calls[1].aborted);
});

Deno.test("hedge: an answer before the hedge time sends exactly one request", async () => {
  const { calls, fetchImpl } = scripted([10]);
  const res = await run(fetchImpl, 500);
  assertEquals(res.value.body, "answer-0");
  await new Promise((r) => setTimeout(r, 600));
  assertEquals(calls.length, 1);
});

Deno.test("hedge: 0 turns it off — one request, waited out", async () => {
  const { calls, fetchImpl } = scripted([400]);
  const res = await run(fetchImpl, 0);
  assertEquals(res.value.body, "answer-0");
  assertEquals(calls.length, 1);
});

Deno.test("hedge: not used when the limit leaves no room for a second copy", async () => {
  const roomy = scripted([400]); // 6000 > 2 × 300: hedged, the copy is sent at 300 ms
  const res = await run(roomy.fetchImpl, 300, 6_000);
  assertEquals(res.value.body, "answer-0");
  assertEquals(roomy.calls.length, 2);
  const tight = scripted([3_500]);
  const res2 = await run(tight.fetchImpl, 3_000, 6_000); // 6000 <= 2 × 3000: not hedged
  assertEquals(res2.value.body, "answer-0");
  assertEquals(tight.calls.length, 1);
});

Deno.test("hedge: both copies stalled — the overall limit still ends it as fetch_timeout", async () => {
  const { calls, fetchImpl } = scripted([Infinity, Infinity]);
  let err: unknown;
  try {
    await run(fetchImpl, 200, 6_000);
  } catch (e) {
    err = e;
  }
  assert(err instanceof W6WError, String(err));
  assertEquals((err as W6WError).code, "fetch_timeout");
  assertEquals(calls.length, 2);
  // The sandbox's limit can settle the invoke before the request's own timer
  // (started once the sandbox has booted) fires; that timer releases both.
  for (let i = 0; i < 100 && !calls.every((c) => c.aborted); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert(calls.every((c) => c.aborted));
});
