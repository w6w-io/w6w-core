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
# how `@w6w/*` imports resolve: the sibling checkout (default) or approved JSR specifiers
deno run -A packages/app-build/cli.ts <app-dir> -o out --resolution registry
# check an app directory without keeping any output
deno run -A packages/app-build/cli.ts --validate <app-dir>
```

Flags: `-o/--out <dir>` (default `./out`), `--minify` (default) / `--no-minify`, `--sourcemap`,
`--resolution sibling|registry` (default `sibling`), `--validate <app-dir>`, `--concurrency N`
(`--pack` only, default 8), `--help`. Anything else — including an unknown `--resolution` value — is
a usage error (exit 2).

## Requirements

- **Sibling layout** (default `resolution: "sibling"`). Each app's `deno.json` maps `@w6w/types` to
  the sibling core checkout (`../../../core/packages/types` for flat apps,
  `../../../../core/packages/types` for provider apps), so the pack must sit beside a core checkout
  for that path to resolve. `--resolution registry` drops that requirement — see below.
- **`--unstable-worker-options`.** Describing a bundle runs it in a permission-restricted Worker,
  which Deno only allows with that flag. `cli.ts` therefore re-runs itself once with the flag
  (marker env `W6W_APP_BUILD_REEXEC=1`), so a bare `deno run -A cli.ts …` works. Library users of
  `buildApp` must pass the flag themselves (otherwise `worker_options_required`).

## Resolution modes

`resolution` (`BuildOptions.resolution`, `PackBuildOptions.resolution`, CLI `--resolution`) picks
how an app's `@w6w/*` imports resolve. It defaults to `sibling` and that mode is unchanged: imports
come from the sibling core checkout, `deno info`/`deno bundle` run with `--no-remote`, and a
`jsr:`/`http:` module is refused exactly as before.

`resolution: "registry"` resolves the same imports from JSR instead. It is an **allowlist**, never a
blocklist: before bundling, the app's `deno.json` `imports` are read and every `@w6w/*` key must be
one of the four approved P3 keys, mapped to its pinned specifier:

```json
{
  "imports": {
    "@w6w/types": "jsr:@w6w/types@0.2.0",
    "@w6w/runtime/author": "jsr:@w6w/runtime@0.2.0/author",
    "@w6w/app-kit/poll": "jsr:@w6w/app-kit@0.1.0/poll",
    "@w6w/app-kit/webhook": "jsr:@w6w/app-kit@0.1.0/webhook"
  }
}
```

The value must be `<pkg>@<X.Y.Z>[/<sub>]` with an **exact** three-part version: `^0.2.0`, `~0.2.0`,
a range or `latest` is refused with `registry_spec_invalid`, as is any other `@w6w/*` key
(`@w6w/runtime` at the host root, `@w6w/validator`, …). Apps that import no `@w6w/*` module need no
map at all.

After the allowlist, `deno info`/`deno bundle` still run with `--no-npm` but remote resolution is
allowed, so a non-file module is accepted **only** when its URL is under
`<JSR host>/@w6w/<pkg>/<X.Y.Z>/` for a `(pkg, version)` pair the app mapped. Every other module
keeps today's refusals — `graph_npm` (`npm:`), `graph_jsr` (`jsr:` outside the map, e.g.
`@std/assert`), `graph_remote` (any other remote URL, including a mirror module for a version the
app did not map), `graph_tests`, `graph_outside_app` — and the bundle is still checked for being one
module with zero dependencies (`bundle_not_self_contained`). `resolveTypesRoot` accepts a `jsr:`
value in registry mode only; sibling mode keeps `types_root_invalid` for any URL scheme.

The JSR host is the `JSR_URL` environment variable when set, else `https://jsr.io/` (a trailing `/`
is added if missing). It is the base for both the allowlist check and Deno's own fetching, so a
local mirror plus a fresh `DENO_DIR` makes registry builds fully offline. No gate in this package
fetches the real jsr.io.

### Local JSR mirror

`tests/jsr-mirror.ts` stages a JSR layout in a temp dir and serves it on `127.0.0.1:0`. It stages
the lane's own `@w6w/types` and `@w6w/runtime` (only the `./author` entry) with their `@w6w/*`
imports rewritten to `jsr:` the way `deno publish` does, plus `@w6w/app-kit@0.1.0`: the real
`../apps/apps/_shared/{poll,webhook}/mod.ts` sources when that sibling checkout exists (checksums
computed over them), else a synthetic stand-in exporting the same `./poll` and `./webhook` keys.

As a standalone `JSR_URL`: it passes anything it does not serve — every package outside the `@w6w`
scope, and any path it lacks — through to the real JSR, so a manual `--resolution registry`
rehearsal is:

```bash
deno run -A --no-lock packages/app-build/tests/jsr-mirror.ts   # serves until killed, prints JSR_URL=http://127.0.0.1:<port>/
JSR_URL=http://127.0.0.1:<port>/ deno run -A packages/app-build/cli.ts <app-dir> -o out --resolution registry
```

`JSR_MIRROR_OFFLINE=1` 404s those unserved paths instead of proxying (a fully offline run).
`startMirror()` defaults to offline so no test touches the network — tests import `startMirror` from
the same file, which has no side effects off `import.meta.main` — and its `offline`/`upstream`
options opt a caller back in.

## Validating an app

```bash
deno run -A packages/app-build/cli.ts --validate <app-dir> [--resolution sibling|registry]
```

Builds the app into a throwaway out root, reads the built `manifest.json` back off disk, runs the
artifact parser the server publishes with (`parseAppArtifactManifest` from `@w6w/types`) over it and
prints exactly that result as one JSON line:

```text
{"ok":true,"id":"io.example.app","version":"1.0.0"}
{"ok":false,"errors":[{"code":"graph_npm","message":"…"}]}
```

Exit `0` for `{"ok":true,…}`, `1` for `{"ok":false,…}`, `2` on a usage problem. The codes are the
build's own refusal codes (see below) plus `invalid_manifest` for a built manifest the parser
rejects. Nothing is left behind: the temp out root is always removed, `./out` is never touched,
`-o|--out` and `--pack` are usage errors, and `--minify`/`--no-minify`, `--sourcemap` and
`--resolution` are forwarded to the build. From a library, `validateApp(appDir, opts)` (exported by
`mod.ts`) takes `BuildOptions` and returns the same object; it reports refusals rather than
throwing.

## Provider folders and shared files

Pack entries can point to nested apps such as `./apps/google/gmail`. Each app keeps its own
`package.json`, identity, version, entry module, import map, and standalone artifact. To include
shared source and assets, declare their directories in that app's `package.json`:

```json
{ "w6w": { "build": { "include": ["../_shared"] } } }
```

For example, `apps/google/gmail/auth/oauth2.ts` can import `../../_shared/oauth2.ts`, and its
manifest can reference `../_shared/icon.svg`. Includes are directories within the app's parent,
explicitly declared per consumer; the parent itself, app directory, overlapping includes, missing
paths, and symlink directories are rejected (`shared_path_invalid`). Undeclared imports, test
imports, remote dependencies, symlinks in source trees, and asset size limits retain their existing
checks. Included source is bundled, local images are inlined, and the resulting app needs no
provider folder at runtime. Source loading also grants the worker read access to exactly the app and
its declared shared directories.

The source digest includes all non-test files from declared directories, including assets. Shared
apps use digest paths `app/<path>` and `shared/<sorted-root-index>/<path>`; apps without includes
retain their existing digest format. Source map paths remain relative to the app.

## `index.json`

```json
{ "apps": [{ "id", "version", "execSha256", "digest", "digestVersion", "sourceDigest" }],
  "failures": [{ "path", "code", "message" }] }
```

Written in both modes; `apps` sorted by id then version, `failures` by path. It holds no absolute
paths, so two runs into different out dirs are byte-identical.

## Output warnings

A build also checks each action's and trigger's declared `output` and warns — it **never fails the
build**, and the exit code is unchanged (`0` on a warnings-only build):

- **no `output`** — the key is absent. `output: []` (deliberately returns nothing) and `{ source }`
  (a dynamic output) do not warn.
- **`items` on a non-array field** — an output field (at any nesting depth) declares `items` while
  its `type` is not `"array"`.
- **`sample` does not match `output`** — the `sample` lacks a declared key or has a different type
  (compared with `compareOutputShape` from `@w6w/types`; one level of `items`). Extra sample keys
  and an absent `sample` do not warn.

`buildApp` returns them in `warnings` (absent when there are none). The CLI prints exactly one
stderr line per app with warnings, giving the app path and the counts of actions and triggers
without output, of samples not matching their output and of `items` on a non-array field.
`index.json` carries no warnings.

## Exit codes

`0` all built · `1` any build failure (one stderr line per failure: `<path>: <code>: <message>`; the
other apps still build; warnings never change it) · `2` usage error. `--validate` uses the same
`0`/`2` and exits `1` when its one JSON line says `{"ok":false,…}`.

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
deno task parity [--pack <file>] [--concurrency N] [--out <dir>]
```

Builds the whole pack (default `../../../apps/w6w-pack.json`), then for every app proves
`describe(bundle)` deep-equals `describe(source)` (actions, auth, triggers, healthChecks,
interfaces), the artifact manifest parses, and `app.js` matches its recorded sha-256. Last line:
`parity: total=N built=N equal=N mismatched=0 failed=0`; exit 0 only when all hold. It is not part
of `deno task test`. Pass `--out` to retain the verified artifacts and `index.json`; otherwise
temporary output is removed.

## Cross-mode parity

The same authored files built once with `resolution: "sibling"` and once with
`resolution: "registry"` produce the same artifact, as long as only the app's `deno.json` differs
between the two trees (sibling paths vs. the P3 `jsr:` values):

- `app.js` is **byte-identical**;
- `execSha256` is **equal** (and still the sha-256 of those very bytes);
- the registry content **digest** is **equal** (`digestVersion` 2) — the same `manifest.json`
  describes the same artifact;
- `sourceDigest` **differs**, because the source digest covers the app tree including its
  `deno.json`, and the two `deno.json` files differ. That is expected, not a leak.

`tests/standalone-parity.test.ts` asserts all four against the local JSR mirror, with a per-mode
`DENO_DIR` and a negative control (one changed authored byte must change `app.js`). If `app.js` ever
differs, resolution has leaked into the bundle.
