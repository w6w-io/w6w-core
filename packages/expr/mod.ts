/**
 * @w6w/expr — the platform's expression engine (JSONLogic) and the one
 * `{{ }}` template grammar the engine and the editor both read.
 *
 * ```ts
 * import { evaluate, parseRenderTemplate, showIf } from "@w6w/expr";
 * evaluate({ "==": [{ var: "plan" }, "pro"] }, { plan: "pro" }); // true
 * showIf({ "!": { var: "hidden" } }, { hidden: false });        // true
 * parseRenderTemplate("Hi {{ vars.name }}");                    // [text, var]
 * ```
 */
export { evaluate, ExprError, isTruthy, showIf } from "./src/jsonlogic.ts";
export {
  expressionReferences,
  formatReadableExpression,
  parseReadableExpression,
  ReadableExpressionError,
} from "./src/readable.ts";
export {
  type CoalesceChain,
  coalesceOperandRefs,
  hasRefusedChainToken,
  parseCoalesceChain,
  parseRenderTemplate,
  parseTemplate,
  serializeTemplate,
  type TemplateEscape,
  type TemplateMode,
} from "./src/template.ts";
export { effectiveParam, matchesParamCondition, PARAM_OVERLAY_KEYS } from "./src/param-when.ts";
export type { ParamCondition, ParamOverlay, ParamWhen } from "./src/param-when.ts";
export {
  applyStateOp,
  computeStateWrites,
  effectiveStateConfig,
  foldState,
  foldStateLog,
  parseStatePath,
  STATE_FORBIDDEN_KEYS,
  STATE_LIMITS,
  STATE_RESERVED_TOP_KEYS,
  STATE_SECRET_MASK,
  statePathsOverlap,
  staticWritePaths,
  validateInitialState,
  validateStateConfig,
} from "./src/state-tree.ts";
export type {
  StateChange,
  StateConfigIssue,
  StateLogRow,
  StateTree,
  StateWarning,
  StateWarningCode,
  StateWriteConfig,
  StateWriteOp,
} from "./src/state-tree.ts";
