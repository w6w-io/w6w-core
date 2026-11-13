#!/usr/bin/env -S deno run -A
/**
 * w6w-app-build — build app directories into self-contained artifacts.
 *
 * Usage:
 *   cli.ts <app-dir> [-o <dir>] [--minify|--no-minify] [--sourcemap]
 *          [--resolution sibling|registry]
 *   cli.ts --pack <w6w-pack.json> [-o <dir>] [--minify|--no-minify] [--sourcemap]
 *          [--resolution sibling|registry] [--concurrency N]
 *   cli.ts --validate <app-dir> [--minify|--no-minify] [--resolution sibling|registry]
 *
 * Writes `<out>/<id>/<version>/…` and `<out>/index.json`. Exit 0 ok, 1 any build failure
 * (one stderr line per failure), 2 usage error.
 *
 * `--resolution` picks how `@w6w/*` imports resolve: `sibling` (the default: the lane's own
 * packages) or `registry` (the approved `jsr:` specifiers of P3 only).
 * `--validate` builds the app into a throwaway out root, checks the built manifest with the
 * server's artifact parser and prints exactly that result as one JSON line: exit 0 if
 * `{"ok":true,…}`, 1 if `{"ok":false,"errors":[…]}`, 2 on a usage problem. No output is left.
 *
 * Deno refuses `Worker` permission options without `--unstable-worker-options`; this CLI
 * re-runs itself once with the flag (marker env `W6W_APP_BUILD_REEXEC=1`), so a bare
 * `deno run -A cli.ts …` works.
 */
import {
  buildApps,
  buildPack,
  type PackReport,
  type Resolution,
  validateApp,
  type ValidateResult,
} from "./mod.ts";

const USAGE = `usage: cli.ts <app-dir> | --pack <file>  [-o|--out <dir>] [--minify|--no-minify]
                [--sourcemap] [--resolution sibling|registry]
                [--concurrency N (--pack only)]
       cli.ts --validate <app-dir> [--minify|--no-minify] [--resolution sibling|registry]
       cli.ts --help
`;

const RESOLUTIONS: Resolution[] = ["sibling", "registry"];

interface Parsed {
  appDir?: string;
  pack?: string;
  out: string;
  /** Whether `-o|--out` was given explicitly (defaults are not a usage clash). */
  outGiven: boolean;
  minify: boolean;
  sourcemap: boolean;
  resolution: Resolution;
  validate: boolean;
  concurrency?: number;
  help: boolean;
}

/** Hand-rolled parser; returns an error string on any usage problem. */
export function parseArgs(argv: string[]): Parsed | string {
  const p: Parsed = {
    out: "./out",
    outGiven: false,
    minify: true,
    sourcemap: false,
    resolution: "sibling",
    validate: false,
    help: false,
  };
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
      case "--validate":
        p.validate = true;
        break;
      case "--resolution": {
        const v = value();
        if (v === undefined) return `--resolution needs a value`;
        if (!RESOLUTIONS.includes(v as Resolution)) {
          return `--resolution must be one of ${RESOLUTIONS.join("|")}, got: ${v}`;
        }
        p.resolution = v as Resolution;
        break;
      }
      case "-o":
      case "--out": {
        const v = value();
        if (v === undefined) return `${a} needs a value`;
        p.out = v;
        p.outGiven = true;
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
  if (p.validate) {
    if (p.pack !== undefined) return "--validate takes an <app-dir>, not --pack";
    if (p.outGiven) return "--validate does not take -o|--out";
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
  const opts = {
    minify: p.minify,
    sourcemap: p.sourcemap,
    resolution: p.resolution,
    concurrency: p.concurrency,
  };
  if (p.validate) {
    let result: ValidateResult;
    try {
      result = await validateApp(p.appDir!, opts);
    } catch (e) {
      console.error(`${p.appDir}: unexpected: ${(e as Error).message}`);
      Deno.exit(1);
    }
    // Exactly the `validateApp` result, one line: `{"ok":true,…}` or `{"ok":false,"errors":[…]}`.
    console.log(JSON.stringify(result));
    Deno.exit(result.ok ? 0 : 1);
  }
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
  for (const b of report.built) {
    const c = b.result.outputWarnings;
    if (b.result.warnings === undefined) continue;
    console.error(
      `${b.path}: warnings: ${b.result.warnings.length}` +
        (c
          ? `; ${c.actionsWithoutOutput} actions and ${c.triggersWithoutOutput} triggers without output` +
            `; ${c.sampleMismatches} samples not matching output` +
            `; ${c.itemsOnNonArray} items on a non-array field`
          : "") +
        ` (never fails the build)`,
    );
  }
  console.log(`built ${report.index.apps.length}/${report.total} → ${p.out}/index.json`);
  Deno.exit(report.index.failures.length > 0 ? 1 : 0);
}

if (import.meta.main) await main();
