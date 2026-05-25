# @w6w/types

Shared logical model for the [w6w](https://github.com/w6w-io/w6w-core) workflow platform — the
TypeScript types for its core primitives.

Pure, dependency-free TypeScript. Consumable from Node, Deno, bundlers, and the runtime alike. App
authors use it to write strongly-typed actions and auth methods; hosts and the editor use it to
render and validate.

## Install

```sh
npm install @w6w/types      # npm
npx jsr add @w6w/types      # JSR (Deno: deno add jsr:@w6w/types)
```

## Primitives

| Type                                              | What it is                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------- |
| `AppManifest`                                     | An app's identity, presentation, and provenance.                                |
| `AppDefinition`                                   | An app's behavior — `{ actions, auth }` — exported from its entry module.       |
| `Action` / `ActionDefinition`                     | A single operation (`read` / `search` / `perform`); config + `execute`.         |
| `Auth` / `AuthDefinition`                         | A connection method; config + lifecycle hooks (`sign`, `test`, …).              |
| `Param`                                           | A declarative form field. Every form surface is a `Param[]`.                    |
| `Connection` / `RedactedConnection`               | The stored result of an auth flow; the credential is never exposed to userland. |
| `Invocation`                                      | The envelope used to call an action.                                            |
| `HookContext`, `SignHook`, `ActionExecuteHook`, … | The hook contracts.                                                             |

## Authoring an action

```ts
import type { ActionDefinition } from "@w6w/types";

interface Input {
  to: string;
  subject: string;
  body: string;
}

const sendEmail: ActionDefinition<Input> = {
  key: "send-email",
  type: "perform",
  title: "Send Email",
  params: [
    { key: "to", label: "To", type: "string", required: true },
    { key: "subject", label: "Subject", type: "string", required: true },
    { key: "body", label: "Body", type: "text", required: true },
  ],
  async execute(input, ctx) {
    // Note: no auth header — the platform's `sign` hook injects it.
    const res = await ctx.fetch("https://api.example.com/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    return { status: res.status };
  },
};

export default sendEmail;
```

## License

MIT
