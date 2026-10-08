#!/usr/bin/env -S deno run -A
/**
 * w6w-app-build — build app directories into self-contained artifacts.
 *
 * Usage:
 *   cli.ts <app-dir> [-o <dir>] [--minify|--no-minify] [--sourcemap]
 *   cli.ts --pack <w6w-pack.json> [-o <dir>] [--minify|--no-minify] [--sourcemap]
 *          [--concurrency N]
 *
 * Writes `<out>/<id>/<version>/…` and `<out>/index.json`. Exit 0 ok, 1 any build failure
 * (one stderr line per failure), 2 usage error.
 *
 * Deno refuses `Worker` permission options without `--unstable-worker-options`; this CLI
 * re-runs itself once with the flag (marker env `W6W_APP_BUILD_REEXEC=1`), so a bare
 * `deno run -A cli.ts …` works.
 */
import { buildApps, buildPack, type PackReport } from "./mod.ts";

const USAGE = `usage: cli.ts <app-dir> | --pack <file>  [-o|--out <dir>] [--minify|--no-minify]
                [--sourcemap] [--concurrency N (--pack only)]
       cli.ts --help
`;

interface Parsed {
  appDir?: string;
  pack?: string;
  out: string;
  minify: boolean;
  sourcemap: boolean;
  concurrency?: number;
  help: boolean;
}

/** Hand-rolled parser; returns an error string on any usage problem. */
export function parseArgs(argv: string[]): Parsed | string {
  const p: Parsed = { out: "./out", minify: true, sourcemap: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (): string | undefined => {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith("-") && v !== "-")) return undefined;
      i++;
      return v;
    };
    switch (a) {
      case "--help":
      case "-h":
        p.help = true;
        break;
      case "--minify":
        p.minify = true;
        break;
      case "--no-minify":
        p.minify = false;
        break;
      case "--sourcemap":
        p.sourcemap = true;
        break;
      case "-o":
      case "--out": {
        const v = value();
        if (v === undefined) return `${a} needs a value`;
        p.out = v;
        break;
      }
      case "--pack": {
        const v = value();
        if (v === undefined) return `--pack needs a value`;
        p.pack = v;
        break;
      }
      case "--concurrency": {
        const v = value();
        if (v === undefined || !/^[1-9][0-9]*$/.test(v)) {
          return `--concurrency needs a positive integer`;
        }
        p.concurrency = Number(v);
        break;
      }
      default:
        if (a.startsWith("-")) return `unknown flag: ${a}`;
        if (p.appDir !== undefined) return `unexpected extra argument: ${a}`;
        p.appDir = a;
    }
  }
  if (p.help) return p;
  if (p.pack !== undefined && p.appDir !== undefined) return "give <app-dir> or --pack, not both";
  if (p.pack === undefined && p.appDir === undefined) return "give <app-dir> or --pack <file>";
  if (p.concurrency !== undefined && p.pack === undefined) {
    return "--concurrency requires --pack";
  }
  return p;
}

async function reexec(): Promise<never> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--unstable-worker-options", import.meta.url, ...Deno.args],
    env: { W6W_APP_BUILD_REEXEC: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await child.output();
  Deno.exit(code);
}

async function main(): Promise<never> {
  if (Deno.env.get("W6W_APP_BUILD_REEXEC") !== "1") await reexec();
  const p = parseArgs(Deno.args);
  if (typeof p === "string") {
    console.error(`error: ${p}\n${USAGE}`);
    Deno.exit(2);
  }
  if (p.help) {
    console.log(USAGE);
    Deno.exit(0);
  }
  const opts = { minify: p.minify, sourcemap: p.sourcemap, concurrency: p.concurrency };
  let report: PackReport;
  try {
    report = p.pack !== undefined
      ? await buildPack(p.pack, p.out, opts)
      : await buildApps([{ path: p.appDir!, appDir: p.appDir! }], p.out, opts);
  } catch (e) {
    console.error(`${p.pack ?? p.appDir}: unexpected: ${(e as Error).message}`);
    Deno.exit(1);
  }
  for (const f of report.index.failures) console.error(`${f.path}: ${f.code}: ${f.message}`);
  console.log(`built ${report.index.apps.length}/${report.total} → ${p.out}/index.json`);
  Deno.exit(report.index.failures.length > 0 ? 1 : 0);
}

if (import.meta.main) await main();
