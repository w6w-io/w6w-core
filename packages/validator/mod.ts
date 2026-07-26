/**
 * @w6w/validator — validate manifests against the Core spec rules.
 *
 * ```ts
 * import { validateApp } from "@w6w/validator";
 * const { ok, errors } = validateApp(manifest);
 * ```
 */
export {
  CATEGORIES,
  unknownCategories,
  validateAction,
  validateApp,
  validateAuth,
  validateHealthCheck,
} from "./src/validate.ts";
export type { ValidationError, ValidationResult } from "./src/validate.ts";
