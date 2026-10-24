/**
 * Host-side handling of the Action `resolveFields` hook's output.
 *
 * The hook runs in the app's sandbox, so whatever it returns is untrusted data
 * crossing into the host. Sanitising therefore lives here (host realm) and never
 * in `sandbox/worker.ts`, which shares a realm with the app code.
 */
import type { Option, ResolveFieldsOutput } from "@w6w/types";
import { W6WError } from "./errors.ts";

/** Hard cap on one `resolveFields` call (also the ceiling on host egress). */
export const RESOLVE_FIELDS_TIMEOUT_MS = 10_000;
/** Most raw option entries examined per field (so at most this many kept). */
export const RESOLVE_FIELDS_MAX_OPTIONS = 1000;

const MAX_LABEL = 200;
const MAX_DESCRIPTION = 500;
const MAX_ERROR = 500;
const BAD_OPTIONS = "invalid options returned by the app";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function sanitizeOption(raw: unknown): Option | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { value, label, description, disabled } = raw;
  const valueOk = typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value));
  if (!valueOk || typeof label !== "string") return undefined;
  const out: Option = { value: value as string | number, label: label.slice(0, MAX_LABEL) };
  if (typeof description === "string") out.description = description.slice(0, MAX_DESCRIPTION);
  if (typeof disabled === "boolean") out.disabled = disabled;
  return out;
}

/**
 * Validate a `resolveFields` hook's return as untrusted. Keeps only the
 * `requested` keys that are own properties of `raw.fields`; everything else is
 * dropped. Pure.
 */
export function sanitizeResolveFieldsOutput(
  raw: unknown,
  requested: readonly string[],
): ResolveFieldsOutput {
  if (!isPlainObject(raw) || !isPlainObject(raw.fields)) {
    throw new W6WError(
      "invalid_fields_output",
      "resolution",
      "resolveFields must return { fields: { [key]: { options?, error? } } }.",
    );
  }
  const fields = raw.fields;
  const entries: [string, { options?: Option[]; error?: string }][] = [];
  for (const key of requested) {
    if (typeof key !== "string" || !Object.hasOwn(fields, key)) continue;
    const entry = fields[key];
    if (!isPlainObject(entry) || (entry.options !== undefined && !Array.isArray(entry.options))) {
      entries.push([key, { error: BAD_OPTIONS }]);
      continue;
    }
    const out: { options?: Option[]; error?: string } = {};
    if (Array.isArray(entry.options)) {
      const options: Option[] = [];
      // The cap is on RAW entries: look at the first RESOLVE_FIELDS_MAX_OPTIONS
      // slots only, so a huge (or sparse, `new Array(2 ** 32 - 1)`) array costs
      // a bounded loop. Holes and invalid entries are skipped as invalid.
      const rawCount = Math.min(entry.options.length, RESOLVE_FIELDS_MAX_OPTIONS);
      for (let i = 0; i < rawCount; i++) {
        const o = sanitizeOption(entry.options[i]);
        if (o) options.push(o);
      }
      out.options = options;
    }
    if (typeof entry.error === "string") out.error = entry.error.slice(0, MAX_ERROR);
    entries.push([key, out]);
  }
  return { fields: Object.fromEntries(entries) };
}
