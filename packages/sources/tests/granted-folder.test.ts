import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.0";
import { join } from "jsr:@std/path@^1.0.0";
import { resolveGrantedFolder, SourceError } from "../mod.ts";

/** Scratch layout: `<tmp>/root/…` (the granted root) beside `<tmp>/outside/…`. */
async function withLayout<T>(
  fn: (l: { tmp: string; root: string; real: string; outside: string }) => Promise<T>,
): Promise<T> {
  const tmp = await Deno.realPath(await Deno.makeTempDir());
  const root = join(tmp, "root");
  const outside = join(tmp, "outside");
  await Deno.mkdir(join(root, "app"), { recursive: true });
  await Deno.mkdir(join(root, "other"), { recursive: true });
  await Deno.mkdir(outside, { recursive: true });
  await Deno.writeTextFile(join(root, "app", "a.txt"), "a");
  await Deno.writeTextFile(join(outside, "secret"), "s");
  try {
    return await fn({ tmp, root, real: root, outside });
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
}

/** Assert `folder_escape` and that the message leaks none of `secrets`. */
async function refused(root: string, rel: string, ...secrets: string[]) {
  const err = await assertRejects(() => resolveGrantedFolder(root, rel), SourceError);
  assertEquals(err.code, "folder_escape", `${rel}: ${err.message}`);
  for (const s of secrets) assert(!err.message.includes(s), `message leaks ${s}`);
}

Deno.test("granted folder: root-equal ('' and './') and an in-root subdir are allowed", async () => {
  await withLayout(async ({ root }) => {
    assertEquals(await resolveGrantedFolder(root, ""), root);
    assertEquals(await resolveGrantedFolder(root, "./"), root);
    assertEquals(await resolveGrantedFolder(root, "./app"), join(root, "app"));
  });
});

Deno.test("granted folder: in-root file symlink, dir symlink and a symlink loop are allowed", async () => {
  await withLayout(async ({ root }) => {
    await Deno.symlink(join(root, "app", "a.txt"), join(root, "app", "fl"));
    await Deno.symlink(join(root, "other"), join(root, "app", "dl"));
    await Deno.symlink(".", join(root, "other", "loop")); // other/loop -> other
    await Deno.symlink("../app", join(root, "other", "back")); // app -> other -> app ...
    assertEquals(await resolveGrantedFolder(root, "./app"), join(root, "app"));
    assertEquals(await resolveGrantedFolder(root, ""), root);
  });
});

Deno.test("granted folder: the root itself may be given through a symlink", async () => {
  await withLayout(async ({ tmp, root }) => {
    const via = join(tmp, "via");
    await Deno.symlink(root, via);
    assertEquals(await resolveGrantedFolder(via, "./app"), join(root, "app"));
    assertEquals(await resolveGrantedFolder(via, ""), root);
  });
});

Deno.test("granted folder: grammar violations are folder_escape", async () => {
  await withLayout(async ({ root, outside }) => {
    for (
      const rel of [
        "..",
        "./..",
        "./a/../..",
        "./app/..",
        outside,
        "/etc",
        "app",
        "../outside",
        ".\\app",
        "./a\\b",
        "./a\0b",
        "./app#x",
        "./~",
        "./~/x",
        "file:./app",
        "./app/",
        "./app//x",
        "./.",
        "./app/./x",
      ]
    ) {
      await refused(root, rel, root, outside);
    }
  });
});

Deno.test("granted folder: a file symlink out of root is refused", async () => {
  await withLayout(async ({ root, outside }) => {
    await Deno.symlink(join(outside, "secret"), join(root, "app", "evil"));
    await refused(root, "./app", root, outside, "secret");
  });
});

Deno.test("granted folder: a dir symlink out of root is refused", async () => {
  await withLayout(async ({ root, outside }) => {
    await Deno.symlink(outside, join(root, "app", "evil"));
    await refused(root, "./app", root, outside);
  });
});

Deno.test("granted folder: the two-hop escape via an in-root dir symlink is refused", async () => {
  await withLayout(async ({ root, outside }) => {
    // app/link -> root/other (in root), other/evil -> outside/secret
    await Deno.symlink(join(root, "other"), join(root, "app", "link"));
    await Deno.symlink(join(outside, "secret"), join(root, "other", "evil"));
    await refused(root, "./app", root, outside);
  });
});

Deno.test("granted folder: a dangling symlink is refused", async () => {
  await withLayout(async ({ root }) => {
    await Deno.symlink(join(root, "nowhere"), join(root, "app", "dangling"));
    await refused(root, "./app", root, "nowhere");
  });
});

Deno.test("granted folder: a target that is itself a symlink out of root is refused", async () => {
  await withLayout(async ({ root, outside }) => {
    await Deno.symlink(outside, join(root, "jump"));
    await refused(root, "./jump", root, outside);
  });
});

Deno.test("granted folder: a nested escape deep in the tree is found", async () => {
  await withLayout(async ({ root, outside }) => {
    await Deno.mkdir(join(root, "app", "x", "y"), { recursive: true });
    await Deno.symlink(outside, join(root, "app", "x", "y", "evil"));
    await refused(root, "./app", root, outside);
  });
});

Deno.test("granted folder: a missing root or target is coded and leaks no path", async () => {
  await withLayout(async ({ root, tmp }) => {
    const e1 = await assertRejects(() => resolveGrantedFolder(join(tmp, "nope"), ""), SourceError);
    assertEquals(e1.code, "folder_missing");
    assert(!e1.message.includes(tmp));
    const e2 = await assertRejects(() => resolveGrantedFolder(root, "./gone"), SourceError);
    assertEquals(e2.code, "folder_missing");
    assert(!e2.message.includes(tmp) && !e2.message.includes("gone"));
    const e3 = await assertRejects(() => resolveGrantedFolder(root, "./app/a.txt"), SourceError);
    assertEquals(e3.code, "folder_not_directory");
  });
});
