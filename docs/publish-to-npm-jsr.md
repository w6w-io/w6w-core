---
id: null
key: "build-a-w6w-app/publish-to-npm-jsr"
title: "Publish to npm or JSR"
section: "build-apps"
description: "Ship a prebuilt w6w package to npm or JSR: build a pack with `w6w apps package`, then publish the `w6w/` tree yourself with `npm publish` or `deno publish`."
format: "markdown"
shared: true
sourceRepo: null
sourcePath: null
sourceSha: null
sourceRefSha: null
sourceUrl: null
syncedAt: null
createdAt: null
updatedAt: null
---

# Publish to npm or JSR

A w6w **package** is a distribution channel for apps: the same app-build artifacts you would upload
by hand, laid out at the package root and published to the npm registry or to JSR. A host that knows
the package source scheme (`npm:` / `jsr:`) resolves the package, verifies it and registers the apps
inside — see the [Registry RFC amendment on npm and JSR package sources](../rfcs/registry.md).

A package is a **transport, not a build host**. It is *prebuilt*: it carries `w6w/index.json` and
the `app.js` bundles the builder produced, and nothing that has to be installed, linked or compiled
at the far end. That is why a package may carry **no dependencies at all**, and why an installed app
keeps running with no network access to the registry it came from.

## 1. Build the apps into a pack

Start from the app source you would build with `w6w apps build` (see
[Build a w6w App](./build-a-w6w-app.md)). A **pack file** — by convention `w6w-pack.json` —
lists the apps to ship; every `path` is relative to the pack file:

```json
{
  "apps": [
    { "path": "apps/sendgrid" },
    { "path": "apps/eventbrite" }
  ]
}
```

`w6w apps build` adds an entry to a pack as it builds, so a multi-app source keeps the file up to
date. Keep the pack in version control: it is the input `w6w apps package` reads.

## 2. Package the pack

```bash
w6w apps package w6w-pack.json --out dist
```

`w6w apps package <pack> [-o|--out <dir>] [--name <pkg>] [--version <v>]
[--resolution sibling|registry] [--builder <spec>]` runs the **same builder as `w6w apps build`**
(default spec `jsr:@w6w/app-build@0.2.0/cli`) over every app the pack lists, and assembles the
publishable tree under `<out>`. It needs Deno on the machine, and it never publishes anything —
publishing is the one step you run yourself, below.

- `--out` — output directory; defaults to `dist`.
- `--resolution` — how `@w6w/*` imports inside the apps resolve: `registry` (published `jsr:`
  packages) or `sibling` (a monorepo checkout). Absent, it is chosen per app from that app's
  `deno.json` — `registry` when `@w6w/types` maps to a `jsr:` specifier, else `sibling`.
- `--builder` — override the builder spec (a local path or `file:` spec runs with its nearest
  `deno.json`).
- `--name` / `--version` — the **package** identity, used only when the command has to write
  `package.json` / `jsr.json` (see step 3). They do not change any app's own version: each app's
  `<version>` comes from the builder, i.e. from the app source.

The command is all-or-nothing. It builds into a staging directory and moves the result into place
only when **every** app succeeded; on any failure it exits non-zero, prints one line per failure and
writes nothing under `<out>/w6w`. A previous `<out>/w6w` from an earlier run is left as it was.

## 3. The `w6w/` layout

The output tree is the w6w package format — the only thing a host reads:

```
dist/
  w6w/
    index.json
    <id>/<version>/manifest.json
    <id>/<version>/app.js
    <id>/<version>/app.js.map        # optional, when the build emitted one
  package.json                      # written when absent — see step 4
  jsr.json                          # written when absent — see step 4
```

`w6w/index.json` is the app-build `PackIndex` and the package's manifest of contents:

```json
{
  "apps": [
    { "id": "com.example.sendgrid", "version": "1.4.0", "execSha256": "…", "digest": "…", "digestVersion": 1, "sourceDigest": "…" }
  ],
  "failures": []
}
```

An app is installable from the package **only if the index names it**, and its paths are derived
from `<id>` and `<version>`. The host refuses a non-empty `failures` list, malformed or duplicate
entries, hashes that are not lowercase hex, and `<id>`/`<version>` segments that would be unsafe as
path components. A package with no `w6w/index.json` is not a w6w package at all.

