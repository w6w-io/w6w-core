import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { fromFileUrl } from "jsr:@std/path@^1.0.0";
import { invoke, loadApp, W6WError } from "../mod.ts";
import type { PublicDestinationOptions } from "../src/private-egress.ts";
import type { Connection, Invocation } from "@w6w/types";

const EGRESS_DIR = fromFileUrl(new URL("../../../fixtures/apps/egress", import.meta.url));
const HOSTS = ["169.254.169.254", "localhost", "127.0.0.1", "public.test", "rebind.test"];

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

function inv(url: string): Invocation {
  return {
    manifestVersion: "1",
    app: "io.w6w.egress",
    action: "call",
    connection: connection.id,
    params: { url },
  };
}

async function run(url: string, egressGuard: PublicDestinationOptions) {
  const app = { ...(await loadApp(EGRESS_DIR)), netAllowlist: HOSTS };
  return invoke(app, inv(url), { connection, egressGuard });
}

const never: typeof fetch = () => {
  throw new Error("fetch must not be reached");
};
const resolveTo = (map: Record<string, string[]>) => (h: string) => Promise.resolve(map[h] ?? []);

for (
  const [name, url, map] of [
    ["metadata IP literal", "http://169.254.169.254/latest/meta-data", {}],
    ["localhost:5432", "http://localhost:5432/", { localhost: ["127.0.0.1"] }],
    ["public name resolving to 10.x", "http://public.test/", { "public.test": ["10.1.2.3"] }],
  ] as const
) {
  Deno.test(`F-1 refused: ${name}`, async () => {
    const err = await assertRejects(
      () =>
        run(url, {
          allowPrivate: false,
          resolve: resolveTo(map as Record<string, string[]>),
          fetchImpl: never,
        }),
      W6WError,
    );
    assertEquals(err.code, "egress_private_denied");
  });
}

Deno.test("F-1 public host passes and the connection is pinned to the checked IP", async () => {
  const seen: { url: string; host: string | null }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    seen.push({
      url: String(input),
      host: new Headers((init as RequestInit).headers).get("host"),
    });
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  const res = await run("http://public.test:8080/x", {
    allowPrivate: false,
    resolve: resolveTo({ "public.test": ["93.184.216.34"] }),
    fetchImpl,
  });
  assert(res);
  assertEquals(seen.length, 1);
  assertEquals(seen[0].url, "http://93.184.216.34:8080/x");
  assertEquals(seen[0].host, "public.test:8080");
});

Deno.test("F-1 opt-out lets a private destination through", async () => {
  let called = 0;
  await run("http://169.254.169.254/", {
    allowPrivate: true,
    fetchImpl: () => {
      called++;
      return Promise.resolve(new Response("ok"));
    },
  });
  assertEquals(called, 1);
});

Deno.test("F-1 W6W_APP_ALLOW_PRIVATE env is the host opt-out", async () => {
  Deno.env.set("W6W_APP_ALLOW_PRIVATE", "1");
  try {
    let called = 0;
    await run("http://169.254.169.254/", {
      fetchImpl: () => {
        called++;
        return Promise.resolve(new Response("ok"));
      },
    });
    assertEquals(called, 1);
  } finally {
    Deno.env.delete("W6W_APP_ALLOW_PRIVATE");
  }
});

Deno.test("F-1 same-host redirect hop that now resolves private (rebind) is refused", async () => {
  const answers = [["93.184.216.34"], ["10.0.0.9"]];
  let fetches = 0;
  const err = await assertRejects(
    () =>
      run("http://rebind.test/start", {
        allowPrivate: false,
        resolve: () => Promise.resolve(answers.shift() ?? ["10.0.0.9"]),
        fetchImpl: () => {
          fetches++;
          return Promise.resolve(
            new Response(null, { status: 302, headers: { location: "http://rebind.test/next" } }),
          );
        },
      }),
    W6WError,
  );
  assertEquals(err.code, "egress_private_denied");
  assertEquals(fetches, 1, "first hop was sent, the rebound second hop was not");
});
