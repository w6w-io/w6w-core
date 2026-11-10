/**
 * `bearer.v1`, `api-key.v1`, `basic.v1` — static providers: the stored source IS the secret
 * material, handed over as-is. There is no token derivation (`kind: "static"` has no
 * `deriveAuthorization`), so a hook can never refresh or overwrite a shared credential.
 *
 * Errors use fixed text keyed by field name; no input value ever reaches a message, and
 * `displayOf` is an allowlist that never includes a secret.
 */

import { W6WError } from "@w6w/runtime";
import type { CredentialTypeField, StaticCredentialProvider } from "@w6w/types";

const MESSAGES = {
  source_not_object: "Credential source must be an object.",
  keys: "Credential source has missing or unexpected fields.",
  not_string: "Credential field must be a string.",
  empty: "Credential field must not be empty.",
  control: "Credential field must not contain line breaks or NUL.",
  colon: "Username must not contain a colon.",
} as const;

type MessageKey = keyof typeof MESSAGES;

function invalid(message: MessageKey, field: string): never {
  throw new W6WError("credential_invalid", "auth", MESSAGES[message], {
    retryable: false,
    status: null,
    field,
  });
}

function makeValidate(
  keys: readonly string[],
  opts: { noColonIn?: string } = {},
): (payload: unknown) => Record<string, string> {
  return (payload) => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      invalid("source_not_object", "source");
    }
    const obj = payload as Record<string, unknown>;
    const own = Object.keys(obj);
    if (own.length !== keys.length || !keys.every((k) => Object.hasOwn(obj, k))) {
      invalid("keys", "source");
    }
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = obj[k];
      if (typeof v !== "string") invalid("not_string", k);
      if (/[\r\n\0]/.test(v)) invalid("control", k);
      const t = v.trim();
      if (t === "") invalid("empty", k);
      if (k === opts.noColonIn && t.includes(":")) invalid("colon", k);
      out[k] = t;
    }
    return out;
  };
}

function makeDisplay(keys: readonly string[]): (source: unknown) => Record<string, string> {
  return (source) => {
    const out: Record<string, string> = {};
    if (typeof source !== "object" || source === null || Array.isArray(source)) return out;
    const s = source as Record<string, unknown>;
    for (const k of keys) if (typeof s[k] === "string") out[k] = s[k];
    return out;
  };
}

const CAPABILITIES = Object.freeze({
  handoffable: true,
  crossConnectionTokenReuse: false,
  delegation: false,
});

function define(
  contract: string,
  label: string,
  fields: CredentialTypeField[],
  displayKeys: readonly string[],
  opts?: { noColonIn?: string },
): StaticCredentialProvider {
  return Object.freeze({
    kind: "static" as const,
    contract,
    version: "1.0.0",
    capabilities: CAPABILITIES,
    descriptor: Object.freeze({
      label,
      fields: fields.map((f) => Object.freeze(f)) as CredentialTypeField[],
    }),
    validateSource: makeValidate(fields.map((f) => f.key), opts),
    displayOf: makeDisplay(displayKeys),
  });
}

export const bearerV1: StaticCredentialProvider = define(
  "bearer.v1",
  "Bearer token",
  [{ key: "token", label: "Token", secret: true }],
  [],
);

export const apiKeyV1: StaticCredentialProvider = define(
  "api-key.v1",
  "API key",
  [{ key: "key", label: "API key", secret: true }],
  [],
);

export const basicV1: StaticCredentialProvider = define(
  "basic.v1",
  "Username and password",
  [
    { key: "username", label: "Username", secret: false },
    { key: "password", label: "Password", secret: true },
  ],
  ["username"],
  { noColonIn: "username" },
);
