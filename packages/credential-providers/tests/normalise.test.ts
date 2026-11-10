import { assert, assertEquals, assertThrows } from "jsr:@std/assert@^1.0.0";
import { W6WError } from "@w6w/runtime";
import type { ServiceAccountConfig } from "@w6w/types";
import { normaliseLegacyGoogleServiceAccount as norm } from "../mod.ts";
import { testKey } from "./_keys.ts";

const EMAIL = "sa@proj.iam.gserviceaccount.com";
const KEY = (await testKey()).pem;
const S = (n: string) => `https://www.googleapis.com/auth/${n}`;

const decl = (
  scopes: string[],
  impersonation: ServiceAccountConfig["impersonation"] = "optional",
): ServiceAccountConfig => ({ accepts: ["google-service-account.v1"], scopes, impersonation });

// One row per gap-analysis-D §2 module. `emailKey` is the legacy field carrying client_email.
type Row = {
  app: string;
  emailKey: "email" | "clientEmail";
  delegateKey?: string;
  scopesKey?: string;
  declared: ServiceAccountConfig;
  extra?: Record<string, unknown>;
  settings?: Record<string, string>;
  projectId?: string;
};
const rows: Row[] = [
  {
    app: "gmail",
    emailKey: "email",
    delegateKey: "delegatedEmail",
    declared: decl([S("gmail.modify"), S("gmail.send")], "required"),
  },
  {
    app: "sheets",
    emailKey: "email",
    delegateKey: "subject",
    scopesKey: "scopes",
    declared: decl([S("spreadsheets"), S("drive")]),
  },
  {
    app: "forms",
    emailKey: "email",
    delegateKey: "subject",
    scopesKey: "scopes",
    declared: decl([S("forms.body")]),
  },
  {
    app: "slides",
    emailKey: "email",
    delegateKey: "subject",
    scopesKey: "scopes",
    declared: decl([S("presentations")]),
  },
  {
    app: "docs",
    emailKey: "email",
    delegateKey: "subject",
    scopesKey: "scopes",
    declared: decl([S("documents")]),
  },
  {
    app: "admin",
    emailKey: "email",
    delegateKey: "subject",
    scopesKey: "scopes",
    declared: decl([S("admin.directory.user"), S("admin.directory.group")], "required"),
  },
  {
    app: "drive",
    emailKey: "clientEmail",
    delegateKey: "delegatedEmail",
    declared: decl([S("drive")]),
  },
  {
    app: "calendar",
    emailKey: "clientEmail",
    delegateKey: "impersonate",
    declared: decl([S("calendar"), S("calendar.events")]),
  },
  {
    app: "meet",
    emailKey: "clientEmail",
    delegateKey: "impersonate",
    declared: decl([S("meetings.space.created"), S("meetings.space.readonly")]),
  },
  {
    app: "vertex",
    emailKey: "email",
    declared: decl([S("cloud-platform")], "none"),
    extra: { projectId: "my-proj", location: "us-central1" },
    settings: { projectId: "my-proj", location: "us-central1" },
    projectId: "my-proj",
  },
  {
    app: "gcs",
    emailKey: "clientEmail",
    declared: decl([S("devstorage.full_control")], "none"),
    extra: { projectId: "bucket-proj" },
    settings: { projectId: "bucket-proj" },
    projectId: "bucket-proj",
  },
];

for (const r of rows) {
  Deno.test(`normaliser row: ${r.app}`, async () => {
    const k = await testKey();
    const payload: Record<string, unknown> = {
      [r.emailKey]: EMAIL,
      privateKey: k.pem.trim().replace(/\n/g, "\\n"),
      accessToken: "stale",
      expiresAt: 123,
      ...r.extra,
    };
    if (r.delegateKey) payload[r.delegateKey] = "boss@corp.com";
    const out = norm(payload, r.declared);
    assertEquals(out.source.client_email, EMAIL);
    assertEquals(out.source.private_key, k.pem.trim());
    assertEquals(out.source.type, "service_account");
    assertEquals(out.source.project_id, r.projectId);
    assert(!("scopes" in out.source) && !("token_uri" in out.source));
    assert(!("accessToken" in out.source) && !("expiresAt" in out.source));
    assertEquals(out.approved.scopes, r.declared.scopes);
    assertEquals(out.binding.scopes, r.declared.scopes);
    assertEquals(out.binding.settings, r.settings);
    if (r.delegateKey) {
      assertEquals(out.binding.delegatedUser, "boss@corp.com");
      assertEquals(out.approved.delegatedUser, "boss@corp.com");
    } else {
      assertEquals(out.binding.delegatedUser, undefined);
      assertEquals(out.approved.delegatedUser, null);
    }
    assert(!JSON.stringify(out.binding).includes("stale"));
  });
}

async function base(extra: Record<string, unknown> = {}) {
  const k = await testKey();
  return { email: EMAIL, privateKey: k.pem, ...extra };
}

