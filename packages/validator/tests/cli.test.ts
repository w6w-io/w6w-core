import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { detectKind } from "../cli.ts";

Deno.test("detectKind: App", () => {
  assertEquals(detectKind({ id: "com.acme.x", name: "x", appearance: {} }), "app");
});

Deno.test("detectKind: Action", () => {
  assertEquals(detectKind({ key: "send", type: "perform", title: "Send" }), "action");
});

Deno.test("detectKind: Auth", () => {
  assertEquals(detectKind({ type: "oauth2", displayName: "OAuth" }), "auth");
  assertEquals(detectKind({ type: "apiKey", displayName: "Key" }), "auth");
});

Deno.test("CLI exits 0 for a valid fixture", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      new URL("../cli.ts", import.meta.url).pathname,
      new URL("./fixtures/valid/app/minimal.json", import.meta.url).pathname,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout } = await cmd.output();
  assertEquals(code, 0, new TextDecoder().decode(stdout));
  assert(new TextDecoder().decode(stdout).includes("OK (app)"));
});

Deno.test("CLI exits 1 for an invalid fixture", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      new URL("../cli.ts", import.meta.url).pathname,
      new URL("./fixtures/invalid/app/bad-id-not-reverse-dns.json", import.meta.url).pathname,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  assertEquals(code, 1);
  assert(new TextDecoder().decode(stderr).includes("FAIL (app)"));
});
