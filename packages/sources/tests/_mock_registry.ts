/**
 * Local mock registry for npm (and, extended by the JSR tests, JSR). `Deno.serve({port:0})`,
 * records every request (path + headers). No live network.
 */

export interface RecordedRequest {
  path: string;
  headers: Headers;
}

/** A tar entry value: file text, or a non-regular entry (link/directory) the TarStream cannot emit. */
export type TgzEntry = string | { type: "symlink" | "link"; linkname: string } | {
  type: "directory";
};

function tarHeader(name: string, size: number, typeflag: string, linkname = ""): Uint8Array {
  const h = new Uint8Array(512);
  const enc = new TextEncoder();
  const put = (off: number, v: string) => h.set(enc.encode(v), off);
  const oct = (n: number, w: number) => n.toString(8).padStart(w - 1, "0") + "\0";
  put(0, name);
  put(100, oct(0o644, 8));
  put(108, oct(0, 8));
  put(116, oct(0, 8));
  put(124, oct(size, 12));
  put(136, oct(0, 12));
  put(148, "        ");
  put(156, typeflag);
  put(157, linkname);
  put(257, "ustar\0");
  put(263, "00");
  let sum = 0;
  for (const b of h) sum += b;
  put(148, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

/** Build a gzip'd tarball; hand-rolled ustar so tests can emit symlink/hardlink/directory entries. */
export async function makeTgz(
  files: Record<string, TgzEntry>,
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array[] = [];
  for (const [path, v] of Object.entries(files)) {
    if (typeof v === "string") {
      const bytes = new TextEncoder().encode(v);
      parts.push(tarHeader(path, bytes.length, "0"));
      parts.push(bytes);
      parts.push(new Uint8Array((512 - (bytes.length % 512)) % 512));
    } else if (v.type === "directory") {
      parts.push(tarHeader(path.endsWith("/") ? path : path + "/", 0, "5"));
    } else {
      parts.push(tarHeader(path, 0, v.type === "symlink" ? "2" : "1", v.linkname));
    }
  }
  parts.push(new Uint8Array(1024));
  const gz = new Blob(parts as BlobPart[]).stream().pipeThrough(
    new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
  return new Uint8Array(await new Response(gz).arrayBuffer()) as Uint8Array<ArrayBuffer>;
}

export async function sha512Sri(b: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-512", b));
  return "sha512-" + btoa(String.fromCharCode(...d));
}

export interface NpmVersionOpts {
  files?: Record<string, TgzEntry>;
  deprecated?: string;
  /** Override `dist.tarball` (e.g. an off-origin URL). */
  tarballUrl?: string;
  /** Override `dist.integrity`. */
  integrity?: string;
  /** Serve the tarball path as a 302 to this URL. */
  redirectTo?: string;
  /** Serve these raw bytes instead of the built tarball. */
  rawTarball?: Uint8Array<ArrayBuffer>;
}

export interface JsrVersionOpts {
  yanked?: boolean;
  /** Manifest key -> raw file text. Keys are used verbatim (e.g. `/w6w/app.js`). */
  files?: Record<string, string>;
  /** Manifest key -> checksum override (e.g. a wrong hash). */
  badChecksum?: Record<string, string>;
  /** Manifest key -> size override. */
  badSize?: Record<string, number>;
}

export type ExtraHandler = (req: Request, url: URL) => Response | Promise<Response> | undefined;

export class MockRegistry {
  readonly requests: RecordedRequest[] = [];
  readonly extra: ExtraHandler[] = [];
  private packs = new Map<string, {
    tags: Record<string, string>;
    versions: Map<string, { opts: NpmVersionOpts; tgz: Uint8Array<ArrayBuffer>; sri: string }>;
  }>();
  private jsr = new Map<string, Map<string, JsrVersionOpts & { files: Record<string, string> }>>();
  private server: Deno.HttpServer;
  readonly base: string;

  constructor() {
    this.server = Deno.serve({ port: 0, onListen() {} }, (req) => this.handle(req));
    this.base = `http://127.0.0.1:${(this.server.addr as Deno.NetAddr).port}`;
  }

  /** Requests whose path starts with `prefix`. */
  hits(prefix = ""): RecordedRequest[] {
    return this.requests.filter((r) => r.path.startsWith(prefix));
  }

  async addNpm(name: string, version: string, opts: NpmVersionOpts = {}): Promise<void> {
    const files = opts.files ?? {
      "package/package.json": JSON.stringify({ name, version }),
      "package/w6w/app.js": "export default 1;",
    };
    const tgz = await makeTgz(files);
    let p = this.packs.get(name);
    if (!p) this.packs.set(name, p = { tags: {}, versions: new Map() });
    p.versions.set(version, { opts, tgz, sri: await sha512Sri(tgz) });
  }

  addJsr(name: string, version: string, opts: JsrVersionOpts = {}): void {
    const files = opts.files ?? {
      "/deno.json": JSON.stringify({ name, version, exports: "./w6w/app.js" }),
      "/w6w/app.js": "export default 1;",
      "/README.md": "readme",
      "/src/other.ts": "export {}",
    };
    let p = this.jsr.get(name);
    if (!p) this.jsr.set(name, p = new Map());
    p.set(version, { ...opts, files });
  }

  private async handleJsr(url: URL): Promise<Response | undefined> {
    const m = /^\/(@[^/]+\/[^/]+)\/(.+)$/.exec(url.pathname);
    if (!m) return undefined;
    const p = this.jsr.get(m[1]);
    if (!p) return undefined;
    const rest = m[2];
    if (rest === "meta.json") {
      const versions: Record<string, unknown> = {};
      for (const [v, o] of p) versions[v] = o.yanked ? { yanked: true } : {};
      return Response.json({ scope: "", name: m[1], versions });
    }
    const mm = /^([^/]+)_meta\.json$/.exec(rest);
    if (mm) {
      const o = p.get(mm[1]);
      if (!o) return new Response("nope", { status: 404 });
      const manifest: Record<string, unknown> = {};
      for (const [k, text] of Object.entries(o.files)) {
        const b = new TextEncoder().encode(text);
        const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))]
          .map((x) => x.toString(16).padStart(2, "0")).join("");
        manifest[k] = {
          size: o.badSize?.[k] ?? b.length,
          checksum: o.badChecksum?.[k] ?? `sha256-${h}`,
        };
      }
      return Response.json({ manifest });
    }
    const fm = /^([^/]+)(\/.+)$/.exec(rest);
    const o = fm && p.get(fm[1]);
    const text = o && o.files[decodeURIComponent(fm![2])];
    if (text === undefined || text === null) return new Response("nope", { status: 404 });
    return new Response(text);
  }

  setTag(name: string, tag: string, version: string): void {
    this.packs.get(name)!.tags[tag] = version;
  }

  private tarballPath(name: string, v: string): string {
    return `/-/tgz/${name}/${v}.tgz`;
  }

  private handle(req: Request): Response | Promise<Response> {
    const url = new URL(req.url);
    this.requests.push({ path: url.pathname, headers: new Headers(req.headers) });
    for (const h of this.extra) {
      const r = h(req, url);
      if (r) return r;
    }
    if (url.pathname.startsWith("/@") && url.pathname.split("/").length > 3) {
      return this.handleJsr(url).then((r) => r ?? new Response("not found", { status: 404 }));
    }
    if (url.pathname.startsWith("/-/tgz/")) {
      const m = /^\/-\/tgz\/(.+)\/([^/]+)\.tgz$/.exec(url.pathname);
      const v = m && this.packs.get(m[1])?.versions.get(m[2]);
      if (!v) return new Response("nope", { status: 404 });
      if (v.opts.redirectTo) {
        return new Response(null, { status: 302, headers: { location: v.opts.redirectTo } });
      }
      return new Response(v.opts.rawTarball ?? v.tgz);
    }
    const name = decodeURIComponent(url.pathname.slice(1));
    const p = this.packs.get(name);
    if (!p) return new Response("not found", { status: 404 });
    const versions: Record<string, unknown> = {};
    for (const [ver, v] of p.versions) {
      versions[ver] = {
        name,
        version: ver,
        ...(v.opts.deprecated ? { deprecated: v.opts.deprecated } : {}),
        dist: {
          tarball: v.opts.tarballUrl ?? `${this.base}${this.tarballPath(name, ver)}`,
          integrity: v.opts.integrity ?? v.sri,
        },
      };
    }
    return Response.json({ name, "dist-tags": p.tags, versions });
  }

  close(): Promise<void> {
    return this.server.shutdown();
  }
}
