/**
 * Walks the conformance fixture tree and runs the validator over every file.
 * `valid/` must validate clean; `invalid/` must fail with an error whose `path`
 * contains the substring declared in `invalid/_expected.json`.
 *
 * The fixture tree itself is the contract: any spec-compliant host can run the
 * same walk against its own validator. See `tests/fixtures/README.md`.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { validateAction, validateApp, validateAuth } from "../mod.ts";
import type { ValidationResult } from "../mod.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);

type Kind = "app" | "action" | "auth";
const VALIDATORS: Record<Kind, (v: unknown) => ValidationResult> = {
  app: validateApp,
  action: validateAction,
  auth: validateAuth,
};

async function* walkJson(dir: URL): AsyncIterable<{ path: string; data: unknown }> {
  for await (const entry of Deno.readDir(dir)) {
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) {
      yield* walkJson(child);
    } else if (entry.name.endsWith(".json") && entry.name !== "_expected.json") {
      const data = JSON.parse(await Deno.readTextFile(child));
      yield { path: child.pathname, data };
    }
  }
}

function kindOf(path: string): Kind {
  if (path.includes("/app/")) return "app";
  if (path.includes("/action/")) return "action";
  if (path.includes("/auth/")) return "auth";
  throw new Error(`fixture not under app/action/auth: ${path}`);
}

Deno.test("conformance: every fixture in valid/ passes", async () => {
  for await (const { path, data } of walkJson(new URL("valid/", FIXTURES))) {
    const r = VALIDATORS[kindOf(path)](data);
    assert(r.ok, `${path} should validate but got: ${JSON.stringify(r.errors)}`);
  }
});

Deno.test("conformance: every fixture in invalid/ fails with the expected rule", async () => {
  const expected = JSON.parse(
    await Deno.readTextFile(new URL("invalid/_expected.json", FIXTURES)),
  ) as Record<string, string>;

  const seen = new Set<string>();
  for await (const { path, data } of walkJson(new URL("invalid/", FIXTURES))) {
    const rel = path.slice(path.indexOf("/invalid/") + 1);
    seen.add(rel);
    const hint = expected[rel];
    assert(hint !== undefined, `${rel}: add an entry to invalid/_expected.json`);

    const r = VALIDATORS[kindOf(path)](data);
    assertEquals(r.ok, false, `${rel} should fail but passed`);
    const hit = r.errors.some((e) => e.path.includes(hint));
    assert(hit, `${rel}: no error path contained "${hint}"; got ${JSON.stringify(r.errors)}`);
  }

  for (const key of Object.keys(expected)) {
    assert(seen.has(key), `_expected.json references missing fixture: ${key}`);
  }
});
