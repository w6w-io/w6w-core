/**
 * Where the real apps the build/cli/validate suites exercise live.
 *
 * Before the apps split every app sat in the sibling `apps` checkout (`apps/apps/<name>`). After
 * it, each app lives in its own pack repo, checked out INSIDE the `apps` (tooling) checkout as one
 * of its submodules (`apps/<group>/apps/<name>`), with `apps/apps` keeping only `_shared`; so a
 * name has to be looked up across the pack checkouts under the sibling `apps`. With none of them
 * checked out (a bare `core` clone) `findApp` returns `null` and `haveApps` is `false`; the suites
 * then `ignore` their real-app tests instead of failing.
 */
import { fromFileUrl, join } from "jsr:@std/path@^1.0.0";

/** The six real apps the suites build; `haveApps` requires all of them. */
export const REAL_APPS = ["apify", "gotify", "webex", "hubspot", "aws/s3", "salesforce"] as const;

/** The lane directory the pack checkouts sit in (`core` is one of its entries). */
const LANE = fromFileUrl(new URL("../../../../", import.meta.url));

const PACK = "w6w-pack.json";

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

/**
 * The `apps/` roots of the pack checkouts — the legacy root `apps/apps` first (it wins while it
 * still holds the apps), then every pack repo nested in the `apps` checkout (`apps/<group>`, a
 * directory with its own `w6w-pack.json`) in name order.
 */
const PACK_APPS_ROOTS: string[] = (() => {
  const tooling = join(LANE, "apps");
  let groups: string[] = [];
  try {
    groups = [...Deno.readDirSync(tooling)]
      .filter((e) =>
        (e.isDirectory || e.isSymlink) && e.name !== "apps" && isFile(join(tooling, e.name, PACK))
      )
      .map((e) => e.name)
      .sort();
  } catch { /* no apps checkout beside the lane: no pack is checked out */ }
  return [join(tooling, "apps"), ...groups.map((g) => join(tooling, g, "apps"))].filter(isDir);
})();

/** The directory of real app `name` (e.g. `apify`, `aws/s3`), or `null` if no pack holds it. */
export function findApp(name: string): string | null {
  for (const apps of PACK_APPS_ROOTS) {
    const dir = join(apps, name);
    if (isDir(dir)) return dir;
  }
  return null;
}

/** True when every one of `REAL_APPS` is checked out, so the real-app suites can run. */
export const haveApps: boolean = REAL_APPS.every((name) => findApp(name) !== null);

/** `findApp`, for tests already gated on `haveApps`: a miss there is a layout bug, not a skip. */
export function requireApp(name: string): string {
  const dir = findApp(name);
  if (dir === null) throw new Error(`real app ${name} is not checked out beside ${LANE}`);
  return dir;
}