Deno.test("common: client_email|private_key canonical names; missing type defaults", async () => {
  const k = await testKey();
  const out = norm(
    { client_email: EMAIL, private_key: k.pem, type: "service_account" },
    decl(["a"]),
  );
  assertEquals(out.source.client_email, EMAIL);
  assertEquals(out.source.type, "service_account");
});

Deno.test("common: any other type is refused", () => {
  const e = assertThrows(() =>
    norm({ email: EMAIL, privateKey: KEY, type: "authorized_user" }, decl(["a"]))
  );
  assert(e instanceof W6WError && e.code === "credential_invalid");
});

Deno.test("common: non-object payload is refused", () => {
  assertThrows(() => norm("x", decl(["a"])), W6WError);
  assertThrows(() => norm(null, decl(["a"])), W6WError);
  assertThrows(() => norm([], decl(["a"])), W6WError);
});

Deno.test("delegate: first non-empty of delegatedEmail|subject|impersonate|delegatedUser", async () => {
  const b = await base();
  const out = norm(
    {
      ...b,
      delegatedEmail: "",
      subject: "  ",
      impersonate: "third@x.com",
      delegatedUser: "fourth@x.com",
    },
    decl(["a"]),
  );
  assertEquals(out.binding.delegatedUser, "third@x.com");
  assertEquals(
    norm({ ...b, delegatedUser: "only@x.com" }, decl(["a"])).approved.delegatedUser,
    "only@x.com",
  );
});

Deno.test("delegate: self-sub (case-insensitive) is dropped", async () => {
  const out = norm(await base({ delegatedEmail: EMAIL.toUpperCase() }), decl(["a"]));
  assertEquals(out.binding.delegatedUser, undefined);
  assertEquals(out.approved.delegatedUser, null);
  assert(!("delegatedUser" in out.binding));
});

Deno.test("delegate: impersonation none forces null", async () => {
  const out = norm(await base({ delegatedEmail: "u@x.com" }), decl(["a"], "none"));
  assertEquals(out.approved.delegatedUser, null);
  assert(!("delegatedUser" in out.binding));
});

Deno.test("delegate: required and absent -> credential_invalid field delegatedUser", async () => {
  for (const p of [await base(), await base({ delegatedEmail: EMAIL })]) {
    const e = assertThrows(() => norm(p, decl(["a"], "required")), W6WError);
    assertEquals(e.code, "credential_invalid");
    assertEquals((e.details as { field: string }).field, "delegatedUser");
  }
});

Deno.test("scopes: payload string is intersected with declared, in declared order, deduped", async () => {
  const out = norm(
    await base({ scopes: "c  b\nz b" }),
    decl(["a", "b", "c", "b"]),
  );
  assertEquals(out.approved.scopes, ["b", "c"]);
  assertEquals(out.binding.scopes, ["b", "c"]);
});

Deno.test("scopes: payload array form works", async () => {
  assertEquals(norm(await base({ scopes: ["c", "a"] }), decl(["a", "b", "c"])).approved.scopes, [
    "a",
    "c",
  ]);
});

Deno.test("scopes: widening row -- payload scopes outside declared never widen; may be empty", async () => {
  const out = norm(await base({ scopes: "x y" }), decl(["a", "b"]));
  assertEquals(out.approved.scopes, []);
  assertEquals(out.binding.scopes, []);
  const out2 = norm(await base({ scopes: "a x" }), decl(["a", "b"]));
  assertEquals(out2.approved.scopes, ["a"]);
});

Deno.test("scopes: absent or blank payload scopes -> declared", async () => {
  assertEquals(norm(await base(), decl(["a", "b"])).approved.scopes, ["a", "b"]);
  assertEquals(norm(await base({ scopes: "  " }), decl(["a", "b"])).approved.scopes, ["a", "b"]);
});

Deno.test("derived state dropped: accessToken/expiresAt/access_token/expires_at never surface", async () => {
  const out = norm(
    await base({
      accessToken: "STALE-ONE-q9x",
      expiresAt: "EXP-ISO-q9x",
      access_token: "STALE-TWO-q9x",
      expires_at: 9,
    }),
    decl(["a"]),
  );
  const s = JSON.stringify(out);
  for (const needle of ["STALE-ONE-q9x", "STALE-TWO-q9x", "EXP-ISO-q9x", '"expires']) {
    assert(!s.includes(needle), needle);
  }
});

Deno.test("settings: omitted when empty; non-string projectId/location ignored", async () => {
  const out = norm(await base({ projectId: 5, location: {} }), decl(["a"]));
  assert(!("settings" in out.binding));
  assertEquals(out.source.project_id, undefined);
});

Deno.test("source never carries payload scopes or token_uri", async () => {
  const out = norm(
    await base({ scopes: "a", token_uri: "https://evil.example/token" }),
    decl(["a"]),
  );
  assert(!("scopes" in out.source));
  assert(!("token_uri" in out.source));
});

Deno.test("invalid key in payload is refused by validateSource", () => {
  const e = assertThrows(() => norm({ email: EMAIL, privateKey: "nope" }, decl(["a"])), W6WError);
  assertEquals((e.details as { field: string }).field, "private_key");
});

