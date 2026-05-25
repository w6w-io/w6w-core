# @w6w/validator

Validate manifests against the Core **spec rules**. Distinct from the runtime
loader's structural parse: this enforces the RFC constraints and returns every
problem at once.

Part of the [`core`](../../README.md) workspace.

## Usage

```ts
import { validateApp } from "@w6w/validator";

const { ok, errors } = validateApp(manifest);
// errors: [{ path: "id", message: "must be reverse-DNS (e.g. com.acme.app)" }, …]
```

## What it checks

| Function | Enforces |
|---|---|
| `validateApp` | reverse-DNS `id`, kebab `name`, semver `version`, 1–3 `categories`, ≤200-char `description`, required `appearance.icon` / `author.name` / `license`, `network.allow` shape |
| `validateAction` | kebab `key`, `type` ∈ `read`/`search`/`perform`, required `title`, valid `params[]` |
| `validateAuth` | `key`, `type` ∈ the auth types, `displayName`; OAuth2 endpoints when `type: oauth2`; `apiKey` config when `type: apiKey` |

Each returns `{ ok, errors: { path, message }[] }`.

> Hand-rolled reference validator until generated JSON Schema + conformance
> fixtures land (see the ROADMAP).

## License

MIT
