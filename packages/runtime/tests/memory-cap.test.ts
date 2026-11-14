/**
 * F-3 — per-Worker memory cap. An app whose hook allocates without bound is
 * terminated with `memory_limit_exceeded` and the host process survives.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { W6WError } from "../src/errors.ts";
import { DEFAULT_APP_MEMORY_MB, memoryLimitMb, runWorker } from "../src/sandbox/run-hook.ts";

function dataUrl(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:text/javascript;base64,${btoa(bin)}`;
}

// Yields to the macrotask loop between allocations: Deno's `Worker.terminate()` only takes
// effect once the worker returns to its event loop (measured on 2.8.2: a purely synchronous
// or microtask-only allocation loop keeps running after terminate() - ~1.2 GiB/250 ms - so
// that case needs process isolation, not this watchdog).
const HOG = `const hog = { key: "hog", execute: async () => {
  const keep = [];
  while (true) {
    const a = new Uint8Array(8 * 1024 * 1024); a.fill(1); keep.push(a);
    await new Promise((r) => setTimeout(r, 0));
  }
} };
const ok = { key: "ok", execute: async () => ({ fine: true }) };
export default { actions: [hog, ok] };`;

const start = (key: string) => ({
  type: "start" as const,
  op: "call" as const,
  entryUrl: dataUrl(HOG),
  selector: { kind: "action" as const, key },
  input: {},
  enableFetch: false,
  enableSocket: false,
  enableFile: false,
});

Deno.test("unbounded allocation is terminated with memory_limit_exceeded; host survives", async () => {
  const err = await assertRejects(
    () => runWorker(start("hog"), { memoryLimitMb: 128, timeoutMs: 20_000 }),
    W6WError,
  );
  assertEquals((err as W6WError).code, "memory_limit_exceeded", (err as Error).message);
  // Host is alive and a well-behaved app still runs afterwards.
  const r = await runWorker<{ fine: boolean }>(start("ok"), { timeoutMs: 20_000 });
  assertEquals(r, { fine: true });
});

Deno.test("memoryLimitMb: default, env override, bad env ignored", () => {
  const prev = Deno.env.get("W6W_APP_MEMORY_MB");
  try {
    Deno.env.delete("W6W_APP_MEMORY_MB");
    assertEquals(memoryLimitMb(), DEFAULT_APP_MEMORY_MB);
    assert(DEFAULT_APP_MEMORY_MB >= 512);
    Deno.env.set("W6W_APP_MEMORY_MB", "256");
    assertEquals(memoryLimitMb(), 256);
    Deno.env.set("W6W_APP_MEMORY_MB", "junk");
    assertEquals(memoryLimitMb(), DEFAULT_APP_MEMORY_MB);
    assertEquals(memoryLimitMb(64), 64);
  } finally {
    if (prev === undefined) Deno.env.delete("W6W_APP_MEMORY_MB");
    else Deno.env.set("W6W_APP_MEMORY_MB", prev);
  }
});
