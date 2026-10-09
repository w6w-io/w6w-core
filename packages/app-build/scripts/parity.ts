/**
 * Pack parity gate: build the whole pack, then for every built app prove
 * describe(bundle) deep-equals describe(source), the artifact manifest parses, and app.js
 * matches its recorded sha-256.
 *
 *   deno task parity [--pack <file>] [--concurrency N]
 */
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0";
import { describeApp, describeExec, resolveAppEntry } from "@w6w/runtime";
import { parseAppArtifactManifest, verifySha256 } from "@w6w/types";
import { buildPack, compareDescribed } from "../mod.ts";

let pack = fromFileUrl(new URL("../../../../apps/w6w-pack.json", import.meta.url));
let concurrency: number | undefined;
const args = Deno.args;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--pack" && args[i + 1]) pack = args[++i];
  else if (args[i] === "--concurrency" && /^[1-9][0-9]*$/.test(args[i + 1] ?? "")) {
    concurrency = Number(args[++i]);
  } else {
    console.error("usage: parity.ts [--pack <file>] [--concurrency N]");
    Deno.exit(2);
  }
}

const out = await Deno.makeTempDir({ prefix: "w6w-parity-" });
const offenders: string[] = [];
let equal = 0;
let mismatched = 0;
let report;
try {
  report = await buildPack(pack, out, { concurrency });
  const queue = [...report.built];
  const run = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const name = b.path;
      try {
        const pkg = JSON.parse(await Deno.readTextFile(join(b.appDir, "package.json")));
        const entry = resolveAppEntry(await Deno.realPath(b.appDir), pkg);
        const src = await describeApp(entry, await Deno.realPath(b.appDir));
        const code = await Deno.readTextFile(join(b.result.outDir, "app.js"));
        const bundle = await describeExec(code);
        const diff = compareDescribed(src, bundle);
        const parsed = parseAppArtifactManifest(
          JSON.parse(await Deno.readTextFile(join(b.result.outDir, "manifest.json"))),
        );
        const shaOk = await verifySha256(
          await Deno.readFile(join(b.result.outDir, "app.js")),
          parsed.ok ? parsed.value.exec.sha256 : "",
        );
        if (diff.length === 0 && parsed.ok && shaOk) equal++;
        else {
          mismatched++;
          offenders.push(
            `${name}: mismatch${diff.length ? ` keys=${diff.join(",")}` : ""}${
              parsed.ok ? "" : ` manifest=${parsed.errors.join("; ")}`
            }${shaOk ? "" : " sha256"}`,
          );
        }
      } catch (e) {
        mismatched++;
        offenders.push(`${name}: compare failed: ${(e as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency ?? 8, 8) }, run));
} finally {
  await Deno.remove(out, { recursive: true }).catch(() => {});
}
const failed = report.index.failures.length;
for (const f of report.index.failures) offenders.push(`${f.path}: ${f.code}: ${f.message}`);
for (const o of offenders) console.error(o);
const built = report.built.length;
console.log(
  `parity: total=${report.total} built=${built} equal=${equal} mismatched=${mismatched} failed=${failed}`,
);
Deno.exit(built === report.total && mismatched === 0 && failed === 0 ? 0 : 1);
