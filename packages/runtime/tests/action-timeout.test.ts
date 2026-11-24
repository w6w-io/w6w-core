import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { invoke, loadApp, W6WError } from "../mod.ts";
import {
  ACTION_TIMEOUT_DEFAULT_MS,
  ACTION_TIMEOUT_MAX_MS,
  ACTION_TIMEOUT_MIN_MS,
  actionTimeoutMs,
  clampTimeoutMs,
} from "@w6w/types";

// `Action.timeoutMs` (action.md §Amendment — 2026-11-24): an Action may budget more than the 30 s
// default for a vendor known to answer slowly, and a sandbox timeout that fires while a request
// is still waiting names that host (`fetch_timeout`) instead of the opaque "Worker timed out".
// The fixture's slow server sleeps `?ms=` before answering; `slow` declares 4000 ms, `plain`
// declares nothing. Limits are seconds, not milliseconds, wide: under a loaded parallel test run a
// Worker can take a second to boot, and a limit that fires before the request leaves is (rightly)
// `hook_timeout`, not the `fetch_timeout` these tests pin.

const INDEX = `export default {
  actions: [{
    key: "slow", type: "read", title: "Slow", timeoutMs: 4000,
    params: [{ key: "url", label: "URL", type: "string", required: true }],
    async execute(input, ctx) {
      const r = await ctx.fetch(input.url);
      return { status: r.status, body: await r.text() };
    },
  }, {
    key: "plain", type: "read", title: "Plain",
    params: [{ key: "url", label: "URL", type: "string", required: true }],
    async execute(input, ctx) {
      const r = await ctx.fetch(input.url);
      return { status: r.status };
    },
  }, {
    key: "spin", type: "read", title: "Spin",
    execute() { return new Promise(() => {}); },
  }],
};
`;

async function makeApp() {
  const dir = await Deno.makeTempDir({ prefix: "action-timeout-" });
  await Deno.writeTextFile(
    `${dir}/package.json`,
    JSON.stringify({
      name: "@w6w-fixtures/action-timeout",
      version: "1.0.0",
      license: "MIT",
      private: true,
      description: "action timeout fixture",
      author: { name: "w6w" },
      w6w: {
        id: "io.test.action-timeout",
        displayName: "Action timeout",
        categories: ["other"],
        appearance: {
          icon: { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>' },
        },
        network: { allow: ["127.0.0.1"] },
        entry: "./index.ts",
      },
    }),
  );
  await Deno.writeTextFile(`${dir}/index.ts`, INDEX);
  return await loadApp(dir);
}

const LOCAL = { egressGuard: { allowPrivate: true } };

function slowServer() {
  // Pending answers, so `close()` can settle them: `shutdown()` waits for every open request.
  const pending = new Map<ReturnType<typeof setTimeout>, () => void>();
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    const ms = Number(new URL(req.url).searchParams.get("ms") ?? "0");
    return new Promise<Response>((resolve) => {
      const answer = () => {
        pending.delete(t);
        resolve(new Response("done"));
      };
      const t = setTimeout(answer, ms);
      pending.set(t, answer);
    });
  });
  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: (ms: number) => `http://127.0.0.1:${port}/?ms=${ms}`,
    async close() {
      for (const [t, answer] of [...pending]) {
        clearTimeout(t);
        answer();
      }
      await server.shutdown();
    },
  };
}

const inv = (action: string, params: Record<string, unknown> = {}) => ({
  manifestVersion: "1" as const,
  app: "io.test.action-timeout",
  action,
  params,
});