`execSha256` is the sha-256 of the exact `app.js` bytes written for that app — the CLI hashes the
file it wrote and refuses a builder-reported value that disagrees. Hosts check it again before an
app is admitted, so never edit a built `app.js` in place; rebuild instead.

## 4. The root metadata rules (P2)

Each registry imposes rules on the package root, and **both** are checked twice: by
`w6w apps package` before it writes anything, and by the host before it extracts anything. An
existing file is never rewritten — the command validates it and leaves it byte-identical, so you
can hand-tune it and re-run the packaging.

**npm** — `package.json`:

- carries the keyword `"w6w-app"`;
- carries **no dependency field at all**: `dependencies`, `devDependencies`, `optionalDependencies`,
  `peerDependencies`, `bundledDependencies`, `bundleDependencies` must be **absent**, not merely
  empty;
- no `imports` value that starts with `npm:` or `jsr:`;
- lists the payload, so the published tarball carries it: `"files": ["w6w/"]`.

Written by the command when absent:

```json
{
  "name": "w6w-apps-my-pack",
  "version": "0.1.0",
  "keywords": ["w6w-app"],
  "files": ["w6w/"]
}
```

The default `name` is `w6w-apps-<pack-directory>`, normalized to lowercase `[a-z0-9._-]`; the
default `version` is `0.1.0`. Pass `--name`/`--version` to pick your own.

**JSR** — `jsr.json` (or `deno.json`/`deno.jsonc`; the first one present wins and is the file JSR
uses):

- `"exports": "./w6w/index.json"` — the package's single entry point is the index;
- `"publish": { "include": [<that config file>, "w6w/"] }`;
- `"license"` — an SPDX identifier. JSR refuses a package that does not name a license, so the
  command always writes one (`--license <spdx>`, default `UNLICENSED`);
- no `imports` value that starts with `npm:` or `jsr:` — the apps are prebuilt, so a package that
  would pull dependencies at publish or install time is refused.

Written by the command when no JSR config file exists:

```json
{
  "name": "@w6w-apps/my-pack",
  "version": "0.1.0",
  "license": "UNLICENSED",
  "exports": "./w6w/index.json",
  "publish": { "include": ["jsr.json", "w6w/"] }
}
```

A bare `--name` becomes `@w6w-apps/<name>` with a leading `w6w-apps-` stripped; a name that already
starts with `@` is used as written (JSR names are always `@<scope>/<name>`).

`license` is an SPDX identifier such as `MIT` or `Apache-2.0`: pass `--license <spdx>` to pick your
own, or leave it and accept the default `UNLICENSED` — the identifier a package with no offered
license must carry. The field is not decoration: a package whose license is missing fails
`deno publish --dry-run` (and the publish after it), so check it before the version number is spent.
Like every other generated file the config is only written when absent — an existing `jsr.json` is
validated and left byte-identical, so if you hand-tune one, keep a `license` in it.

### The no-dependencies refusal

A w6w package is self-contained: there is no `node_modules`, no install step, no lifecycle script
and no transitive graph to audit. Nothing in the package may need one at run time — anything an app
uses at run time belongs in the app's own bundle, produced by the builder. The CLI states that
refusal once, before writing anything:

```
packaging failed; nothing was written:
  - package.json: `dependencies` is not allowed (even empty)
  - jsr.json: import `@std/path` points at an npm:/jsr: specifier
```

A package the CLI did not validate is refused by the **host** with `npm_dependencies_forbidden`
(npm) — the package as a whole, none of its apps. This is not a review decision you can appeal: it
is the format.

## 5. Publish it yourself

`w6w apps package` **never publishes**. From the output directory:

```bash
cd dist
npm publish                       # to registry.npmjs.org, or your configured registry
```

or, for JSR:

```bash
cd dist
deno publish --dry-run            # validates the package without publishing it
deno publish
```

