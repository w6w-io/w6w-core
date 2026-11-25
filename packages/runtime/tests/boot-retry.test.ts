/**
 * A sandbox Worker whose modules fail to READ (an OS error while importing — production saw
 * `Bad file descriptor (os error 9)` on Cloud Run) never ran the app, so `runWorker` starts it
 * again; an app's own failure is never retried.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { W6WError } from "../mod.ts";
import { runHook } from "../src/sandbox/run-hook.ts";

const health = { kind: "health", key: "ping" } as const;
const APP =
  "export default { healthChecks: [{ key: 'ping', kind: 'service', check: () => ({ state: 'ok' }) }] };";

/** A module the Worker cannot read: importing it fails with an OS error, as EBADF did. */
async function unreadable(entry: string) {
  await Deno.writeTextFile(entry, APP);
  await Deno.chmod(entry, 0o000);
}

async function withDir(fn: (dir: string, entry: string) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir, `${dir}/app.js`);
  } finally {
    await Deno.chmod(`${dir}/app.js`, 0o644).catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
}

// root reads a mode-000 file, so the OS error these two rely on cannot be produced there.
const asRoot = Deno.uid() === 0;

Deno.test({
  name: "boot retry: an OS error importing the entry is retried, then surfaced",
  ignore: asRoot,
}, async () => {
  await withDir(async (dir, entry) => {
    await unreadable(entry);
    const retries: number[] = [];
    const err = await assertRejects(
      () =>
        runHook({
          entryPath: entry,
          readScope: dir,
          selector: health,
          input: {},
          onBootRetry: (n) => retries.push(n),
        }),
      W6WError,
    );
    assert(/os error \d+/.test(err.message), err.message);
    assertEquals(retries, [1, 2]);
  });
});

Deno.test({
  name: "boot retry: a transient OS error, then a readable entry, succeeds",
  ignore: asRoot,
}, async () => {
  await withDir(async (dir, entry) => {
    await unreadable(entry);
    const retries: number[] = [];
    const out = await runHook<unknown>({
      entryPath: entry,
      readScope: dir,
      selector: health,
      input: {},
      onBootRetry: (n) => {
        retries.push(n);
        // The fault clears before the retry: the module becomes readable.
        Deno.chmodSync(entry, 0o644);
      },
    });
    assertEquals(retries, [1]);
    assert(out !== undefined);
  });
});

Deno.test("boot retry: an app's own thrown error is not retried", async () => {
  await withDir(async (dir, entry) => {
    await Deno.writeTextFile(entry, "throw new Error('boom');");
    const retries: number[] = [];
    await assertRejects(
      () =>
        runHook({
          entryPath: entry,
          readScope: dir,
          selector: health,
          input: {},
          onBootRetry: (n) => retries.push(n),
        }),
      W6WError,
      "boom",
    );
    assertEquals(retries, []);
  });
});
