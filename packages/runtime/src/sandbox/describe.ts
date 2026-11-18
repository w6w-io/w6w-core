/**
 * The describe projection: an imported `AppDefinition` → its serializable {@link DescribedApp}.
 *
 * One implementation for both describe paths — the Deno sandbox worker (`worker.ts`) calls it
 * directly, and the Node path (`node-describe.ts`) ships its SOURCE TEXT into a
 * `node:worker_threads` Worker. That is why {@link projectDescription} must stay
 * self-contained: no imports, no module-level helpers, no free variables but JS globals — the
 * hook-kind lists arrive as arguments, so `projectDescription.toString()` is a complete function
 * even after a bundler has inlined this module.
 */
import { AUTH_HOOK_KINDS, TRIGGER_HOOK_KINDS } from "@w6w/types";
import type { AppDefinition } from "@w6w/types";
import type { DescribedApp } from "./protocol.ts";

/**
 * Strip every function out of `app`, keeping plain config (JSON round-trip) plus which hooks
 * each auth/trigger defines. SELF-CONTAINED: see the module comment before editing.
 */
export function projectDescription(
  // deno-lint-ignore no-explicit-any
  app: any,
  authHookKinds: readonly string[],
  triggerHookKinds: readonly string[],
): DescribedApp {
  // Strip all functions to plain config via JSON round-trip.
  // deno-lint-ignore no-explicit-any
  const actions = (app.actions ?? []).map((a: any) =>
    JSON.parse(JSON.stringify({
      ...a,
      execute: undefined,
      // Explicit: a hand-written non-function `resolveFields` must not survive,
      // and an action without the hook keeps the key absent (digests stable).
      resolveFields: typeof a.resolveFields === "function" ? true : undefined,
    }))
  );
  // deno-lint-ignore no-explicit-any
  const auth = (app.auth ?? []).map((a: any) => {
    const present = authHookKinds.filter((k) => typeof a[k] === "function");
    const config = { ...a } as Record<string, unknown>;
    for (const k of authHookKinds) delete config[k];
    return { auth: JSON.parse(JSON.stringify(config)), hooks: present };
  });
  // deno-lint-ignore no-explicit-any
  const triggers = (app.triggers ?? []).map((t: any) => {
    const present = triggerHookKinds.filter((k) => typeof t[k] === "function");
    const config = { ...t } as Record<string, unknown>;
    for (const k of triggerHookKinds) delete config[k];
    return { trigger: JSON.parse(JSON.stringify(config)), hooks: present };
  });

  // deno-lint-ignore no-explicit-any
  const declared = (app.healthChecks ?? []).map((h: any) => {
    const config = { ...h } as Record<string, unknown>;
    delete config.check;
    return {
      check: JSON.parse(JSON.stringify(config)),
      hasHook: typeof h.check === "function",
    };
  });
  // Tagged Actions become checks too, so the health surface is one list
  // regardless of how the publisher authored it.
  const tagged = (app.actions ?? [])
    // deno-lint-ignore no-explicit-any
    .filter((a: any) => a.healthCheck)
    // deno-lint-ignore no-explicit-any
    .map((a: any) => ({
      check: JSON.parse(JSON.stringify({
        kind: "dependency",
        ...a.healthCheck,
        key: a.healthCheck.key ?? a.key,
        title: a.healthCheck.title ?? a.title,
      })),
      hasHook: typeof a.execute === "function",
    }));

  // A conformance is inert data — there is no hook to strip, so the JSON
  // round-trip here only guards against non-serializable values on interfaces.
  return {
    actions,
    auth,
    triggers,
    healthChecks: [...declared, ...tagged],
    interfaces: JSON.parse(JSON.stringify(app.interfaces ?? [])),
  };
}

/** {@link projectDescription} with the canonical hook-kind lists from `@w6w/types`. */
export function describeAppDefinition(app: AppDefinition): DescribedApp {
  return projectDescription(app, AUTH_HOOK_KINDS, TRIGGER_HOOK_KINDS);
}
