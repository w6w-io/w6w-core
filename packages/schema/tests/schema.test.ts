/**
 * Sanity checks. We don't run a full JSON Schema validator here — that lives in
 * @w6w/validator's conformance suite, where Ajv is wired in. Here we just
 * confirm every schema file is valid JSON with the expected `$id` and that the
 * top-level `schemas` export enumerates them.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { schemas } from "../mod.ts";

const EXPECTED_NAMES = [
  "app",
  "action",
  "auth",
  "param",
  "imageObject",
  "connection",
  "invocation",
] as const;

Deno.test("schemas object exports every primitive", () => {
  for (const name of EXPECTED_NAMES) {
    assert(name in schemas, `missing schema export "${name}"`);
  }
});

Deno.test("every schema declares a w6w.io $id and Draft 2020-12", () => {
  for (const [name, schema] of Object.entries(schemas)) {
    const s = schema as { $id?: string; $schema?: string };
    assert(s.$id?.startsWith("https://w6w.io/schemas/v1/"), `${name}: bad $id ${s.$id}`);
    assertEquals(s.$schema, "https://json-schema.org/draft/2020-12/schema", `${name}: bad $schema`);
  }
});

// ── auth / connection schema ↔ TS convergence ────────────────────────────────
import {
  type Auth,
  AUTH_TYPES,
  type Connection,
  CREDENTIAL_CONTRACT_ID_RE,
  type OAuth2ClientSetup,
  type OAuth2Config,
  type ServiceAccountConfig,
} from "@w6w/types";

// Compile-time key lists: adding or removing a TS key without touching these fails `check`.
const AUTH_KEYS: Record<keyof Auth, true> = {
  key: true,
  type: true,
  displayName: true,
  description: true,
  connectionLabel: true,
  fields: true,
  oauth2: true,
  apiKey: true,
  tenantAuth: true,
  jit: true,
  serviceAccount: true,
};
const OAUTH2_KEYS: Record<keyof OAuth2Config, true> = {
  authorizationUrl: true,
  tokenUrl: true,
  tokenAuthMethod: true,
  tokenBodyFormat: true,
  refreshUrl: true,
  revokeUrl: true,
  scopes: true,
  scopeSeparator: true,
  pkce: true,
  extraAuthParams: true,
  setup: true,
};
const SETUP_KEYS: Record<keyof OAuth2ClientSetup, true> = {
  consoleUrl: true,
  instructions: true,
  clientIdHint: true,
  clientSecretHint: true,
  redirectUriHint: true,
  extraHint: true,
  extraTemplate: true,
};
const SA_KEYS: Record<keyof ServiceAccountConfig, true> = {
  accepts: true,
  scopes: true,
  impersonation: true,
  bindingFields: true,
};
const CONNECTION_NEW: (keyof Connection)[] = [
  "credentialId",
  "binding",
  "approved",
  "bindingRevision",
];

// deno-lint-ignore no-explicit-any
type J = any;
const keys = (o: object) => Object.keys(o).sort();
const auth = schemas.auth as J;
const connection = schemas.connection as J;

Deno.test("auth.schema.json: root shape and key set equal keyof Auth", () => {
  assertEquals(auth.required, ["key", "type", "displayName"]);
  assertEquals(auth.additionalProperties, false);
  assertEquals(keys(auth.properties), keys(AUTH_KEYS));
  assertEquals(auth.properties.type.enum, [...AUTH_TYPES]);
});

Deno.test("auth.schema.json: nested blocks equal their TS keys and are closed", () => {
  assertEquals(keys(auth.properties.oauth2.properties), keys(OAUTH2_KEYS));
  assertEquals(auth.properties.oauth2.properties.tokenAuthMethod.enum, [
    "client_secret_post",
    "client_secret_basic",
  ]);
  assertEquals(auth.properties.oauth2.properties.tokenBodyFormat.enum, ["form", "json"]);
  const setup = auth.properties.oauth2.properties.setup;
  assertEquals(setup.additionalProperties, false);
  assertEquals(keys(setup.properties), keys(SETUP_KEYS));
  assertEquals(keys(auth.properties.tenantAuth.properties), ["link", "resourcePrefix"]);
  assertEquals(auth.properties.tenantAuth.additionalProperties, false);
  assertEquals(keys(auth.properties.jit.properties), ["resourcePrefix"]);
  assertEquals(auth.properties.jit.additionalProperties, false);
});

Deno.test("auth.schema.json: serviceAccount block", () => {
  const sa = auth.properties.serviceAccount;
  assertEquals(sa.additionalProperties, false);
  assertEquals(sa.required, ["accepts", "scopes", "impersonation"]);
  assertEquals(keys(sa.properties), keys(SA_KEYS));
  assertEquals(sa.properties.accepts.minItems, 1);
  assertEquals(sa.properties.accepts.items.pattern, CREDENTIAL_CONTRACT_ID_RE.source);
  assertEquals(sa.properties.scopes.minItems, 1);
  assertEquals(sa.properties.impersonation.enum, ["none", "optional", "required"]);
  assertEquals(sa.properties.bindingFields.items, { $ref: "param.schema.json" });
  const rule = auth.allOf.find((r: J) => r.if?.properties?.type?.const === "serviceAccount");
  assertEquals(rule?.then, { required: ["serviceAccount"] });
});

Deno.test("connection.schema.json gains the 4 optional properties, required unchanged", () => {
  for (const k of CONNECTION_NEW) assert(k in connection.properties, k);
  assertEquals(connection.required, [
    "manifestVersion",
    "id",
    "app",
    "auth",
    "owner",
    "state",
    "createdAt",
  ]);
});
