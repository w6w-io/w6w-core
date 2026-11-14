/**
 * F-3 pack sanity — the first-party apps pack must load inside the Worker under the DEFAULT
 * memory cap. Opt-in (needs a sibling `packages/apps` checkout): set `W6W_PACK_DIR` to the pack
 * root (dir holding w6w-pack.json). Loads the heaviest apps (most action files) plus an evenly
 * spaced sample through `describeApp` (the real Worker import path) and asserts each stays well
 * below the cap by sampling process RSS growth.
 */
import { assert } from "jsr:@std/assert@^1.0.0";
import { join } from "jsr:@std/path@^1.0.0";
import { DEFAULT_APP_MEMORY_MB, describeApp } from "../src/sandbox/run-hook.ts";

const PACK = Deno.env.get("W6W_PACK_DIR");

async function countFiles(dir: string): Promise<number> {
  let n = 0;
  for await (const e of Deno.readDir(dir)) {
    if (e.isDirectory) n += await countFiles(join(dir, e.name));
    else if (e.name.endsWith(".ts")) n++;
  }
  return n;
}

Deno.test({
  name: "pack sample loads in a Worker well below the default memory cap",
  ignore: !PACK,
  fn: async () => {
    const pack = JSON.parse(await Deno.readTextFile(join(PACK!, "w6w-pack.json")));
    const dirs: string[] = pack.apps.map((a: { path: string }) => join(PACK!, a.path));
    const sized: [number, string][] = [];
    for (const d of dirs) {
      try {
        sized.push([await countFiles(d), d]);
      } catch { /* missing dir */ }
    }
    sized.sort((a, b) => b[0] - a[0]);
    const heavy = sized.slice(0, 8).map((s) => s[1]);
    const step = Math.max(1, Math.floor(sized.length / 24));
    const sample = sized.filter((_, i) => i % step === 0).map((s) => s[1]);
    const picked = [...new Set([...heavy, ...sample])];
    assert(picked.length >= 20, `only ${picked.length} apps picked`);
    let worst = 0, worstApp = "", ok = 0;
    const failures: string[] = [];
    for (const dir of picked) {
      const entry = join(dir, "index.ts");
      const base = Deno.memoryUsage().rss;
      let peak = 0;
      const t = setInterval(() => {
        peak = Math.max(peak, Deno.memoryUsage().rss - base);
      }, 10);
      try {
        await describeApp(entry, [PACK!], 60_000);
        ok++;
      } catch (e) {
        // Only a memory-cap kill is a failure here; an app that needs its build-time import map
        // (e.g. `@w6w/app-kit/*`, resolved by app-build, not by a bare Worker import) is not.
        const err = e as { code?: string; message: string };
        if (err.code === "memory_limit_exceeded") failures.push(`${dir}: ${err.message}`);
        else console.log(`  skipped (unresolved import): ${dir}`);
      } finally {
        clearInterval(t);
      }
      const mb = peak / 1048576;
      if (mb > worst) [worst, worstApp] = [mb, dir];
    }
    console.log(
      `pack-sanity: ${ok}/${picked.length} loaded; worst RSS growth ${
        worst.toFixed(0)
      } MiB (${worstApp}); cap ${DEFAULT_APP_MEMORY_MB} MiB`,
    );
    for (const f of failures) console.log("  fail:", f);
    assert(ok >= 20, `only ${ok}/${picked.length} apps loaded; the memory check proves nothing`);
    assert(failures.length === 0, failures.join("\n"));
    assert(worst < DEFAULT_APP_MEMORY_MB / 2, `worst ${worst} MiB is within 2x of the cap`);
  },
});
