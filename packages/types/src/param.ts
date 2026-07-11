/**
 * Param — declarative config for a single form field.
 * Every form surface (Action, Trigger, Auth) is an ordered `Param[]`.
 * See rfcs/param.md.
 */

export type ParamType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "multiselect"
  | "date"
  | "datetime"
  | "secret"
  | "file"
  | "json"
  | "code"
  | "group"
  | "array";

/** Type-specific render/behavior options for a param. */
export interface ParamConfig {
  /** Render as a multi-line textarea. Implied by `type: "text"`. */
  multiline?: boolean;
}

/**
 * The element schema for a `type: "array"` param — a scalar list
 * (`type: "string" | "number"`) or a list of objects (`type: "object"` with
 * `fields`, each element a record whose fields render side by side).
 */
export interface ParamItem {
  type: "string" | "number" | "object";
  /** For object items — the fields of each element. */
  fields?: Param[];
  /** Placeholder for a scalar item's input. */
  placeholder?: string;
}

/** A single choice in a static option list. */
export interface Option {
  value: string | number;
  label: string;
  description?: string;
  disabled?: boolean;
}

/** Choices populated dynamically by a hook. */
export interface DynamicOptions {
  /** Path to the hook that returns `Option[]`. Receives `{ form, dependsOn }`. */
  source: string;
  searchable?: boolean;
  cache?: "session" | "none";
}

export type Options = Option[] | DynamicOptions;

export interface Validation {
  /** String must match this regex. */
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  /** Reject floats. */
  integer?: boolean;
  /** Value must be one of these. */
  enum?: Array<string | number>;
  /** Path to a custom validator hook. Receives `{ value, form }`, returns `{ ok, message? }`. */
  hook?: string;
}

export interface Param {
  /** Machine name. Unique within the enclosing form. */
  key: string;
  label: string;
  type: ParamType;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  default?: unknown;
  /** Sensitive input: masked in UI, encrypted at rest. Implicit `true` when `type: "secret"`. */
  secret?: boolean;
  readOnly?: boolean;
  /** Allow multiple values (array of `type`). */
  repeat?: boolean;
  /** Render hint, e.g. `"textarea"`, `"radio"`, `"code:sql"`. */
  ui?: string;
  /**
   * Collapse this (optional) param under the "Additional parameters" section.
   * Required + non-advanced params show up front; ignored for required params.
   */
  advanced?: boolean;
  /**
   * Lay this param out on a shared row with adjacent params carrying the same
   * `row` id (e.g. a username/password pair side by side).
   */
  row?: string;
  /** Element schema when `type: "array"` (a scalar list or a list of objects). */
  item?: ParamItem;
  /** Type-specific render/behavior options. */
  config?: ParamConfig;
  /** Keys of other params that must be filled first; changes invalidate this one. */
  dependsOn?: string[];
  /** Conditional visibility. JSONLogic expression (per ROADMAP resolution of the open question). */
  showIf?: unknown;
  options?: Options;
  validation?: Validation;
  /**
   * Nested params, used when `type: "group"`. Combined with `repeat: true`
   * expresses a list of structured items (e.g. an array of header rows).
   */
  children?: Param[];
}

/** Narrow `Options` to the dynamic (hook-driven) form. */
export function isDynamicOptions(o: Options | undefined): o is DynamicOptions {
  return !!o && !Array.isArray(o) && typeof (o as DynamicOptions).source === "string";
}
