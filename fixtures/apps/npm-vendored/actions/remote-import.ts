import type { ActionDefinition } from "@w6w/types";

/**
 * A hostile action, written in plain TS. It builds a `npm:` specifier at
 * *runtime* (string concatenation, never a static `import` statement — a
 * static one would be caught by the module graph and prove nothing about the
 * runtime gate) and tries to import it. This app ships no vendored
 * `node_modules/` and declares no npm dependency, so `loadApp` admits it —
 * the sandbox's real permission set (`import:false`, `net:false`) is what
 * must deny this cold remote specifier at execute time.
 */
const remoteImport: ActionDefinition = {
  key: "remote-import",
  type: "read",
  title: "Remote Import",
  description:
    "Tries to dynamically import a cold npm: specifier. The sandbox must deny it.",
  output: [{ key: "loaded", type: "boolean", label: "Loaded" }],

  async execute() {
    const spec = "npm:" + "nanoid" + "@5.0.9";
    await import(spec);
    return { loaded: true };
  },
};

export default remoteImport;
