/**
 * Host side of `ctx.socket`: the pre-connect target check, the real
 * `Deno.connect`/`Deno.startTls`, and the iterative auth `handshake` loop.
 *
 * The sandbox never sees any of this — it only ever gets a `SocketHandle`
 * proxying write/read/close through `onSocket` (`sandbox/run-hook.ts`,
 * `SocketRequest`/`SocketResult` in `sandbox/protocol.ts`, both T1.2.1). This
 * module is what builds that proxy from a REAL, already-open, already-
 * authenticated `Deno.Conn` — the piece T1.2.1 deliberately left for this
 * node (see its `onSocket` doc comment: "Opening the actual OS connection is
 * this callback's owner's job (T1.2.2)").
 */
import type { ConnectionTarget } from "@w6w/types";
import type { LoadedApp, LoadedAuth } from "./loader.ts";
import { runHook } from "./sandbox/run-hook.ts";
import type { SocketRequest, SocketResult } from "./sandbox/protocol.ts";
import { W6WError } from "./errors.ts";

// ── IPv4/IPv6 literal parsing ───────────────────────────────────────────────

/** Parse a dotted-quad IPv4 literal into its four octets, or `null`. */
function parseIPv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/**
 * Parse an IPv6 literal (with `::` compression and/or an embedded trailing
 * IPv4, e.g. `::ffff:127.0.0.1`) into 16 bytes, or `null`. Hand-rolled
 * because Deno's std lib has no IPv6 parser and the v4-mapped form — the
 * single most common way a private-range check is bypassed (see
 * `hook-runtime.md`'s target-check section) — MUST parse correctly: a parser
 * that only handles the plain 8-group form would silently let
 * `::ffff:127.0.0.1` through as "not an IP literal at all", sending it to DNS
 * resolution instead of the loopback check it needs.
 */
