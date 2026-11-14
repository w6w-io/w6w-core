/**
 * Private-network egress guard for app HTTP traffic (`ctx.fetch`).
 *
 * `assertPublicDestination` resolves the URL's host (IP literals are checked
 * as-is), refuses any loopback / RFC1918 / link-local / ULA / CGNAT / multicast
 * / 0.0.0.0/8 address with `egress_private_denied` (distinct from
 * `egress_denied`, the allow-list refusal), and returns the addresses it
 * checked so the caller can PIN the connection to one of them.
 *
 * The classifier is `isPrivateAddress` from `socket.ts` — one copy.
 * Opt-out: `W6W_APP_ALLOW_PRIVATE=1` (default off, applies to every owner),
 * mirroring `W6W_MODEL_ALLOW_PRIVATE` in the server's model-egress guard.
 *
 * Pin mechanism (researched on Deno 2.8.2):
 *  - `fetch` ignores a `Host` header override unless the client is built with
 *    `Deno.createHttpClient({ allowHost: true })`. With it, `http://<ip>:port/`
 *    plus `Host: name` connects to exactly that IP and preserves the Host.
 *  - There is NO dns-override / lookup / serverName option on createHttpClient
 *    (`{dns}`, `{lookup}`, `{serverName}` are silently ignored or fail), and a
 *    `proxy` client does not pin. So for `https:` the SNI/cert name cannot be
 *    kept while connecting to a literal IP through `fetch`: `pinnedFetch`
 *    reports `pinned: false` there and leaves the https request on the name.
 *    Closing that needs a hand-rolled HTTP/1.1 over `Deno.startTls(conn,
 *    { hostname })` — not done here.
 */
import { W6WError } from "./errors.ts";
import { isIpLiteral, isPrivateAddress } from "./socket.ts";

export interface PublicDestinationOptions {
  /** Skip the check. Default: `W6W_APP_ALLOW_PRIVATE=1`. */
  allowPrivate?: boolean;
  /** Resolve a hostname to addresses. Default: `Deno.resolveDns` A+AAAA. */
  resolve?: (host: string) => Promise<string[]>;
}

export interface PublicDestination {
  host: string;
  /** Every address the host resolved to (all were checked). */
  addresses: string[];
  /** The address to connect to. */
  pinned: string;
}

export function appAllowPrivate(): boolean {
  try {
    return Deno.env.get("W6W_APP_ALLOW_PRIVATE") === "1";
  } catch {
    return false; // no env permission: stay closed
  }
}

async function defaultResolve(host: string): Promise<string[]> {
  const one = async (k: "A" | "AAAA") => {
    try {
      return await Deno.resolveDns(host, k);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return [];
      throw e;
    }
  };
  const [a, aaaa] = await Promise.all([one("A"), one("AAAA")]);
  return [...new Set([...a, ...aaaa])];
}

function denied(message: string, details?: unknown): W6WError {
  return new W6WError("egress_private_denied", "execute", message, details);
}

export async function assertPublicDestination(
  url: URL | string,
  opts: PublicDestinationOptions = {},
): Promise<PublicDestination> {
  const allowPrivate = opts.allowPrivate ?? appAllowPrivate();
  const host = (typeof url === "string" ? new URL(url) : url).hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIpLiteral(host)) addresses = [host];
  else {
    try {
      addresses = await (opts.resolve ?? defaultResolve)(host);
    } catch (e) {
      throw denied(`Could not resolve host "${host}": ${(e as Error).message}`);
    }
  }
  if (addresses.length === 0) throw denied(`Host "${host}" did not resolve to any address.`);
  if (!allowPrivate) {
    for (const a of addresses) {
      if (isPrivateAddress(a)) {
        throw denied(`Host "${host}" resolves to a private/loopback/link-local address.`);
      }
    }
  }
  return { host, addresses, pinned: addresses[0] };
}

/**
 * Fetch pinned to `dest.pinned`. `http:` is truly pinned (connect-by-IP, Host
 * preserved). `https:` cannot keep SNI via fetch on Deno 2.8, so it is sent on
 * the name and `pinned` is false (see module notes).
 */
export async function pinnedFetch(
  url: URL | string,
  dest: PublicDestination,
  init: RequestInit = {},
  fetchImpl?: typeof fetch,
): Promise<{ response: Response; pinned: boolean }> {
  const u = new URL(typeof url === "string" ? url : url.href);
  if (u.protocol !== "http:" || isIpLiteral(dest.host)) {
    return { response: await (fetchImpl ?? fetch)(u, init), pinned: isIpLiteral(dest.host) };
  }
  const hostHeader = u.host;
  u.hostname = dest.pinned.includes(":") ? `[${dest.pinned}]` : dest.pinned;
  const headers = new Headers(init.headers);
  headers.set("host", hostHeader);
  const client = Deno.createHttpClient({ allowHost: true });
  // The client is left to GC: closing it would cut a still-streaming body.
  const response = await (fetchImpl ?? fetch)(u, { ...init, headers, client } as RequestInit);
  return { response, pinned: true };
}
