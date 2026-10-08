/** The one error class every builder refusal is thrown as. */
export class BuildError extends Error {
  /** Stable, machine-readable refusal class (see the list in `mod.ts`). */
  readonly code: string;
  /** The app directory the refusal concerns, as given by the caller. */
  readonly appDir: string;

  constructor(code: string, message: string, appDir: string) {
    super(`[${code}] ${message}`);
    this.name = "BuildError";
    this.code = code;
    this.appDir = appDir;
  }
}

/** True iff `child` is `root` itself or lies strictly beneath it (separator-aware, never a bare prefix). */
export function isInside(root: string, child: string): boolean {
  const r = root.endsWith("/") ? root : root + "/";
  return child === root || child.startsWith(r);
}

/** True iff a POSIX-relative path names test code: a `tests` segment or a `*.test.ts` / `*_test.ts` file. */
export function isTestPath(relPosix: string): boolean {
  const segs = relPosix.split("/");
  if (segs.slice(0, -1).includes("tests") || segs[segs.length - 1] === "tests") return true;
  const base = segs[segs.length - 1];
  return base.endsWith(".test.ts") || base.endsWith("_test.ts");
}
