/**
 * Asset inlining — replaces every app-local image reference in the manifest with a
 * `data:` URI so the artifact is self-contained. Stricter than a host-side walk: refs
 * must be relative, regular files (never symlinks), inside the app dir, a known image
 * type, and within per-file and per-app byte caps. Any failure is a refusal.
 */
import { extname, resolve } from "jsr:@std/path@^1.0.0";
import type { AppManifest, ImageObject } from "@w6w/types";
import { BuildError, isInside } from "./errors.ts";

const REMOTE_OR_DATA = /^(https?|data):/i;

const MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ico: "image/x-icon",
};

export interface AssetLimits {
  maxAssetBytes: number;
  maxAppAssetBytes: number;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

class Inliner {
  total = 0;
  constructor(
    private readonly realAppDir: string,
    private readonly appDir: string,
    private readonly limits: AssetLimits,
  ) {}

  private fail(code: string, msg: string): never {
    throw new BuildError(code, msg, this.appDir);
  }

  async ref(ref: string, where: string): Promise<string> {
    if (REMOTE_OR_DATA.test(ref)) return ref;
    if (
      ref === "" || ref.startsWith("/") || ref.includes("\\") ||
      ref.split("/").includes("..") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref)
    ) {
      this.fail("asset_path", `${where}: asset ref must be a relative path inside the app: ${ref}`);
    }
    const ext = extname(ref).slice(1).toLowerCase();
    const mime = MIME[ext];
    if (!mime) this.fail("asset_extension", `${where}: unsupported asset type ".${ext}": ${ref}`);
    const path = resolve(this.realAppDir, ref);
    if (!isInside(this.realAppDir, path)) {
      this.fail("asset_path", `${where}: asset ref escapes the app: ${ref}`);
    }
    let st: Deno.FileInfo;
    try {
      st = await Deno.lstat(path);
    } catch {
      this.fail("asset_missing", `${where}: asset not found: ${ref}`);
    }
    if (st.isSymlink) this.fail("asset_symlink", `${where}: asset is a symlink: ${ref}`);
    if (!st.isFile) this.fail("asset_not_file", `${where}: asset is not a regular file: ${ref}`);
    const real = await Deno.realPath(path);
    if (!isInside(this.realAppDir, real)) {
      this.fail("asset_path", `${where}: asset resolves outside the app: ${ref}`);
    }
    if (st.size > this.limits.maxAssetBytes) {
      this.fail(
        "asset_too_large",
        `${where}: asset ${ref} is ${st.size} bytes (cap ${this.limits.maxAssetBytes})`,
      );
    }
    const bytes = await Deno.readFile(real);
    if (bytes.length > this.limits.maxAssetBytes) {
      this.fail("asset_too_large", `${where}: asset ${ref} exceeds ${this.limits.maxAssetBytes}`);
    }
    this.total += bytes.length;
    if (this.total > this.limits.maxAppAssetBytes) {
      this.fail(
        "asset_total_too_large",
        `inlined assets exceed ${this.limits.maxAppAssetBytes} bytes at ${where}`,
      );
    }
    return `data:${mime};base64,${base64(bytes)}`;
  }

  async image(img: ImageObject | undefined, where: string): Promise<ImageObject | undefined> {
    if (!img || typeof img !== "object") return img;
    const out: ImageObject = { ...img };
    if (typeof out.svg === "string") out.svg = await this.ref(out.svg, `${where}.svg`);
    if (typeof out.url === "string") out.url = await this.ref(out.url, `${where}.url`);
    if (out.sizes && typeof out.sizes === "object") {
      const sizes: Record<string, string> = {};
      for (const [k, v] of Object.entries(out.sizes)) {
        sizes[k] = typeof v === "string" ? await this.ref(v, `${where}.sizes.${k}`) : v;
      }
      out.sizes = sizes;
    }
    return out;
  }
}

/**
 * Return a copy of `manifest` with every local image ref inlined as a data URI and
 * `assetsRoot` removed. Covers `appearance.icon`, `appearance.darkMode.icon` and each
 * `screenshots[]` — fields `svg`, `url` and every `sizes` value.
 */
export async function inlineAssets(
  manifest: AppManifest,
  realAppDir: string,
  appDir: string,
  limits: AssetLimits,
): Promise<AppManifest> {
  const inl = new Inliner(realAppDir, appDir, limits);
  const out = structuredClone(manifest) as AppManifest & { assetsRoot?: string };
  delete out.assetsRoot;
  const ap = out.appearance;
  if (ap) {
    if (ap.icon) ap.icon = (await inl.image(ap.icon, "appearance.icon"))!;
    if (ap.darkMode?.icon) {
      ap.darkMode.icon = (await inl.image(ap.darkMode.icon, "appearance.darkMode.icon"))!;
    }
  }
  if (Array.isArray(out.screenshots)) {
    for (let i = 0; i < out.screenshots.length; i++) {
      out.screenshots[i] = (await inl.image(out.screenshots[i], `screenshots[${i}]`))!;
    }
  }
  return out;
}
