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
 *    can't be kept by rewriting the URL. Instead `https:` goes through a
 *    per-request, in-process CONNECT proxy bound to 127.0.0.1:0: fetch (via
 *    `createHttpClient({ proxy })`) sends `CONNECT name:port`, the proxy dials
 *    the PINNED IP and tunnels raw bytes, and TLS (SNI + certificate name) runs
 *    end to end against the real name. No second DNS lookup happens anywhere.
 *    This keeps fetch's streaming/redirect/size behaviour untouched (no
 *    hand-rolled HTTP/1.1).
 */
import { W6WError } from "./errors.ts";
import { isIpLiteral, isPrivateAddress } from "./socket.ts";

export interface PublicDestinationOptions {
  /** Skip the check. Default: `W6W_APP_ALLOW_PRIVATE=1`. */
  allowPrivate?: boolean;
  /** Resolve a hostname to addresses. Default: `Deno.resolveDns` A+AAAA. */
  resolve?: (host: string) => Promise<string[]>;
  /** Test seam: the fetch the pinned request is sent with. Default: global `fetch`. */
  fetchImpl?: typeof fetch;
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
 * Start a one-shot CONNECT proxy that only tunnels to `ip:port`. The listener
 * closes with the client (`close()`); any CONNECT target other than the
 * expected `host:port` is refused so the proxy can't be steered elsewhere.
 */
function startPinProxy(host: string, port: number, ip: string) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const want = `${host.includes(":") ? `[${host}]` : host}:${port}`.toLowerCase();
  const dec = new TextDecoder();
  const handle = async (down: Deno.Conn) => {
    let up: Deno.Conn | undefined;
    try {
      let head = "";
      const buf = new Uint8Array(2048);
      while (!head.includes("\r\n\r\n") && head.length < 8192) {
        const n = await down.read(buf);
        if (n === null) throw new Error("closed");
        head += dec.decode(buf.subarray(0, n), { stream: true });
      }
      const m = /^CONNECT (\S+) HTTP\/1\.[01]\r\n/i.exec(head);
      if (!m || m[1].toLowerCase() !== want) {
        await down.write(new TextEncoder().encode("HTTP/1.1 403 Forbidden\r\n\r\n"));
        down.close();
        return;
      }
      up = await Deno.connect({ hostname: ip, port });
      await down.write(new TextEncoder().encode("HTTP/1.1 200 Connection established\r\n\r\n"));
      await Promise.allSettled([
        down.readable.pipeTo(up.writable),
        up.readable.pipeTo(down.writable),
      ]);
    } catch {
      try {
        down.close();
      } catch { /* already closed */ }
      try {
        up?.close();
      } catch { /* already closed */ }
    }
  };
  (async () => {
    try {
      for await (const c of listener) handle(c);
    } catch { /* listener closed */ }
  })();
  return { port: (listener.addr as Deno.NetAddr).port, close: () => listener.close() };
}

/** Wrap a body so `done` runs once it is fully read, cancelled or errored. */
function onBodyDone(res: Response, done: () => void): Response {
  if (!res.body) {
    done();
    return res;
  }
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const r = await reader.read();
        if (r.done) {
          c.close();
          done();
        } else c.enqueue(r.value);
      } catch (e) {
        done();
        c.error(e);
      }
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/**
 * Fetch pinned to `dest.pinned`. `http:` connects by IP with Host preserved;
 * `https:` tunnels through the in-process CONNECT proxy to the pinned IP (see
 * module notes). `tlsCaCerts` is a test seam (extra trusted PEMs).
 */
export async function pinnedFetch(
  url: URL | string,
  dest: PublicDestination,
  init: RequestInit = {},
  fetchImpl?: typeof fetch,
  tlsCaCerts?: string[],
): Promise<{ response: Response; pinned: boolean }> {
  const u = new URL(typeof url === "string" ? url : url.href);
  if (isIpLiteral(dest.host)) {
    return { response: await (fetchImpl ?? fetch)(u, init), pinned: true };
  }
  if (u.protocol === "https:") {
    const port = u.port ? Number(u.port) : 443;
    const proxy = startPinProxy(dest.host, port, dest.pinned);
    let client: Deno.HttpClient | undefined;
    try {
      client = Deno.createHttpClient({
        proxy: { url: `http://127.0.0.1:${proxy.port}` },
        ...(tlsCaCerts ? { caCerts: tlsCaCerts } : {}),
      });
      const response = await (fetchImpl ?? fetch)(u, { ...init, client } as RequestInit);
      const c = client;
      return {
        response: onBodyDone(response, () => {
          proxy.close();
          c.close();
        }),
        pinned: true,
      };
    } catch (e) {
      proxy.close();
      client?.close();
      throw e;
    }
  }
  if (u.protocol !== "http:") {
    return { response: await (fetchImpl ?? fetch)(u, init), pinned: false };
  }
  const hostHeader = u.host;
  u.hostname = dest.pinned.includes(":") ? `[${dest.pinned}]` : dest.pinned;
  const headers = new Headers(init.headers);
  headers.set("host", hostHeader);
  const client = Deno.createHttpClient({ allowHost: true });
  try {
    const response = await (fetchImpl ?? fetch)(u, { ...init, headers, client } as RequestInit);
    // Closed once the body is done, not before: closing would cut a still-streaming body.
    return { response: onBodyDone(response, () => client.close()), pinned: true };
  } catch (e) {
    client.close();
    throw e;
  }
}
