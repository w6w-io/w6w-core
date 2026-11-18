/**
 * The slice of `node:worker_threads` `sandbox/node-describe.ts` uses, attached with
 * `// @ts-types` (see `./path.d.ts` for why). Runtime behaviour is Node's own module.
 */
export interface WorkerOptions {
  workerData?: unknown;
  resourceLimits?: { maxOldGenerationSizeMb?: number };
  stdout?: boolean;
  stderr?: boolean;
}
export class Worker {
  constructor(url: URL | string, options?: WorkerOptions);
  // deno-lint-ignore no-explicit-any
  on(event: "message", listener: (value: any) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}
