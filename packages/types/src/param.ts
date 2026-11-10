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
  | "section"
  | "array";

/** Type-specific render/behavior options for a param. */
export interface ParamConfig {
  /** Render as a multi-line textarea. Implied by `type: "text"`. */
  multiline?: boolean;
  /**
   * A field with `options` (static or dynamic) renders as a combobox that also
   * accepts free text, instead of a forced select. Without it, options constrain
   * the value.
   */
  allowCustom?: boolean;
  /** Multiselect storage format. Defaults to an array; CSV preserves string-based API inputs. */
  valueFormat?: "array" | "csv";
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
  /**
   * Either the reserved string `"resolveFields"` (options come from the
   * Action's form-level `resolveFields` hook) or a `./`-relative path to a
   * per-field hook returning `Option[]` (receives `{ form, dependsOn }`).
   */
  source: string;
  /**
   * Sibling param keys whose commit triggers a refetch. Never disables the
   * field.
   */
  refreshOn?: string[];
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

/** Condition for a `when` entry; same shape as the simple `showIf` dialect. */
export interface ParamCondition {
  field: string;
  equals?: unknown;
  in?: readonly unknown[];
  notIn?: readonly unknown[];
  truthy?: boolean;
}

/** The only Param keys a `when` entry may override. */
export interface ParamOverlay {
  label?: string;
  hint?: string;
  required?: boolean;
  ui?: string;
  options?: Options;
}

/** First matching entry overlays the static param. */
export interface ParamWhen {
  if: ParamCondition;
  set: ParamOverlay;
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
   * A form renderer does not render this field: a canvas or host owns its value.
   * The value is still validated and invoked as declared (a hidden `required`
   * param is still enforced). Not `readOnly` (shown, not editable) and not
   * `advanced` (collapsed, still reachable). Not overlayable by `when`.
   */
  hidden?: boolean;
  /**
   * The authored value is one value or one expression (a literal, a template
   * string that is a single reference, or a `$`/`$expr` binding), so a picked
   * reference binds the whole value instead of being nested inside a structure.
   * Changes neither resolution nor validation. Not overlayable by `when`.
   */
  whole?: boolean;
  /**
   * Only meaningful on a `basic` auth's field: marks which half of a `basic.v1`
   * credential fills it. A `basic` auth is offered a shared credential only when
   * its two fields carry exactly one `"username"` and one `"password"`.
   */
  credentialRole?: "username" | "password";
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
  /** Conditional overlay of label/hint/required/ui/options; first match wins. */
  when?: ParamWhen[];
  validation?: Validation;
  /**
   * Nested params. Used when `type: "group"` (a nested object whose value nests
   * under this param's `key`) OR when `type: "section"` (a layout-only container
   * whose children's values live at the ENCLOSING form level — see below).
   * Combined with `repeat: true` on a `group` expresses a list of structured
   * items (e.g. an array of header rows).
   */
  children?: Param[];
  /**
   * Present only when `type: "section"` — selects the container behavior. A
   * section is a **layout-only** wrapper: unlike `group`, its `children`'s values
   * live at the ENCLOSING form level (they are NOT nested under the section's
   * `key`), so a section only groups fields visually. `"collapsible"` renders a
   * titled, collapsed-by-default disclosure; `"group"` a `layout` row/stack.
   */
  section?: "collapsible" | "group";
  /** `section: "collapsible"` only, REQUIRED there — the `<summary>` heading. */
  title?: string;
  /** `section: "collapsible"` only — optional secondary summary line. */
  subtitle?: string;
  /**
   * `section: "group"` only — `"row"` lays children side by side, `"stack"`
   * stacks them vertically. Defaults to `"stack"`.
   */
  layout?: "row" | "stack";
  /** `section: "collapsible"` only — start collapsed. Defaults to `true`. */
  collapsed?: boolean;
}

/**
 * Normalizes one authored value before a hook sees it — e.g. a pasted Google
 * Sheets URL into the bare spreadsheet id. Runs in the sandbox with the value
 * the host resolved (expressions already evaluated); throw to reject it.
 */
export type ParamParser = (value: unknown) => unknown;

/**
 * A `Param` as an app module authors it: the serializable config plus an
 * optional {@link ParamParser}. `describe()` drops the function, so the manifest
 * and the editor only ever see the plain `Param`.
 */
export interface ParamDefinition extends Omit<Param, "children"> {
  /** Optional. Applied to this param's value before `execute` / a trigger hook runs. */
  parse?: ParamParser;
  children?: ParamDefinition[];
}

/**
 * Apply every `parse` declared in `params` to `values`, returning a new object.
 * A `section`'s children parse at the same level, a `group`'s under its key
 * (each item of a `repeat` group), and a `repeat` scalar per element. An absent
 * value (`undefined`) is never passed to a parser.
 */
export async function parseParams(
  params: readonly ParamDefinition[] | undefined,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!params?.length || !values || typeof values !== "object") return values;
  let out = values;
  for (const p of params) {
    if (p.type === "section") {
      out = await parseParams(p.children, out);
      continue;
    }
    const v = out[p.key];
    if (v === undefined) continue;
    let next: unknown = v;
    if (p.type === "group" && p.children?.length) {
      const children = p.children;
      const one = (x: unknown) =>
        x && typeof x === "object" && !Array.isArray(x)
          ? parseParams(children, x as Record<string, unknown>)
          : x;
      next = Array.isArray(next) ? await Promise.all(next.map(one)) : await one(next);
    }
    if (typeof p.parse === "function") {
      const parse = p.parse;
      next = p.repeat && Array.isArray(next)
        ? await Promise.all(next.map((x) => x === undefined ? x : parse(x)))
        : await parse(next);
    }
    if (next !== v) out = { ...out, [p.key]: next };
  }
  return out;
}

/** Narrow `Options` to the dynamic (hook-driven) form. */
export function isDynamicOptions(o: Options | undefined): o is DynamicOptions {
  return !!o && !Array.isArray(o) && typeof (o as DynamicOptions).source === "string";
}

/** The two container behaviors a `type: "section"` param can take. */
export type ParamSectionKind = "collapsible" | "group";

/** A `type: "section"` param — a layout-only container of `children`. */
export interface ParamSection extends Param {
  type: "section";
  section: ParamSectionKind;
  children: Param[];
}

/** Narrow a `Param` to a `section` (layout-only container). */
export function isSection(p: Param): p is ParamSection {
  return p.type === "section";
}

/** True iff `o` is a non-array object whose `source` is exactly `"resolveFields"`. */
export function isFormResolvedOptions(
  o: Options | undefined,
): o is DynamicOptions & { source: "resolveFields" } {
  return !!o && !Array.isArray(o) && (o as DynamicOptions).source === "resolveFields";
}
