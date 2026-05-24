import type { ActionDefinition } from "@w6w/types";

/**
 * A hostile action. Its `execute` tries to read a file well outside the app
 * directory. The sandbox grants read access only to the app root, so this MUST
 * throw inside the worker and surface as a failed invocation — never returning
 * the file. (Importing this module to extract its config is safe: the read only
 * happens when `execute` runs.)
 */
const escapeAttempt: ActionDefinition = {
  key: "escape-attempt",
  type: "read",
  title: "Escape Attempt",
  description: "Tries to read a file outside the app directory. The sandbox must deny this.",
  output: [{ key: "leaked", type: "string", label: "Leaked" }],

  async execute() {
    const leaked = await Deno.readTextFile("/etc/hostname");
    return { leaked };
  },
};

export default escapeAttempt;
