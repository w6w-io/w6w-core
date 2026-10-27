/**
 * The one legacy-payload normaliser (D-D3), used by the legacy adapter and the migration.
 * Maps a pre-credential Google service-account connection payload (11 app shapes, see
 * gap-analysis-D §2) to a canonical source + binding + approved binding.
 *
 * Declared-order dedupe here is for the JWT `scope` claim only; cache keys use
 * `normalizeScopes` from `@w6w/runtime` (R-3).
 */

import type { ApprovedBinding, ConnectionBinding, ServiceAccountConfig } from "@w6w/types";
import { fail, type GoogleServiceAccountSource, validateSource } from "./google-service-account.ts";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function firstStr(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(o[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

function payloadScopes(v: unknown): Set<string> | null {
  let list: unknown[] = [];
  if (typeof v === "string") list = v.split(/\s+/);
  else if (Array.isArray(v)) list = v;
  const set = new Set(list.filter((s): s is string => typeof s === "string" && s !== ""));
  return set.size > 0 ? set : null;
}

export function normaliseLegacyGoogleServiceAccount(
  payload: unknown,
  declared: ServiceAccountConfig,
): { source: GoogleServiceAccountSource; binding: ConnectionBinding; approved: ApprovedBinding } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return fail("credential_invalid", "source_not_object", {
      retryable: false,
      status: null,
      field: "source",
    });
  }
  const p = payload as Record<string, unknown>;
  const candidate: Record<string, unknown> = { type: p.type ?? "service_account" };
  const email = firstStr(p, ["client_email", "email", "clientEmail"]);
  if (email !== undefined) candidate.client_email = email;
  const key = p.private_key ?? p.privateKey;
  if (key !== undefined) candidate.private_key = key;
  for (const k of ["private_key_id", "client_id"]) if (p[k] !== undefined) candidate[k] = p[k];
  const projectId = str(p.projectId);
  const project = p.project_id ?? projectId;
  if (project !== undefined) candidate.project_id = project;
  const source = validateSource(candidate);

  let delegated: string | null = null;
  if (declared.impersonation !== "none") {
    const d = firstStr(p, ["delegatedEmail", "subject", "impersonate", "delegatedUser"]);
    if (d !== undefined && d.trim().toLowerCase() !== source.client_email.trim().toLowerCase()) {
      delegated = d;
    }
    if (delegated === null && declared.impersonation === "required") {
      fail("credential_invalid", "delegatedUser", {
        retryable: false,
        status: null,
        field: "delegatedUser",
      });
    }
  }

  const fromPayload = payloadScopes(p.scopes);
  const approvedScopes = fromPayload === null
    ? [...declared.scopes]
    : [...new Set(declared.scopes.filter((s) => fromPayload.has(s)))];

  const binding: ConnectionBinding = { scopes: approvedScopes };
  if (delegated !== null) binding.delegatedUser = delegated;
  const settings: Record<string, string | number | boolean> = {};
  if (projectId !== undefined) settings.projectId = projectId;
  const location = str(p.location);
  if (location !== undefined) settings.location = location;
  if (Object.keys(settings).length > 0) binding.settings = settings;

  return {
    source,
    binding,
    approved: { scopes: [...approvedScopes], delegatedUser: binding.delegatedUser ?? null },
  };
}
