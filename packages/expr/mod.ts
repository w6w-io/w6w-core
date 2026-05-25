/**
 * @w6w/expr — the platform's expression engine (JSONLogic).
 *
 * ```ts
 * import { evaluate, showIf } from "@w6w/expr";
 * evaluate({ "==": [{ var: "plan" }, "pro"] }, { plan: "pro" }); // true
 * showIf({ "!": { var: "hidden" } }, { hidden: false });        // true
 * ```
 */
export { evaluate, ExprError, isTruthy, showIf } from "./src/jsonlogic.ts";
