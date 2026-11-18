/**
 * `describe` — a loaded app's public description. Pure and runtime-neutral (no sandbox, no
 * `Deno`), so `@w6w/runtime/assemble` reaches it without the Deno Worker sandbox; `runtime.ts`
 * re-exports it unchanged.
 */
import type {
  Action,
  AppManifest,
  Auth,
  HealthCheck,
  InterfaceConformance,
  Trigger,
} from "@w6w/types";
import type { LoadedApp } from "./loader.ts";

export interface AppDescription {
  app: AppManifest;
  actions: Action[];
  auth: Auth[];
  triggers: Trigger[];
  /** Declared, promoted and derived checks — the whole health surface. */
  health: HealthCheck[];
  /** This app's Interface conformance assertions. */
  interfaces: InterfaceConformance[];
}

/** Return the app's public description. */
export function describe(app: LoadedApp): AppDescription {
  return {
    app: app.manifest,
    actions: [...app.actions.values()].map((a) => {
      const appPorts = app.manifest.ports;
      const actionPorts = a.definition.ports;
      if (appPorts === undefined && actionPorts === undefined) return a.definition;
      // Field-wise fold (action wins); a copy — never mutate the loaded definition.
      return { ...a.definition, ports: { ...appPorts, ...actionPorts } };
    }),
    auth: app.auths.map((a) => a.auth),
    triggers: [...app.triggers.values()].map((t) => t.trigger),
    health: [...app.healthChecks.values()].map((h) => h.check),
    interfaces: app.interfaces,
  };
}
