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

/**
 * The non-secret, host-readable connect target of a socket-backed Connection.
 * Separate from `credential` on purpose: the host must read host/port/tlsMode to
 * perform the pre-connect check, and `credential` is opaque to the platform.
 */
export interface ConnectionTarget {
  host: string;
  port: number;
  /** Protocol-level namespace selector, when the protocol has one (Postgres: the database). */
  database?: string;
  tlsMode: "disable" | "verify-full" | "custom-ca";
  /** PEM trust anchor. Required by, and only meaningful for, `tlsMode: "custom-ca"`. */
  caCert?: string;
  /**
   * Opt in to a target that RESOLVES to a loopback/link-local/private address.
   * Absent or false: the host refuses such a target with `socket_denied`.
   */
  allowPrivate?: boolean;
}

export interface Connection {
  manifestVersion: string;
  /** Stable, host-issued identifier. */
  id: string;
  /** The App this Connection authorizes against. */
  app: string;
  /** Key of the Auth method that produced this Connection. */
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
  /**
   * Set at connect time alongside `credential`, from the user's Connection form.
   * Non-secret: it SURVIVES redaction and is visible to userland.
   */
  target?: ConnectionTarget;
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
