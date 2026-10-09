# @w6w/app-build

Builds an app directory into a self-contained artifact:
`<out>/<id>/<version>/{manifest.json, app.js[, app.js.map]}`, plus `<out>/index.json`.

## Usage

```bash
# one app
deno run -A packages/app-build/cli.ts <app-dir> -o out
# a whole pack
deno run -A packages/app-build/cli.ts --pack ../apps/w6w-pack.json -o out [--concurrency 8]
# published form
deno run -A jsr:@w6w/app-build/cli --pack w6w-pack.json -o out
```

Flags: `-o/--out <dir>` (default `./out`), `--minify` (default) / `--no-minify`, `--sourcemap`,
`--concurrency N` (`--pack` only, default 8), `--help`.

## Requirements

- **Sibling layout.** Each app's `deno.json` maps `@w6w/types` to `../../../core/packages/types`, so
  the pack must sit beside a core checkout for that path to resolve. There is no override flag.
- **`--unstable-worker-options`.** Describing a bundle runs it in a permission-restricted Worker,
  which Deno only allows with that flag. `cli.ts` therefore re-runs itself once with the flag
  (marker env `W6W_APP_BUILD_REEXEC=1`), so a bare `deno run -A cli.ts …` works. Library users of
  `buildApp` must pass the flag themselves (otherwise `worker_options_required`).

## `index.json`

```json
{ "apps": [{ "id", "version", "execSha256", "digest", "digestVersion", "sourceDigest" }],
  "failures": [{ "path", "code", "message" }] }
```

Written in both modes; `apps` sorted by id then version, `failures` by path. It holds no absolute
paths, so two runs into different out dirs are byte-identical.

## Exit codes

`0` all built · `1` any build failure (one stderr line per failure: `<path>: <code>: <message>`; the
other apps still build) · `2` usage error.

## Refusal codes

See the `buildApp` doc comment in `mod.ts` / `src/build.ts` for the authoritative list: identity
(`invalid_id`, `invalid_version`, `npm_dependencies`, `entry_outside_app`, …), module graph
(`graph_tests`, `graph_npm`, `graph_jsr`, `graph_remote`, `graph_outside_app`, …), bundle
(`bundle_failed`, `bundle_not_self_contained`, `sourcemap_invalid`), describe
(`worker_options_required`, `describe_failed`, `load_failed`, `artifact_invalid`), assets
(`asset_*`), source digest (`source_*`), output (`write_failed`). A non-`BuildError` is
`unexpected`.

## Parity gate

```bash
deno task parity [--pack <file>] [--concurrency N]
```

Builds the whole pack (default `../../../apps/w6w-pack.json`), then for every app proves
`describe(bundle)` deep-equals `describe(source)` (actions, auth, triggers, healthChecks,
interfaces), the artifact manifest parses, and `app.js` matches its recorded sha-256. Last line:
`parity: total=N built=N equal=N mismatched=0 failed=0`; exit 0 only when all hold. It is not part
of `deno task test`.
