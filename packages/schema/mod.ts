/**
 * @w6w/schema — JSON Schema definitions for every primitive in the Core spec.
 *
 * One schema per RFC, in `./schemas/`. Each is a standalone JSON Schema (Draft
 * 2020-12) that any compliant JSON Schema validator can consume.
 *
 * Use:
 * ```ts
 * import { appSchema, actionSchema } from "@w6w/schema";
 * ```
 *
 * These schemas are the **structural** layer of validation — they cover types,
 * required fields, enums, patterns. The richer spec rules (cross-field
 * invariants, the controlled `categories` vocabulary, OAuth-endpoint URL
 * sanity) live in `@w6w/validator` because they don't fit cleanly into JSON
 * Schema. A complete validation runs both layers.
 */
import appSchema from "./schemas/app.schema.json" with { type: "json" };
import actionSchema from "./schemas/action.schema.json" with { type: "json" };
import authSchema from "./schemas/auth.schema.json" with { type: "json" };
import paramSchema from "./schemas/param.schema.json" with { type: "json" };
import imageObjectSchema from "./schemas/image-object.schema.json" with { type: "json" };
import connectionSchema from "./schemas/connection.schema.json" with { type: "json" };
import invocationSchema from "./schemas/invocation.schema.json" with { type: "json" };

export {
  actionSchema,
  appSchema,
  authSchema,
  connectionSchema,
  imageObjectSchema,
  invocationSchema,
  paramSchema,
};

export const schemas = {
  app: appSchema,
  action: actionSchema,
  auth: authSchema,
  param: paramSchema,
  imageObject: imageObjectSchema,
  connection: connectionSchema,
  invocation: invocationSchema,
} as const;

export type SchemaName = keyof typeof schemas;