Deno.test("binding.scopes and approved.scopes are distinct arrays", async () => {
  const out = norm(await base({}), decl(["a", "b"]));
  assert(out.binding.scopes !== out.approved.scopes);
  out.binding.scopes!.push("widened");
  assertEquals(out.approved.scopes, ["a", "b"]);
});

// ---- connect-form wrapper `{serviceAccountKey, ...outer}` (R-9 / SEAM-7) ----

async function keyObject() {
  const k = await testKey();
  return {
    type: "service_account",
    client_email: EMAIL,
    private_key: k.pem,
    private_key_id: "kid1",
    client_id: "cid1",
    project_id: "inner-proj",
  };
}

Deno.test("wrapper: object, JSON string and wrapper+outer all equal the flat source", async () => {
  const inner = await keyObject();
  const d = decl([S("drive")]);
  const flat = norm({ ...inner }, d);
  const asObject = norm({ serviceAccountKey: inner }, d);
  const asString = norm({ serviceAccountKey: JSON.stringify(inner) }, d);
  assertEquals(asObject.source, flat.source);
  assertEquals(asString.source, flat.source);
  assertEquals(asObject.binding, flat.binding);
  const withUser = norm(
    { serviceAccountKey: JSON.stringify(inner), delegatedUser: "boss@corp.com" },
    d,
  );
  assertEquals(withUser.source, flat.source);
  assertEquals(withUser.binding.delegatedUser, "boss@corp.com");
  assertEquals(withUser.approved.delegatedUser, "boss@corp.com");
  assertEquals(asObject.binding.delegatedUser, undefined);
});

Deno.test("wrapper: outer delegatedUser is read from the outer payload only", async () => {
  const inner = await keyObject();
  // A delegatedUser smuggled inside the key object is not a binding input.
  const out = norm(
    { serviceAccountKey: { ...inner, delegatedUser: "inner@corp.com" } },
    decl([S("drive")]),
  );
  assertEquals(out.binding.delegatedUser, undefined);
  assertEquals(out.approved.delegatedUser, null);
  // The required-impersonation check still fires on the outer payload.
  assertThrows(
    () => norm({ serviceAccountKey: inner }, decl([S("gmail.send")], "required")),
    W6WError,
  );
  const ok = norm(
    { serviceAccountKey: inner, delegatedUser: "boss@corp.com" },
    decl([S("gmail.send")], "required"),
  );
  assertEquals(ok.binding.delegatedUser, "boss@corp.com");
});

Deno.test("wrapper + outer projectId/location land in binding.settings, typed (R-19)", async () => {
  const inner = await keyObject();
  const out = norm(
    { serviceAccountKey: inner, projectId: "my-proj", location: "us-central1" },
    decl([S("cloud-platform")], "none"),
  );
  assertEquals(out.binding.settings, { projectId: "my-proj", location: "us-central1" });
  // the key's own project_id stays the source's; the outer projectId is a setting only
  assertEquals(out.source.project_id, "inner-proj");
  const noSettings = norm({ serviceAccountKey: inner }, decl([S("cloud-platform")], "none"));
  assertEquals(noSettings.binding.settings, undefined);
});

Deno.test("wrapper: scopes on the outer payload narrow the approved scopes", async () => {
  const inner = await keyObject();
  const out = norm(
    { serviceAccountKey: inner, scopes: [S("drive")] },
    decl([S("drive"), S("spreadsheets")]),
  );
  assertEquals(out.approved.scopes, [S("drive")]);
});

Deno.test("wrapper: a malformed serviceAccountKey fails on that field, leaking no key material", async () => {
  const inner = await keyObject();
  const pem = inner.private_key;
  const body = pem.split("\n").filter((l) => l && !l.startsWith("-----"))[0];
  const bad: unknown[] = [
    "not json " + body,
    JSON.stringify([inner]),
    JSON.stringify("x" + body),
    42,
    null,
    ["a"],
    true,
  ];
  for (const v of bad) {
    const e = assertThrows(() => norm({ serviceAccountKey: v }, decl([S("drive")])), W6WError);
    assertEquals((e.details as { field?: string }).field, "serviceAccountKey");
    assertEquals(e.code, "credential_invalid");
    const text = JSON.stringify({ m: e.message, d: e.details });
    assert(!text.includes(body.slice(0, 12)) && !text.includes(EMAIL));
  }
});

Deno.test("wrapper: a bad INNER key fails with the key's own field, no key material", async () => {
  const inner = await keyObject();
  const e = assertThrows(
    () =>
      norm(
        { serviceAccountKey: { ...inner, private_key: "-----BEGIN PRIVATE KEY-----\nQUJD\n" } },
        decl([S("drive")]),
      ),
    W6WError,
  );
  assertEquals((e.details as { field?: string }).field, "private_key");
  assert(!JSON.stringify({ m: e.message, d: e.details }).includes("QUJD"));
});
