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
  parseRenderTemplate,
  parseTemplate,
  serializeTemplate,
  type TemplateMode,
} from "./src/template.ts";