function parseIPv6(host: string): number[] | null {
  const zone = host.indexOf("%");
  const addr = zone === -1 ? host : host.slice(0, zone);

  const firstDouble = addr.indexOf("::");
  const hasDouble = firstDouble !== -1;
  if (hasDouble && addr.indexOf("::", firstDouble + 1) !== -1) return null; // "::" at most once

  const head = hasDouble ? addr.slice(0, firstDouble) : addr;
  const tail = hasDouble ? addr.slice(firstDouble + 2) : "";
  const headParts = head === "" ? [] : head.split(":");
  const tailParts = tail === "" ? [] : tail.split(":");

  // A trailing IPv4 dotted-quad (only ever the LAST group) expands to two
  // hex groups so the rest of the parser can treat everything uniformly.
  const expandTrailingV4 = (parts: string[]): string[] | null => {
    const last = parts[parts.length - 1];
    if (last === undefined || !last.includes(".")) return parts;
    const v4 = parseIPv4(last);
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    return [...parts.slice(0, -1), hi, lo];
  };

  const headGroups = expandTrailingV4(headParts);
  const tailGroups = expandTrailingV4(tailParts);
  if (headGroups === null || tailGroups === null) return null;

  let groups: string[];
  if (!hasDouble) {
    if (headGroups.length !== 8) return null;
    groups = headGroups;
  } else {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 0) return null;
    groups = [...headGroups, ...Array(missing).fill("0"), ...tailGroups];
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

/** True if `host` is an IPv4 or IPv6 literal — the resolution set is just itself. */
function isIpLiteral(host: string): boolean {
  const stripped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return parseIPv4(host) !== null || parseIPv6(stripped) !== null;
}

// ── Private/loopback/link-local ranges (§Pinned mechanism, self-audited) ───

function ipv4InCidr(ip: number[], base: number[], bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const ipInt = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
  const baseInt = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * The exact IPv4 ranges enumerated in the contract's §Pinned mechanism as
 * required self-audit items, one entry each — a missing arm here is a finding
 * regardless of whether any test happens to catch it. `100.64/10` is CGNAT;
 * `169.254/16` includes the cloud-metadata address `169.254.169.254`;
 * `198.18/15` is benchmarking space; the rest are the familiar RFC 1918 +
 * multicast/reserved blocks.
 */
const IPV4_PRIVATE_RANGES: ReadonlyArray<readonly [number[], number]> = [
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

function isPrivateIPv4(ip: number[]): boolean {
  return IPV4_PRIVATE_RANGES.some(([base, bits]) => ipv4InCidr(ip, base, bits));
}

/**
 * True for `::`, `::1`, `fc00::/7` (unique local) and `fe80::/10`
 * (link-local) — the IPv6 arms the contract enumerates — OR a v4-mapped
 * address (`::ffff:0:0/96`) whose UNWRAPPED IPv4 tail is itself private. The
 * unwrap-then-recheck is required, not optional: `::ffff:127.0.0.1` must
 * deny for exactly the same reason `127.0.0.1` does.
 */
function isPrivateIPv6(ip: number[]): boolean {
  const isZero = (bytes: number[]) => bytes.every((b) => b === 0);
  if (isZero(ip)) return true; // "::"
  if (ip[0] === 0 && isZero(ip.slice(1, 15)) && ip[15] === 1) return true; // "::1"
  if ((ip[0] & 0xfe) === 0xfc) return true; // fc00::/7
  if (ip[0] === 0xfe && (ip[1] & 0xc0) === 0x80) return true; // fe80::/10
  if (isZero(ip.slice(0, 10)) && ip[10] === 0xff && ip[11] === 0xff) {
    return isPrivateIPv4(ip.slice(12, 16)); // ::ffff:0:0/96, unwrapped
  }
  return false;
}

function isPrivateAddress(addr: string): boolean {
  const v4 = parseIPv4(addr);
  if (v4) return isPrivateIPv4(v4);
  const v6 = parseIPv6(addr);
  if (v6) return isPrivateIPv6(v6);
  // Neither form parsed. `resolveAddresses` only ever returns values it
  // produced itself (a literal it already validated, or a `Deno.resolveDns`
  // result), so this should be unreachable — fail closed rather than let an
  // address of an unrecognized shape connect unchecked.
  return true;
}

// ── Resolution ───────────────────────────────────────────────────────────

/** `NotFound` means "no records of this kind", not a failure — see module notes. */
async function resolveOrEmpty(host: string, kind: "A" | "AAAA"): Promise<string[]> {
  try {
    return await Deno.resolveDns(host, kind);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
}

async function resolveAddresses(host: string): Promise<string[]> {
  if (isIpLiteral(host)) return [host];
  const [a, aaaa] = await Promise.all([
    resolveOrEmpty(host, "A"),
    resolveOrEmpty(host, "AAAA"),
  ]);
  return [...new Set([...a, ...aaaa])];
}

// ── The target check (§Pinned mechanism) ────────────────────────────────────

const TLS_MODES = ["disable", "verify-full", "custom-ca"] as const;

function validateShape(target: ConnectionTarget): void {
  if (!target.host || typeof target.host !== "string") {
    throw new W6WError("socket_denied", "execute", "Connection target is missing `host`.");
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new W6WError(
      "socket_denied",
      "execute",
      `Connection target port "${target.port}" is not an integer in 1..65535.`,
    );
  }
  if (!(TLS_MODES as readonly string[]).includes(target.tlsMode)) {
    throw new W6WError(
      "socket_denied",
      "execute",
      `Connection target tlsMode "${target.tlsMode}" is not one of ${TLS_MODES.join(", ")}.`,
    );
  }
  const needsCaCert = target.tlsMode === "custom-ca";
  if (needsCaCert && !target.caCert) {
    throw new W6WError(
      "socket_denied",
      "execute",
      `tlsMode "custom-ca" requires \`caCert\`.`,
    );
  }
  if (!needsCaCert && target.caCert) {
    throw new W6WError(
      "socket_denied",
      "execute",
      `\`caCert\` is only meaningful for tlsMode "custom-ca".`,
    );
  }
}

/**
 * The single pre-connect checkpoint (DC-3): shape-validate `target`, resolve
 * it ONCE to its full address set, refuse if any address in that set is
 * private/loopback/link-local (unless `target.allowPrivate`), and hand back
 * one address FROM THAT SAME SET for `openSocket` to connect to — never the
 * name, never a fresh resolution.
 *
 * One checkpoint suffices here where `ctx.fetch` needs two
 * (`runtime.ts:294-321`'s pre-sign check plus `hostFetch`'s own): there, both
 * the action's request AND a `sign` hook's rewrite can move the destination
 * after the first check runs, so a second check on the SIGNED request is
 * load-bearing. Here, the sandbox never supplies a target at all (it isn't
 * part of any worker message) and `HandshakeStep` carries only bytes — there
 * is no untrusted code path between this check and `Deno.connect` that could
 * mutate the value being checked, so a second checkpoint would just be
 * re-running the same check on the same, already-checked value.
 */
export async function checkTarget(target: ConnectionTarget): Promise<string> {
  validateShape(target);
  let addresses: string[];
  try {
    addresses = await resolveAddresses(target.host);
  } catch (e) {
    throw new W6WError(
      "socket_denied",
      "execute",
      `Could not resolve target host "${target.host}": ${(e as Error).message}`,
    );
  }
  if (addresses.length === 0) {
    throw new W6WError(
      "socket_denied",
      "execute",
      `Target host "${target.host}" did not resolve to any address.`,
    );
  }
  if (!target.allowPrivate) {
    // Every address, not just the first — a multi-record name with one
    // public and one private address must deny, not connect to whichever
    // address happened to sort first.
    for (const addr of addresses) {
      if (isPrivateAddress(addr)) {
        throw new W6WError(
          "socket_denied",
          "execute",
          `Target host "${target.host}" resolves to "${addr}", a private/loopback/link-local ` +
            "address. Set `target.allowPrivate` to opt in.",
        );
      }
    }
  }
  return addresses[0];
}

// ── Opening the real connection ─────────────────────────────────────────────

/**
 * Generic host-side detail intentionally never crosses this function's own
 * boundary verbatim: a raw `Deno.connect`/TLS error can carry resolved IPs,
 * internal hostnames or driver-internal detail (this is called on the same
 * connect path the FU-4 finding is about — see `buildOnSocket`, which is
 * where a raw error message really would cross into app-controlled sandbox
 * code). Logged host-side via `onLog` only; the thrown `W6WError` carries a
 * fixed, non-leaky string regardless of what Deno reported.
 */
function logConnectFailure(
  onLog: ((level: string, message: string, data?: unknown) => void) | undefined,
  stage: "connect" | "tls",
  e: unknown,
): void {
  onLog?.("error", `socket ${stage} failed`, { detail: (e as Error)?.message ?? String(e) });
}

/**
 * Resolve + check the target (DC-3), then open the real connection: plain TCP
 * for `disable`, `Deno.startTls` layered on top for `verify-full`/`custom-ca`.
 *
 * `Deno.startTls`, not `Deno.connectTls`, is the only shape that lets the
 * socket connect to the ADDRESS the check just validated while still
 * verifying the certificate against the NAME the user configured — passing
 * `target.host` to `Deno.connectTls({hostname})` would re-resolve internally
 * and reopen the exact TOCTOU window `checkTarget` exists to close (measured
 * against this Deno version; see the contract's context notes).
 *
 * `Deno.startTls()`'s own promise resolves once it has WRAPPED the
 * connection, not once the handshake — and therefore certificate
 * verification — has actually completed (measured against this Deno
 * version): an untrusted cert does not fail here, it fails silently later,
 * on the first real read/write, which for `verify-full` would otherwise mean
 * the handshake loop's own write surfaces it as `connection_broken` instead
 * of this function's `socket_unavailable`. Calling `.handshake()` explicitly
 * forces verification to happen NOW, inside this function's own try/catch,
 * so a rejected certificate is `socket_unavailable` like every other
 * connect-time failure — not something the handshake loop has to guess at.
 */
export async function openSocket(
  target: ConnectionTarget,
  opts: { onLog?: (level: string, message: string, data?: unknown) => void } = {},
): Promise<Deno.Conn> {
  const address = await checkTarget(target);

  // Typed as the concrete `TcpConn` Deno.connect() actually returns — Deno's
  // own `startTls` signature requires it (a plain `Deno.Conn` isn't enough),
  // and this way the TLS branch below type-checks with no cast.
  let conn: Deno.TcpConn;
  try {
    conn = await Deno.connect({ hostname: address, port: target.port });
  } catch (e) {
    logConnectFailure(opts.onLog, "connect", e);
    throw new W6WError(
      "socket_unavailable",
      "execute",
      "Could not establish the socket connection.",
    );
  }

  if (target.tlsMode === "disable") return conn;

  try {
    const tlsOpts: Deno.StartTlsOptions = target.tlsMode === "custom-ca"
      ? { hostname: target.host, caCerts: [target.caCert!] }
      : { hostname: target.host };
    const tlsConn = await Deno.startTls(conn, tlsOpts);
    await tlsConn.handshake();
    return tlsConn;
  } catch (e) {
    try {
      conn.close();
    } catch {
      // Already gone; startTls consumes the plain connection either way.
    }
    logConnectFailure(opts.onLog, "tls", e);
    throw new W6WError("socket_unavailable", "execute", "Could not establish the TLS connection.");
  }
}

// ── The handshake loop (DC-1) ────────────────────────────────────────────

/**
 * Bound on handshake round trips. Real protocols this targets (SCRAM,
 * MySQL native-password, a Postgres cleartext/MD5 exchange) complete in 1-3
 * round trips; 16 is generous headroom while still turning a hook that never
 * signals `done` into a fast, explicit `connection_broken` instead of a hang.
 */
const MAX_HANDSHAKE_STEPS = 16;

/** A single handshake reply is a short auth frame, not a bulk transfer. */
const HANDSHAKE_READ_BUFFER_BYTES = 8192;

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const n = await conn.write(data.subarray(offset));
    if (n === 0) throw new Error("socket write stalled: 0 bytes written");
    offset += n;
  }
}

/**
 * Drive the Auth `handshake` hook to completion, writing each `send` to the
 * real connection and feeding the reply back as the next call's `received` —
 * the `resolveConnection`'s `needs_refresh` branch's single-call pattern
 * (`runtime.ts:436-448`), generalized to iterate. Deliberately passes neither
 * `onFetch` nor `onSocket` to `runHook` (DC-1): the handshake hook only ever
 * produces bytes for the HOST to send, it never touches the network or the
 * stream itself.
 *
 * Any failure — the hook throwing, the peer closing mid-handshake, or the
 * step cap — surfaces as `connection_broken`, the same shape a failed
 * `refresh` gets (`runtime.ts:449-451`); a handshake failure is not a new
 * error code (`hook-runtime.md`'s Codes table, T1.1.1).
 */
export async function runHandshake(
  app: LoadedApp,
  auth: LoadedAuth,
  target: ConnectionTarget,
  credential: unknown,
  conn: Deno.Conn,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  let received: Uint8Array | undefined;
  let state: unknown;

  for (let step = 0; step < MAX_HANDSHAKE_STEPS; step++) {
    let result: { done: boolean; send?: Uint8Array; state?: unknown };
    try {
      result = await runHook({
        entryPath: app.entryPath,
        selector: { kind: "auth", key: auth.auth.key, hook: "handshake" },
        input: { credential, target, received, state },
        readScope: app.dir,
        timeoutMs: opts.timeoutMs,
        // no onFetch, no onSocket — DC-1: the handshake hook is network-less.
      });
    } catch (e) {
      throw new W6WError("connection_broken", "auth", `Handshake failed: ${(e as Error).message}`);
    }

    if (result.send) {
      try {
        await writeAll(conn, result.send);
      } catch (e) {
        throw new W6WError(
          "connection_broken",
          "auth",
          `Handshake failed: could not write the auth frame (${(e as Error).message}).`,
        );
      }
    }

    if (result.done) return;

    const buf = new Uint8Array(HANDSHAKE_READ_BUFFER_BYTES);
    let n: number | null;
    try {
      n = await conn.read(buf);
    } catch (e) {
      throw new W6WError(
        "connection_broken",
        "auth",
        `Handshake failed: could not read the reply (${(e as Error).message}).`,
      );
    }
    if (n === null) {
      throw new W6WError(
        "connection_broken",
        "auth",
        "Handshake failed: connection closed before it completed.",
      );
    }
    received = buf.subarray(0, n);
    state = result.state;
  }

  throw new W6WError(
    "connection_broken",
    "auth",
    `Handshake failed: did not complete within ${MAX_HANDSHAKE_STEPS} steps.`,
  );
}

// ── The onSocket proxy (post-handshake, action-facing) ──────────────────────

/**
 * Default `read()` size when the worker's `SocketHandle.read()` call omits
 * `max` — "host-chosen", per its doc comment in `@w6w/types`.
 */
const DEFAULT_SOCKET_READ_BYTES = 64 * 1024;

/**
 * Hard ceiling on a single `ctx.socket.read()`/`write()` call, enforced
 * host-side regardless of what the worker asks for (harvested from T1.2.1's
 * eval, `FOLLOWUPS.md` FU-4: `run-hook.ts` forwards the worker-supplied
 * `max`/`bytes` to `onSocket` unbounded). A `read()` request over this is
 * CLAMPED — the real buffer allocated is never bigger than this, no matter
 * what `max` asked for, so a hostile/buggy action can't drive unbounded
 * host-side allocation. A `write()` payload over this is REJECTED outright,
 * before the real write is even attempted, because (unlike a read buffer,
 * which this code sizes itself) the oversized bytes already exist on the
 * worker side by the time this callback sees them — the only thing left to
 * bound is whether the host acts on them.
 *
 * Exported so a test can assert against the REAL ceiling rather than a
 * duplicated magic number.
 */
export const MAX_SOCKET_IO_BYTES = 1024 * 1024;

/**
 * Error text crossing back into the sandboxed worker via `onSocket`'s return
 * value is app-controlled hook code's input, not a host-side log line — a raw
 * `Deno.Conn` read/write error can carry driver-internal detail, so every
 * failure here collapses to one of two fixed, non-leaky strings. The real
 * detail is logged host-side only, via `onLog`, mirroring `openSocket`'s
 * `logConnectFailure`.
 */
function logIoFailure(
  onLog: ((level: string, message: string, data?: unknown) => void) | undefined,
  op: "write" | "read",
  e: unknown,
): void {
  onLog?.("error", `socket ${op} failed`, { detail: (e as Error)?.message ?? String(e) });
}

/**
 * Build the callback `runHook`'s `onSocket` option routes an action's
 * `ctx.socket` calls through, servicing them against a REAL, already-open
 * connection. The stream itself (`openSocket`'s return value) is exactly
 * what this is built from — there is no other route to it, matching
 * `SocketHandle` having no `open()`.
 */
export function buildOnSocket(
  conn: Deno.Conn,
  opts: { onLog?: (level: string, message: string, data?: unknown) => void } = {},
): (request: SocketRequest) => Promise<SocketResult> {
  return async (request: SocketRequest): Promise<SocketResult> => {
    switch (request.op) {
      case "write": {
        if (request.bytes.byteLength > MAX_SOCKET_IO_BYTES) {
          throw new W6WError(
            "socket_failed",
            "execute",
            `socket write of ${request.bytes.byteLength} bytes exceeds the host's ` +
              `${MAX_SOCKET_IO_BYTES}-byte limit.`,
          );
        }
        try {
          await writeAll(conn, request.bytes);
        } catch (e) {
          logIoFailure(opts.onLog, "write", e);
          throw new W6WError("socket_failed", "execute", "socket write failed.");
        }
        return { op: "write" };
      }
      case "read": {
        // Clamp BEFORE allocating — `Uint8Array(size)` is the only allocation
        // this branch ever performs, and `size` is never the raw worker value.
        const size = Math.min(request.max ?? DEFAULT_SOCKET_READ_BYTES, MAX_SOCKET_IO_BYTES);
        const buf = new Uint8Array(size);
        let n: number | null;
        try {
          n = await conn.read(buf);
        } catch (e) {
          logIoFailure(opts.onLog, "read", e);
          throw new W6WError("socket_failed", "execute", "socket read failed.");
        }
        return { op: "read", bytes: n === null ? null : buf.subarray(0, n) };
      }
      case "close": {
        try {
          conn.close();
        } catch {
          // `SocketHandle.close()` is documented idempotent; a double-close
          // (e.g. the action closes it and `invoke()`'s `finally` closes it
          // again) is not an error.
        }
        return { op: "close" };
      }
    }
  };
}

// ── The whole session, as `invoke()` needs it ───────────────────────────────

export interface SocketSession {
  /** Pass as `runHook`'s `onSocket` option. */
  onSocket: (request: SocketRequest) => Promise<SocketResult>;
  /** Idempotent. Always call from a `finally` — see `invoke()`. */
  close(): void;
}

/**
 * Open, check and handshake a Connection's socket target, end to end:
 * `openSocket` (target check + real connect/TLS), then `runHandshake` when
 * the auth method declares one, then the `onSocket` proxy `execute()` will
 * use. `invoke()`'s only job is calling this when `target` is present and
 * closing the result in a `finally`.
 *
 * An auth method with no `handshake` hook skips straight to the proxy with no
 * round trips — a socket-backed protocol that genuinely needs no auth frame
 * (e.g. a fully anonymous listener) is not an error, mirroring how
 * `resolveConnection` only routes through `refresh` when `needs_refresh`
 * actually applies.
 */
export async function openConnectionSocket(
  app: LoadedApp,
  auth: LoadedAuth | undefined,
  target: ConnectionTarget,
  credential: unknown,
  opts: {
    timeoutMs?: number;
    onLog?: (level: string, message: string, data?: unknown) => void;
  } = {},
): Promise<SocketSession> {
  const conn = await openSocket(target, opts);
  try {
    if (auth?.hooks.has("handshake")) {
      await runHandshake(app, auth, target, credential, conn, opts);
    }
  } catch (e) {
    try {
      conn.close();
    } catch {
      // Already gone.
    }
    throw e;
  }
  return {
    onSocket: buildOnSocket(conn, opts),
    close: () => {
      try {
        conn.close();
      } catch {
        // Idempotent — may already be closed by the action itself or by a
        // handshake failure that closed it before returning.
      }
    },
  };
}