`npx jsr publish` is the same publish with the Node toolchain. The dry run is worth making part of
your release script: it is the only step that catches "JSR will not accept this shape" (a non-public
package name, an `exports` that does not exist in `publish.include`, a scope you don't own) before
the version number is spent. A version published to npm or JSR is immutable — publish `0.1.1`, not
`0.1.0` again.

Publish the source repo too if the apps are open source; the package is the artifact, the app source
is the review trail.

## 6. What users write to install it

A package source reference is:

```
npm:<name>[@<range|tag>][#<app-id>]
jsr:@<scope>/<name>[@<range>][#<app-id>]
```

- `@<range|tag>` — optional. On npm a SemVer range or a dist-tag (`1.4`, `^1.4.0`, `next`); on JSR
  a SemVer range. Absent, the resolver takes npm's `latest` dist-tag, or on JSR the highest
  non-yanked, non-prerelease version. **Pin what you promise:** a range is a request, and the host
  records the exact package version it landed on as the resolved revision. A refresh compares
  revisions, not ranges — moving the `latest` tag forward does not change an installed app; a new
  version inside a range is picked up by an explicit refresh.
- `#<app-id>` — optional, and recommended for a pack that ships more than one app: it selects one
  app out of the package's own index. It is **not** a subpath — the resolver always returns the
  package root and the selector is applied to the index entries. Without it, a multi-app package
  installs every app the index names.

So `npm:@acme/w6w-apps@^2.0.0#com.acme.sendgrid` is "the `com.acme.sendgrid` app of the npm package
`@acme/w6w-apps`, as of 2.x", and `jsr:@acme/w6w-apps@2.0.0` is "every app in that exact JSR
package version".

The host that resolves it talks to exactly two registries, both operator-configurable:
`W6W_NPM_REGISTRY` (default `https://registry.npmjs.org`) and `W6W_JSR_URL` (default
`https://jsr.io`). A package fetched with a source token is a **private** package: the token travels
as `Authorization: Bearer` and nothing else does — a `npm:`/`jsr:` source is never sent an ambient
host credential, so a package install cannot borrow the host's own identity.

## 7. What the host checks (and refuses)

Before an app is admitted:

1. the bytes of `w6w/<id>/<version>/app.js` hash to the index entry's `execSha256` **and** to the
   manifest's own `exec.sha256`;
2. the version's content `digest` matches the index entry.

Archive fetches verify the upstream's integrity metadata (SRI) before extraction, enforce a size
cap, and follow redirects only within the configured registry. The refusal codes you may see:

| code | means |
| --- | --- |
| `bad_ref` | the reference is not a package ref (bad grammar, unknown scheme) |
| `not_a_w6w_package` | the archive has no `w6w/index.json` |
| `npm_dependencies_forbidden` | the package would carry dependencies (a dependency field on npm, a `npm:`/`jsr:` import on JSR) |
| `integrity_mismatch` | an `app.js` or version digest disagrees with the index |
| `bad_package` | bad archive, bad root metadata or a malformed index — the package as a whole is refused |
| `too_large` | the archive exceeds the size cap |
| `off_registry` | a redirect (or a fetch) left the configured registry |

A package-level refusal admits **none** of its apps. Installing from a package grants it nothing
beyond the apps the operator asked for: the apps still pass the namespace gate like any other
registration, and an npm scope or JSR scope is **not** a w6w namespace.

## Checklist

- [ ] Pack file lists every app to ship; each app builds with `w6w apps build`.
- [ ] `w6w apps package w6w-pack.json --out dist` exits 0.
- [ ] `dist/w6w/index.json` names each app with its `execSha256`; `failures` is empty.
- [ ] `package.json` has `keywords: ["w6w-app"]`, `files: ["w6w/"]` and no dependency field.
- [ ] `jsr.json` (or `deno.json`) has `exports: "./w6w/index.json"`,
      `publish.include: [<config>, "w6w/"]` and a `license` (`--license <spdx>`, default
      `UNLICENSED`), and no `npm:`/`jsr:` imports.
- [ ] `deno publish --dry-run` passes in the output directory — a missing `license` is one of the
      things it fails on.
- [ ] `npm publish` / `deno publish` ran from the output directory, a **new** version each time.
- [ ] The release notes say which package ref to install (`npm:<name>@<version>#<app-id>`).

## Reference

- Package format, ref grammar, integrity and provenance:
  [Registry RFC — npm and JSR package sources](../rfcs/registry.md)
- Building the apps themselves: [Build a w6w App](./build-a-w6w-app.md)
- The commands themselves: `w6w apps package --help`, `w6w apps search --help`
