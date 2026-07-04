# @w6w/runtime

The reference **runtime** for the w6w workflow platform — transport-free "lib core". Load an app,
describe it, and invoke its actions inside a least-privilege Deno sandbox. Wrap it with an HTTP
service or CLI; the engine itself has no transport.

Part of the [`core`](../../README.md) workspace. Deno-first (the sandbox uses Deno Worker
permissions).

## Capabilities

```ts
import { describe, invoke, loadApp } from "@w6w/runtime";

const app = await loadApp("./fixtures/apps/hello"); // a local dir (fetching is a wrapper's job — see @w6w/sources)

describe(app); // { app: AppManifest, actions: Action[], auth: Auth[] } — runs no untrusted code on the host

const { value } = await invoke(app, {
  manifestVersion: "1",
  app: "io.w6w.hello",
  action: "get-greeting",
  params: { name: "Ada" },
});
```

Run with per-worker permissions enabled:

```sh
deno run --unstable-worker-options -A your-host.ts
```

## Security model

- **The action sandbox has no network and no credential.** Untrusted action code runs in a Deno
  Worker with `read` scoped to the app dir and everything else denied.
- **`ctx.fetch` is host-mediated.** Requests are proxied to the trusted host, which enforces the
  app's egress allowlist and performs the call.
- **`sign` is the only code given the credential**, and it runs in its _own_ network-less worker. So
  the credential-bearing worker can't reach the network and the networked worker has no credential —
  neither can leak it.
- **Connection lifecycle gates** (Invocation RFC step 2): `pending`/`broken`/ `revoked` are rejected
  (phase `auth`); `needs_refresh` runs the Auth `refresh` hook and proceeds with the new credential.

## What an app looks like

An app is an npm-style package: identity in `package.json` (`w6w` block), and behavior in an entry
module that default-exports `AppDefinition` — `{ actions,
auth }`. Each Action/Auth is a code module
co-locating config with its functions (`execute`, `sign`, …). See
[`@w6w/types`](../types/README.md).

## API

| Export                           | Purpose                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| `loadApp(dir)`                   | Read a packaged app → `LoadedApp` (extracts config in-sandbox). |
| `describe(app)`                  | The app's public manifest (App + Actions + Auth).               |
| `invoke(app, invocation, opts?)` | Run an action through the resolution sequence.                  |
| `W6WError`, `LoadError`          | Typed errors carrying a `code` and `phase`.                     |

## License

MIT
