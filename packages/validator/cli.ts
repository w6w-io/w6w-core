#!/usr/bin/env -S deno run --allow-read
/**
 * `core validate <path>` — load a manifest in JSON / YAML / TOML, auto-detect
 * whether it's an App, Action, or Auth (override with `--kind=…`), validate
 * against the spec rules, and print all errors at once. Exits non-zero on
 * any validation error.
 *
 * Usage:
 *   deno run --allow-read packages/validator/cli.ts path/to/app.json
 *   deno task validate path/to/auth.yaml
 *   deno task validate --kind=action my-action.toml
 */
import { parse as parseYaml } from "jsr:@std/yaml@^1.0.0";
import { parse as parseToml } from "jsr:@std/toml@^1.0.0";
import { unknownCategories, validateAction, validateApp, validateAuth } from "./mod.ts";
import type { ValidationResult } from "./mod.ts";

type Kind = "app" | "action" | "auth";

const VALIDATORS: Record<Kind, (v: unknown) => ValidationResult> = {
  app: validateApp,
  action: validateAction,
  auth: validateAuth,
};

function usage(): never {
  console.error("usage: core validate [--kind=app|action|auth] <path>");
  Deno.exit(2);
}

function parseByExt(text: string, ext: string): unknown {
  switch (ext) {
    case "json":
      return JSON.parse(text);
    case "yaml":
    case "yml":
      return parseYaml(text);
    case "toml":
      return parseToml(text);
    default:
      throw new Error(`unsupported extension: .${ext} (expected .json, .yaml, .yml, .toml)`);
  }
}

function detectKind(value: unknown): Kind {
  if (!value || typeof value !== "object") return "app";
  const v = value as Record<string, unknown>;
  const AUTH_TYPES = ["oauth2", "apiKey", "basic", "bearer", "custom"];
  const ACTION_TYPES = ["read", "search", "perform"];
  if (
    typeof v.type === "string" && AUTH_TYPES.includes(v.type) && typeof v.displayName === "string"
  ) {
    return "auth";
  }
  if (typeof v.type === "string" && ACTION_TYPES.includes(v.type) && typeof v.key === "string") {
    return "action";
  }
  return "app";
}

function main(argv: string[]): number {
  let kind: Kind | undefined;
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--kind=")) {
      const k = arg.slice("--kind=".length) as Kind;
      if (!(k in VALIDATORS)) usage();
      kind = k;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) usage();

  const [path] = positional;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const text = Deno.readTextFileSync(path);

  let value: unknown;
  try {
    value = parseByExt(text, ext);
  } catch (e) {
    console.error(`parse error: ${(e as Error).message}`);
    return 1;
  }

  const k = kind ?? detectKind(value);
  const result = VALIDATORS[k](value);

  if (!result.ok) {
    console.error(`${path}: FAIL (${k})`);
    for (const e of result.errors) {
      console.error(`  ${e.path || "<root>"}: ${e.message}`);
    }
    return 1;
  }

  console.log(`${path}: OK (${k})`);

  // Soft warning for unknown categories — doesn't change exit code, per the
  // categories RFC ("hosts MAY accept out-of-vocabulary entries").
  if (k === "app") {
    const unknown = unknownCategories(value);
    if (unknown.length > 0) {
      console.error(`  warning: unknown categories: ${unknown.join(", ")}`);
    }
  }

  return 0;
}

if (import.meta.main) {
  Deno.exit(main(Deno.args));
}

export { detectKind, main };
