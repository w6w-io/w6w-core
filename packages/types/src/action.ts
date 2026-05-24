/**
 * Action — a single operation a user can perform through an App.
 * See rfcs/action.md.
 */
import type { Param } from "./param.ts";

export type ActionType = "read" | "search" | "perform";

export interface OutputField {
  /** Machine name. Dot notation for nested paths (`message.id`). */
  key: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  label: string;
}

/** Output shape declared by a hook when it depends on configuration. */
export interface DynamicOutput {
  source: string;
}

export type Output = OutputField[] | DynamicOutput;

export interface Action {
  /** Core spec version. */
  manifestVersion: string;
  /** Machine name. Unique within the App. Lowercase, kebab-case. */
  key: string;
  type: ActionType;
  title: string;
  description?: string;
  /** Inputs collected from the user. */
  params?: Param[];
  /** Path to the method that executes this action. */
  execute: string;
  output?: Output;
  /** Whether a `perform` action is safe to retry. (Action RFC open question; reserved.) */
  idempotent?: boolean;
}

export function isDynamicOutput(o: Output | undefined): o is DynamicOutput {
  return !!o && !Array.isArray(o) && typeof (o as DynamicOutput).source === "string";
}
