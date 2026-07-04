# @w6w/validator

Validate manifests against the Core **spec rules**. Distinct from the runtime loader's structural
parse: this enforces the RFC constraints and returns every problem at once.

Part of the [`core`](../../README.md) workspace.

## Usage

```ts
import { validateApp } from "@w6w/validator";

const { ok, errors } = validateApp(manifest);
// errors: [{ path: "id", message: "must be reverse-DNS (e.g. com.acme.app)" }, …]
```

## What it checks

| Function         | Enforces                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validateApp`    | reverse-DNS `id`, kebab `name`, semver `version`, 1–3 `categories`, ≤200-char `description`, required `appearance.icon` / `author.name` / `license`, `network.allow` shape |
| `validateAction` | kebab `key`, `type` ∈ `read`/`search`/`perform`, required `title`, valid `params[]`                                                                                        |
| `validateAuth`   | `key`, `type` ∈ the auth types, `displayName`; OAuth2 endpoints when `type: oauth2`; `apiKey` config when `type: apiKey`                                                   |

Each returns `{ ok, errors: { path, message }[] }`.

`validateApp` accepts unknown `categories` entries (per the
[Categories RFC](../../rfcs/categories.md), hosts MAY accept them). To warn on out-of-vocabulary
slugs, call `unknownCategories(manifest)` alongside the validator — it returns the entries that
aren't in the `CATEGORIES` constant.

## CLI

```sh
deno task validate path/to/app.json
deno task validate --kind=auth path/to/auth.yaml
deno task validate path/to/action.toml
```

`core validate <path>` (wired as `deno task validate`) loads JSON / YAML / TOML, auto-detects
whether the file is an App / Action / Auth (override with `--kind=…`), and prints every error at
once. Exits non-zero on validation failure.

## Conformance fixtures

Drop-in JSON fixtures live in [`tests/fixtures/`](./tests/fixtures/README.md). Third-party hosts can
run the same `valid/` + `invalid/` walk against their own validator to claim `manifestVersion: "1"`
compliance.

## License

MIT
