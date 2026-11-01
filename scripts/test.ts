/**
 * `deno task test`: the unit tests (packages/) in two tracks.
 *
 *   1. every file that does NOT touch process-global state, under `--parallel`;
 *   2. the files that do, one after another.
 *
 * `--parallel` runs test files as workers inside ONE process, so `Deno.env`, the cwd and the umask
 * are shared between files running at the same time. The `sources` tests set and restore
 * `W6W_CACHE` and the forge tokens that `tarball.ts`/`github.ts` read, so in parallel one file's
 * `set` can land inside another file's fetch. Measured on 2026-10-31 (24 cores): serial ~152s,
 * all-parallel ~44s. Same runner as w6w-server's `scripts/test.ts`.
 *
 * `DENO_JOBS` defaults to min(12, cores), the knee measured on the server suite; an explicit
 * `DENO_JOBS` wins.
 *
 * The serial track is not a hand-kept list: any file under packages/ whose source matches
 * {@link GLOBAL_STATE} goes there, so a new env-mutating test lands in the right track by itself.
 * A helper that mutates env on a test's behalf is the one shape this cannot see — call
 * `Deno.env.set` in the test file itself.
 *
 * Extra arguments are passed to both runs, e.g. `deno task test --filter "loadConfig"`.
 */

const ROOT = "packages";
const GLOBAL_STATE = /Deno\.env\.(set|delete)\(|Deno\.chdir\(|Deno\.umask\(/;
const SOURCE = /\.(ts|tsx|mts|js|mjs|jsx)$/;
const JOBS = Deno.env.get("DENO_JOBS") ?? String(Math.min(12, navigator.hardwareConcurrency));

async function* sources(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory && entry.name !== "node_modules") yield* sources(path);
    else if (entry.isFile && SOURCE.test(entry.name)) yield path;
  }
}

const serial: string[] = [];
for await (const path of sources(ROOT)) {
  if (GLOBAL_STATE.test(await Deno.readTextFile(path))) serial.push(path);
}
serial.sort();

async function run(label: string, args: string[]): Promise<boolean> {
  console.log(`\n== ${label}`);
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: ["test", "-A", "--unstable-worker-options", ...args],
    env: { DENO_JOBS: JOBS },
  }).spawn().status;
  return code === 0;
}

// `deno bundle` installs its esbuild binary into DENO_DIR on first use. On a cold cache (every CI
// runner) the app-build test files bundling in parallel race that install and fail with "failed to
// copy esbuild binary". One bundle here, before either track, installs it once.
const warm = await Deno.makeTempDir({ prefix: "w6w-bundle-warm-" });
await Deno.writeTextFile(`${warm}/entry.ts`, "export const x = 1;\n");
const warmed = await new Deno.Command(Deno.execPath(), {
  args: ["bundle", "-q", "--no-lock", "-o", `${warm}/out.js`, `${warm}/entry.ts`],
  cwd: warm,
}).output();
await Deno.remove(warm, { recursive: true });
if (!warmed.success) {
  console.error(`esbuild warm-up failed:\n${new TextDecoder().decode(warmed.stderr)}`);
  Deno.exit(1);
}

const parallelOk = await run(`parallel (${serial.length} global-state files deferred)`, [
  "--parallel",
  ...(serial.length ? [`--ignore=${serial.join(",")}`] : []),
  ...Deno.args,
  ROOT,
]);
const serialOk = serial.length === 0 ||
  await run(`serial (${serial.length} files that mutate env/cwd/umask)`, [...Deno.args, ...serial]);

Deno.exit(parallelOk && serialOk ? 0 : 1);