Deno.test("actionTimeoutMs: default when absent or invalid, clamps to the maximum", () => {
  assertEquals(actionTimeoutMs({}), ACTION_TIMEOUT_DEFAULT_MS);
  assertEquals(actionTimeoutMs({ timeoutMs: 0 }), ACTION_TIMEOUT_DEFAULT_MS);
  assertEquals(actionTimeoutMs({ timeoutMs: Number.NaN }), ACTION_TIMEOUT_DEFAULT_MS);
  assertEquals(
    actionTimeoutMs({ timeoutMs: "90000" as unknown as number }),
    ACTION_TIMEOUT_DEFAULT_MS,
  );
  assertEquals(actionTimeoutMs({ timeoutMs: 5 }), ACTION_TIMEOUT_MIN_MS);
  assertEquals(actionTimeoutMs({ timeoutMs: 90_000.7 }), 90_000);
  assertEquals(actionTimeoutMs({ timeoutMs: 10_000_000 }), ACTION_TIMEOUT_MAX_MS);
});

Deno.test("clampTimeoutMs: undefined when unusable, else clamped to MIN..MAX", () => {
  assertEquals(clampTimeoutMs(undefined), undefined);
  assertEquals(clampTimeoutMs(null), undefined);
  assertEquals(clampTimeoutMs(-5), undefined);
  assertEquals(clampTimeoutMs("60000"), undefined);
  assertEquals(clampTimeoutMs(200), ACTION_TIMEOUT_MIN_MS);
  assertEquals(clampTimeoutMs(60_000.9), 60_000);
  assertEquals(clampTimeoutMs(1e9), ACTION_TIMEOUT_MAX_MS);
});

Deno.test("an Action's declared timeoutMs is the limit for execute AND its requests", async () => {
  const app = await makeApp();
  const srv = slowServer();
  try {
    // 900 ms vendor answer: inside the Action's 4000 ms budget.
    const r = await invoke(app, inv("slow", { url: srv.url(900) }), LOCAL);
    assertEquals(r.value, { status: 200, body: "done" });
  } finally {
    await srv.close();
  }
});

Deno.test("the declared limit still fires, and names the host still being waited on", async () => {
  const app = await makeApp();
  const srv = slowServer();
  try {
    const t0 = performance.now();
    const err = await assertRejects(
      () => invoke(app, inv("slow", { url: srv.url(60_000) }), LOCAL),
      W6WError,
    );
    const took = performance.now() - t0;
    assertEquals(err.code, "fetch_timeout");
    assertEquals(err.phase, "execute");
    assert(err.message.includes('"127.0.0.1"'), err.message);
    assert(err.message.includes("4000ms"), err.message);
    assertEquals(err.details, { hosts: ["127.0.0.1"], timeoutMs: 4000 });
    assert(took >= 3900 && took < 9000, `took ${took}ms`);
  } finally {
    await srv.close();
  }
});

Deno.test("the host's per-call timeoutMs overrides the Action's declaration", async () => {
  const app = await makeApp();
  const srv = slowServer();
  try {
    const err = await assertRejects(
      () => invoke(app, inv("slow", { url: srv.url(60_000) }), { ...LOCAL, timeoutMs: 2000 }),
      W6WError,
    );
    assertEquals(err.code, "fetch_timeout");
    assert(err.message.includes("2000ms"), err.message);
  } finally {
    await srv.close();
  }
});

Deno.test("an undeclared Action under a host limit names the host it waits on", async () => {
  const app = await makeApp();
  const srv = slowServer();
  try {
    const err = await assertRejects(
      () => invoke(app, inv("plain", { url: srv.url(60_000) }), { ...LOCAL, timeoutMs: 2000 }),
      W6WError,
    );
    assertEquals(err.code, "fetch_timeout");
    assert(err.message.includes('"127.0.0.1"') && err.message.includes("2000ms"), err.message);
  } finally {
    await srv.close();
  }
});

Deno.test("a timeout with no request in flight stays hook_timeout", async () => {
  const app = await makeApp();
  const err = await assertRejects(
    () => invoke(app, inv("spin"), { ...LOCAL, timeoutMs: 300 }),
    W6WError,
  );
  assertEquals(err.code, "hook_timeout");
  assert(err.message.includes("300ms"), err.message);
});
