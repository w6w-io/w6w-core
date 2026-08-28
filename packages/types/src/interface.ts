/**
 * Interface — a named, versioned method contract that multiple Apps may each
 * satisfy, so a host or workflow can target the CONTRACT rather than one
 * vendor's Actions. See rfcs/interface.md.
 */
import type { Param } from "./param.ts";
import type { Output } from "./action.ts"; // Output = OutputField[] | DynamicOutput (action.ts:27)

/** One method on an Interface's canonical, vendor-neutral contract. */
export interface InterfaceMethod {
  key: string;
  title?: string;
  description?: string;
  inputs: Param[];
  output?: Output;
}

/** A named, versioned method contract that multiple Apps may each satisfy. */
export interface InterfaceSpec {
  id: string; // `<name>@<major>` — e.g. "blob-store@1"
  displayName: string;
  description?: string;
  methods: InterfaceMethod[];
}

/**
 * How ONE Interface method binds to one of the DECLARING app's own Actions.
 * Structurally `FnActionImpl` (w6w-workflow/packages/types/mod.ts:353-373) MINUS
 * `uses.app`. The omission is a security boundary, not a convenience — a
 * conformance may only bind to an Action the declaring App itself owns.
 */
export interface InterfaceMethodImpl {
  uses: { action: string };
  with?: Record<string, unknown>;
  outputMap?: Record<string, unknown>;
}

/** An App's ASSERTION that its own Actions satisfy an Interface. */
export interface InterfaceConformance {
  interfaceId: string;
  /** Interface method key → this app's binding for it. */
  methods: Record<string, InterfaceMethodImpl>;
}
