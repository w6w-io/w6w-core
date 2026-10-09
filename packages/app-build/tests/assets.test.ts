/** Asset inlining and its refusals — generated fixtures only. */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { dirname, join } from "jsr:@std/path@^1.0.0";
import { buildApp, BuildError } from "../mod.ts";

const SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'/>";

function pkgJson(w6w: Record<string, unknown>): string {
  return JSON.stringify({
    name: "@w6w-fixtures/assets",
    version: "1.0.0",
    description: "fixture",
    license: "MIT",
    author: { name: "w6w" },
    categories: ["developer-tools"],
    w6w: { id: "io.test.assets", displayName: "Assets", entry: "./index.ts", ...w6w },
  });
}

async function fixture(
  appearance: unknown,
  extra: Record<string, string | Uint8Array> = {},
  w6w: Record<string, unknown> = {},
) {
  const tmp = await Deno.realPath(await Deno.makeTempDir({ prefix: "w6w-assets-" }));
  const app = join(tmp, "app");
  const files: Record<string, string | Uint8Array> = {
    "package.json": pkgJson({ appearance, ...w6w }),
    "deno.json": "{}",
    "index.ts": "export default { actions: [] };\n",
    ...extra,
  };
  for (const [rel, content] of Object.entries(files)) {
    await Deno.mkdir(dirname(join(app, rel)), { recursive: true });
    await Deno.writeFile(
      join(app, rel),
      typeof content === "string" ? new TextEncoder().encode(content) : content,
    );
  }
  return { tmp, app, out: join(tmp, "out") };
}

async function refuse(
  code: string,
  appearance: unknown,
  extra: Record<string, string | Uint8Array> = {},
  opts: { maxAssetBytes?: number; maxAppAssetBytes?: number } = {},
  setup?: (f: { app: string }) => Promise<void>,
  w6w: Record<string, unknown> = {},
) {
  const f = await fixture(appearance, extra, w6w);
  try {
    await setup?.(f);
    const err = await assertRejects(() => buildApp(f.app, f.out, opts), BuildError);
    assertEquals(err.code, code, err.message);
    let exists = true;
    try {
      await Deno.lstat(f.out);
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "nothing may be written under outRoot");
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
}

Deno.test("assets: local refs inline as data URIs; remote/data refs pass unchanged", async () => {
  const f = await fixture(
    {
      icon: {
        svg: "./assets/icon.svg",
        url: "https://cdn.example/i.png",
        sizes: { "32": "assets/i32.png" },
      },
      darkMode: { icon: { url: "assets/dark.svg", sizes: { "64": "data:image/png;base64,AAAA" } } },
    },
    {
      "assets/icon.svg": SVG,
      "assets/i32.png": new Uint8Array([137, 80, 78, 71]),
      "assets/dark.svg": SVG,
      "assets/shot.webp": new Uint8Array([1, 2, 3]),
    },
    { screenshots: [{ url: "assets/shot.webp", svg: "./assets/icon.svg" }] },
  );
  try {
    const r = await buildApp(f.app, f.out);
    const text = await Deno.readTextFile(join(r.outDir, "manifest.json"));
    const m = JSON.parse(text).manifest;
    assertEquals(m.appearance.icon.svg, `data:image/svg+xml;base64,${btoa(SVG)}`);
    assertEquals(m.appearance.icon.url, "https://cdn.example/i.png");
    assertEquals(m.appearance.icon.sizes["32"], "data:image/png;base64,iVBORw==");
    assertEquals(m.appearance.darkMode.icon.url, `data:image/svg+xml;base64,${btoa(SVG)}`);
    assertEquals(m.appearance.darkMode.icon.sizes["64"], "data:image/png;base64,AAAA");
    assertEquals(m.screenshots[0].url, "data:image/webp;base64,AQID");
    assertEquals(m.screenshots[0].svg, `data:image/svg+xml;base64,${btoa(SVG)}`);
    assert(!text.includes("./assets/") && !text.includes('"assets/'));
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});

const ICON = (url: string) => ({ icon: { url } });

Deno.test("refuse asset: missing", () => refuse("asset_missing", ICON("assets/nope.svg")));

Deno.test("refuse asset: symlinked", () =>
  refuse("asset_symlink", ICON("assets/link.svg"), { "assets/real.svg": SVG }, {}, async (f) => {
    await Deno.symlink(join(f.app, "assets", "real.svg"), join(f.app, "assets", "link.svg"));
  }));

Deno.test("refuse asset: .. segment", () =>
  refuse("asset_path", ICON("../outside.svg"), { "../outside.svg": SVG }));

Deno.test("refuse asset: absolute", () => refuse("asset_path", ICON("/etc/hostname")));

Deno.test("refuse asset: backslash", () => refuse("asset_path", ICON("assets\\a.svg")));

Deno.test("refuse asset: bad extension", () =>
  refuse("asset_extension", ICON("assets/a.txt"), { "assets/a.txt": "hello" }));

Deno.test("refuse asset: over the per-file cap", () =>
  refuse("asset_too_large", ICON("assets/a.svg"), { "assets/a.svg": SVG }, {
    maxAssetBytes: SVG.length - 1,
  }));

Deno.test("refuse asset: over the per-app cap", () =>
  refuse(
    "asset_total_too_large",
    { icon: { svg: "assets/a.svg", url: "assets/b.svg" } },
    { "assets/a.svg": SVG, "assets/b.svg": SVG },
    { maxAssetBytes: SVG.length, maxAppAssetBytes: SVG.length * 2 - 1 },
  ));

Deno.test("refuse asset: directory", () =>
  refuse("asset_not_file", ICON("assets/dir.svg"), { "assets/dir.svg/x": "x" }));
