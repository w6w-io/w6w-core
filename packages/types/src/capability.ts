/**
 * Capability summary — what an App manifest lets the app reach, as a comparable value.
 *
 * Pure and runtime-free. Accepts a structural SUBSET of `AppManifest` so a host can pass
 * catalog JSON without constructing a full manifest. Source fields (src/ paths):
 *  - hosts:    `network.allow` (app.ts:86) plus the hosts of `protocol.baseUrl` / `protocol.jwksUrl`
 *              (app.ts:103, trigger-protocol.ts:14-21). Lowercased, sorted, deduped.
 *  - hosts also fold `healthChecks[].network.allow` (health.ts:158).
 *  - auths:    `auth[]` (app.ts:138, AuthDefinition in auth.ts:187): `type` (auth.ts:166) and
 *              `oauth2.scopes` (auth.ts:38) and `serviceAccount.scopes` (auth.ts:136-141). Merged per type, scopes sorted/deduped.
 *  - triggers: `triggers[]` (app.ts:140): `delivery === "w6w-protocol"` → "protocol", else
 *              `type` (trigger.ts:69; "webhook" | "poll"), defaulting to "webhook" when absent
 *              (the loader derives `type`, so raw catalog JSON may lack it).
 *  - sockets:  `capabilities.socket` (app.ts:97). A flag only: socket targets are
 *              per-Connection and cannot be reviewed statically.
 */

/** The manifest fields the summary reads (structural subset of `AppManifest`). */
export interface CapabilityManifestLike {
  network?: { allow?: string[] };
  capabilities?: { socket?: boolean };
  protocol?: { baseUrl?: string; jwksUrl?: string };
  auth?: Array<{
    type: string;
    oauth2?: { scopes?: string[] };
    serviceAccount?: { scopes?: string[] };
  }>;
  healthChecks?: Array<{ network?: { allow?: string[] } }>;
  triggers?: Array<{ type?: string; delivery?: string }>;
}

export interface CapabilitySummary {
  hosts: string[];
  auths: { type: string; scopes: string[] }[];
  triggers: { kind: string }[];
  sockets: boolean;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

const uniqSorted = (xs: string[]): string[] => [...new Set(xs)].sort();

export function capabilitySummary(manifest: CapabilityManifestLike): CapabilitySummary {
  const hosts = (manifest.network?.allow ?? []).map((h) => String(h).trim().toLowerCase());
  for (const hc of manifest.healthChecks ?? []) {
    for (const h of hc.network?.allow ?? []) hosts.push(String(h).trim().toLowerCase());
  }
  for (const u of [manifest.protocol?.baseUrl, manifest.protocol?.jwksUrl]) {
    const h = hostOf(u);
    if (h) hosts.push(h);
  }
  const byType = new Map<string, string[]>();
  for (const a of manifest.auth ?? []) {
    const scopes = byType.get(a.type) ?? [];
    scopes.push(...(a.oauth2?.scopes ?? []), ...(a.serviceAccount?.scopes ?? []));
    byType.set(a.type, scopes);
  }
  const auths = [...byType.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([type, scopes]) => ({ type, scopes: uniqSorted(scopes) }));
  const kinds = (manifest.triggers ?? []).map((t) =>
    t.delivery === "w6w-protocol" ? "protocol" : (t.type ?? "webhook")
  );
  return {
    hosts: uniqSorted(hosts.filter(Boolean)),
    auths,
    triggers: uniqSorted(kinds).map((kind) => ({ kind })),
    sockets: manifest.capabilities?.socket === true,
  };
}

/**
 * Human-readable reasons `next` reaches further than `prev`; empty = no widening.
 * Host comparison is by exact normalized string (a wildcard is a distinct entry).
 */
export function capabilityWidens(
  prev: CapabilityManifestLike | CapabilitySummary,
  next: CapabilityManifestLike | CapabilitySummary,
): string[] {
  const p = isSummary(prev) ? prev : capabilitySummary(prev);
  const n = isSummary(next) ? next : capabilitySummary(next);
  const out: string[] = [];
  for (const h of n.hosts) if (!p.hosts.includes(h)) out.push(`host added: ${h}`);
  for (const a of n.auths) {
    const old = p.auths.find((x) => x.type === a.type);
    if (!old) {
      out.push(`auth type added: ${a.type}`);
      continue;
    }
    for (const s of a.scopes) {
      if (!old.scopes.includes(s)) out.push(`scope added: ${a.type} ${s}`);
    }
  }
  for (const t of n.triggers) {
    if (!p.triggers.some((x) => x.kind === t.kind)) out.push(`trigger kind added: ${t.kind}`);
  }
  if (n.sockets && !p.sockets) out.push("socket capability added");
  return out;
}

function isSummary(x: CapabilityManifestLike | CapabilitySummary): x is CapabilitySummary {
  return Array.isArray((x as CapabilitySummary).hosts) &&
    typeof (x as CapabilitySummary).sockets === "boolean";
}
