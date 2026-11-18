# @w6w/sources

Resolve a **source reference** to a local directory that [`@w6w/runtime`](../runtime/README.md) can
load. Keeps the runtime fetch-agnostic: this package does the cloning/downloading.

Part of the [`core`](../../README.md) workspace.

## Usage

```ts
import { resolve } from "@w6w/sources";

const a = await resolve("github:w6w-io/slack@v1.0.0"); // download + extract, cached
const b = await resolve("file:./fixtures/apps/hello"); // bare paths work too
// → both return an absolute directory path for loadApp()
```

## Resolvers

| Scheme   | Form                         | Notes                                                                                                                           |
| -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `file`   | `file:./path` or a bare path | zero-dependency; the dir lib core already consumes                                                                              |
| `github` | `github:owner/repo@ref`      | fetches the codeload tarball, gunzips + untars, strips the top component, caches by `owner/repo@ref` (`@ref` optional → `HEAD`) |

| `npm` | `npm:[@scope/]name[@range][#app-id]` | packument from `W6W_NPM_REGISTRY`; tarball verified
(`dist.integrity` sha512) before extraction | | `jsr` | `jsr:@scope/name[@range][#app-id]` | native
`meta.json` / `<v>_meta.json` / files from `W6W_JSR_URL`; each file's sha256 verified |

Dispatch is by scheme; bare paths fall to the local resolver.

## Registry packages (`npm:` / `jsr:`)

**Grammar.** `npm:[@scope/]name[@range]` and `jsr:@scope/name[@range]` (jsr names are always
scoped), with an optional `#app-id`. The name is validated before any fetch (npm rules: ≤214 chars,
lowercase, URL-safe, no leading `.` or `_`), else `bad_ref`. The `#app-id` is returned to the caller
and is never applied as a subpath. No range: npm uses the `latest` dist-tag, jsr the highest
non-yanked stable version. A range may be a dist-tag, an exact version or a semver range
(`jsr:@std/semver`); prereleases are excluded unless the range names one. jsr never picks a yanked
version; deprecated npm versions are allowed and reported. `revision` is the exact version selected.

**Config (env vars).** `W6W_NPM_REGISTRY` (default `https://registry.npmjs.org`) and `W6W_JSR_URL`
(default `https://jsr.io`). The registry origin is the only origin contacted.

**Auth.** `SourceAuth` mode `token` sends `Authorization: Bearer <token>` on every registry request;
`anonymous` and `host` send none. The token is never part of a cache path or an error message. The
cache key is partitioned by auth class and registry origin.

**Integrity.** npm: `dist.tarball` and every redirect must stay on the registry origin, else
`off_registry` (before any body is read). `dist.integrity` (sha512) is verified over the compressed
bytes before extraction (`integrity_mismatch`); compressed and decompressed bytes are both capped by
`maxBytes` (`too_large`). jsr: only the root config (`deno.json`, `deno.jsonc` — parsed with
`jsr:@std/jsonc` — or `jsr.json`) and files under `w6w/` listed in `<v>_meta.json` are fetched; each
file's sha256 and size are checked (`integrity_mismatch`) and the sum is capped by `maxBytes`. A
manifest key with `..`, encoded separators, `\`, a double slash or other escape is refused
`unsafe_entry` before any URL or path join. A failed resolve publishes no cache entry; a repeat of
the same exact version is a cache hit.

**No dependencies, no lifecycle scripts.** Nothing is installed and no package script runs. A
package is refused `npm_dependencies_forbidden` when its root `package.json` has any of the six
dependency fields (an empty `{}` included), when any archive entry path has a `node_modules`
segment, or (jsr) when root config `imports` has an `npm:`/`jsr:` value. A tarball without a usable
root `package.json`, or a jsr version without a root config, is `bad_package`.

**Error codes:** `bad_ref`, `not_found`, `off_registry`, `integrity_mismatch`, `too_large`,
`unsafe_entry`, `npm_dependencies_forbidden`, `bad_package`, `fetch_failed`, `timeout`.

**Ref validation.** The `github:`, `gitlab:` and `bitbucket:` parsers refuse an owner/repo (or
group/project) outside `[A-Za-z0-9_.-]+`, a dot-only name, and an empty, `.` or `..` segment in
`@ref`, with `SourceError("bad_ref")` (`src/refcheck.ts`: `isSafeSegment`, `isSafeGitRef`). The
tarball cache path is built from the ref, so it is also checked before any filesystem operation —
including the `force` removal — and must sit strictly inside the cache dir, else
`SourceError("unsafe_cache_path")` (`src/tarball.ts`, the `unsafe_cache_path` throw). The check is
lexical, not symlink-aware.

## Pluggable

`resolve()` picks the first registered `Resolver` whose `canResolve(ref)` is true. Add your own
(e.g. `jsr:`, `npm:`, `oci:`) without changing callers — and a built-in resolver can later be
extracted to its own package behind the same interface:

```ts
import { SourceRegistry } from "@w6w/sources";

const registry = new SourceRegistry();
registry.register(myResolver); // implements { scheme, canResolve, resolve }
await registry.resolve("oci://…");
```

Runs host-side with full permissions — source resolution is a wrapper concern, never sandboxed.

## License

MIT
