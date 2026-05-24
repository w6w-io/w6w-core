/**
 * Connection — the stored, per-user result of a completed Auth flow.
 * See rfcs/connection.md.
 */

export type ConnectionState =
  | "pending"
  | "connected"
  | "needs_refresh"
  | "broken"
  | "revoked";

/** Free-form metadata populated by Auth's `afterConnect`. */
export type ConnectionDisplay = Record<string, unknown>;

export interface Connection {
  manifestVersion: string;
  /** Stable, host-issued identifier. */
  id: string;
  /** The App this Connection authorizes against. */
  app: string;
  /** Path to the Auth manifest that produced this Connection. */
  auth: string;
  /** Host-issued identifier of the owning principal. */
  owner: string;
  state: ConnectionState;
  /** Whatever `exchange` returned. Opaque, host-encrypted. Never in the redacted projection. */
  credential?: unknown;
  display?: ConnectionDisplay;
  label?: string;
  createdAt: string;
  lastTestedAt?: string;
  /** Redacted from the projection (leaks rotation cadence). */
  lastRefreshedAt?: string;
  expiresAt?: string;
}

/**
 * The Connection as exposed to userland code (Action `execute`, editor previews).
 * `credential`, `lastRefreshedAt`, and `manifestVersion` are stripped.
 */
export type RedactedConnection = Omit<
  Connection,
  "credential" | "lastRefreshedAt" | "manifestVersion"
>;

/** Project a stored Connection down to the redacted form safe for userland. */
export function redact(c: Connection): RedactedConnection {
  const { credential: _cred, lastRefreshedAt: _lr, manifestVersion: _mv, ...rest } = c;
  return rest;
}
