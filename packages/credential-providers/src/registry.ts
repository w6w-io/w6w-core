import { CREDENTIAL_CONTRACT_ID_RE } from "@w6w/types";
import type { CredentialProvider, CredentialProviderRegistry } from "@w6w/types";
import { googleServiceAccountV1 } from "./google-service-account.ts";

/** Compiled-in registry: exact-match lookup through a `Map`, never loaded from data (D-A1). */
export function createCredentialProviderRegistry(
  list: readonly CredentialProvider[],
): CredentialProviderRegistry {
  const byContract = new Map<string, CredentialProvider>();
  for (const p of list) {
    if (typeof p.contract !== "string" || !CREDENTIAL_CONTRACT_ID_RE.test(p.contract)) {
      throw new Error("invalid credential contract id");
    }
    if (byContract.has(p.contract)) throw new Error("duplicate credential contract");
    byContract.set(p.contract, p);
  }
  return Object.freeze({
    get: (contract: string) => typeof contract === "string" ? byContract.get(contract) : undefined,
    contracts: () => [...byContract.keys()],
  });
}

/** A fresh list on every call. */
export function defaultCredentialProviders(): CredentialProvider[] {
  return [googleServiceAccountV1];
}
