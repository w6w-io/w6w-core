/**
 * `describeExec` under Node: run an exec bundle in a `node:worker_threads` Worker and return its
 * {@link DescribedApp}. Used when there is no `Deno` global — `@w6w/cli`'s in-process
 * `assembleApp` describing a developer's own built `app.js` on their own machine.
 *
 * NOT a sandbox. Node Workers have no permission model, so the bundle runs with the process's
 * full rights; what this gives is a separate isolate (the app cannot reach the caller's
 * globals), a wall-clock timeout and a V8 heap cap. That is acceptable only for code the caller
 * already trusts as their own; a host running third-party code must use the Deno sandbox path.
 *
 * Bundle-proof by construction: the Worker's module is a `data:` URL built here from
 * `projectDescription.toString()`, so nothing is resolved relative to this file.
 */
import { AUTH_HOOK_KINDS, TRIGGER_HOOK_KINDS } from "@w6w/types";
import { W6WError } from "../errors.ts";
import { projectDescription } from "./describe.ts";
import type { DescribedApp } from "./protocol.ts";

const WORKER_THREADS: string = "node:worker_threads";

/** The Worker's ESM source: import the bundle, project it, post one message back. */
function workerSource(): string {
  return [
    `import { parentPort, workerData } from "node:worker_threads";`,
    `const project = ${projectDescription.toString()};`,
    `try {`,
    `  const mod = await import(workerData.url);`,
    `  const app = mod.default ?? mod.app;`,
    `  if (!app || typeof app !== "object") {`,
    `    throw new Error("Entry module must default-export an AppDefinition object.");`,
    `  }`,
    `  parentPort.postMessage({ ok: true, value: project(app, workerData.auth, workerData.trigger) });`,
    `} catch (err) {`,
    `  parentPort.postMessage({ ok: false, name: err?.name ?? "Error",`,
    `    message: String(err?.message ?? err) });`,
    `}`,
  ].join("\n");
}

/**
 * Describe `entryUrl` (a `data:text/javascript;base64,…` module) in a Node Worker. Rejects with a
 * {@link W6WError}: `hook_timeout` after `timeoutMs`, `hook_failed` when the module throws or has
 * no app, `hook_crashed` when the Worker dies without answering.
 */
export async function describeExecNode(
  entryUrl: string,
  timeoutMs: number,
  memoryLimitMb: number,
): Promise<DescribedApp> {
  // Imported on first use, through a non-literal specifier: `// @ts-types` does not apply to a
  // dynamic import, and a literal `node:` specifier would make Deno's type checker look for
  // `@types/node` (see `../node/path.d.ts`). Bundlers leave it as a runtime import of a builtin.
  const { Worker } = (await import(WORKER_THREADS)) as typeof import("../node/worker-threads.d.ts");
  const worker = new Worker(
    new URL(`data:text/javascript,${encodeURIComponent(workerSource())}`),
    {
      workerData: { url: entryUrl, auth: [...AUTH_HOOK_KINDS], trigger: [...TRIGGER_HOOK_KINDS] },
      resourceLimits: { maxOldGenerationSizeMb: memoryLimitMb },
      stdout: false,
      stderr: false,
    },
  );
  return await new Promise<DescribedApp>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () =>
        settle(() =>
          reject(new W6WError("hook_timeout", "execute", `Worker timed out after ${timeoutMs}ms.`))
        ),
      timeoutMs,
    );
    worker.on("message", (m: { ok: boolean; value?: DescribedApp; message?: string }) => {
      settle(() =>
        m.ok
          ? resolve(m.value as DescribedApp)
          : reject(new W6WError("hook_failed", "execute", m.message ?? "describe failed", m))
      );
    });
    worker.on("error", (e: Error) => {
      settle(() =>
        reject(new W6WError("hook_crashed", "execute", e?.message || "Worker crashed."))
      );
    });
    worker.on("exit", (code: number) => {
      settle(() =>
        reject(new W6WError("hook_crashed", "execute", `Worker exited (${code}) without a result.`))
      );
    });
  });
}
