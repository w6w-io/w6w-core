// Stages the author-toolchain packages in an isolated temp workspace and runs
// `deno publish --dry-run` in each, asserting the four toolchain versions agree.
// Offline: no network, no --allow-slow-types.

const PACKAGES = ["types", "expr", "runtime", "validator", "app-build"];
const LOCKSTEP = ["types", "runtime", "validator", "app-build"];

const root = new URL("..", import.meta.url).pathname;
const tmp = await Deno.makeTempDir({ prefix: "w6w-author-pkgs-" });
let failed = false;

try {
  const versions: Record<string, string> = {};
  for (const p of PACKAGES) {
    const dest = `${tmp}/packages/${p}`;
    await Deno.mkdir(dest, { recursive: true });
    const cp = await new Deno.Command("cp", { args: ["-R", `${root}packages/${p}/.`, dest] })
      .output();
    if (!cp.success) throw new Error(`cannot stage ${p}`);
    for (const junk of ["node_modules", "deno.lock"]) {
      await Deno.remove(`${dest}/${junk}`, { recursive: true }).catch(() => {});
    }
    await Deno.copyFile(`${root}LICENSE`, `${dest}/LICENSE`);
    const cfg = JSON.parse(await Deno.readTextFile(`${dest}/deno.json`));
    versions[p] = cfg.version;
  }
  await Deno.writeTextFile(
    `${tmp}/deno.json`,
    JSON.stringify({ workspace: PACKAGES.map((p) => `./packages/${p}`) }),
  );

  const want = versions[LOCKSTEP[0]];
  for (const p of LOCKSTEP) {
    if (versions[p] !== want) {
      console.error(`FAIL @w6w/${p}: version ${versions[p]} != ${want} (lockstep)`);
      failed = true;
    }
  }
  if (!failed) console.log(`versions: lockstep ${want} (expr ${versions.expr})`);

  for (const p of PACKAGES) {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["publish", "--dry-run", "--allow-dirty", "--no-check"],
      cwd: `${tmp}/packages/${p}`,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.success) {
      console.log(`ok   @w6w/${p}`);
    } else {
      failed = true;
      const msg = new TextDecoder().decode(out.stderr).split("\n").slice(-15).join("\n");
      console.error(`FAIL @w6w/${p}: dry-run failed\n${msg}`);
    }
  }
} finally {
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
}
Deno.exit(failed ? 1 : 0);
