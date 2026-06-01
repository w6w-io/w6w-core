# @w6w/sources

Resolve a **source reference** to a local directory that
[`@w6w/runtime`](../runtime/README.md) can load. Keeps the runtime
fetch-agnostic: this package does the cloning/downloading.

Part of the [`core`](../../README.md) workspace.

## Usage

```ts
import { resolve } from "@w6w/sources";

const a = await resolve("github:w6w-io/slack@v1.0.0"); // download + extract, cached
const b = await resolve("file:./fixtures/apps/hello");  // bare paths work too
// → both return an absolute directory path for loadApp()
```

## Resolvers

| Scheme | Form | Notes |
|---|---|---|
| `file` | `file:./path` or a bare path | zero-dependency; the dir lib core already consumes |
| `github` | `github:owner/repo@ref` | fetches the codeload tarball, gunzips + untars, strips the top component, caches by `owner/repo@ref` (`@ref` optional → `HEAD`) |

Dispatch is by scheme; bare paths fall to the local resolver.

## Pluggable

`resolve()` picks the first registered `Resolver` whose `canResolve(ref)` is
true. Add your own (e.g. `jsr:`, `npm:`, `oci:`) without changing callers — and
a built-in resolver can later be extracted to its own package behind the same
interface:

```ts
import { SourceRegistry } from "@w6w/sources";

const registry = new SourceRegistry();
registry.register(myResolver); // implements { scheme, canResolve, resolve }
await registry.resolve("oci://…");
```

Runs host-side with full permissions — source resolution is a wrapper concern,
never sandboxed.

## License

MIT
