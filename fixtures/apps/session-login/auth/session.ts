import { type AuthDefinition, ReauthRequiredError } from "@w6w/types";

/**
 * A login-exchanged bearer session, for `runAuthHook`'s `exchange` and the re-auth signal. Every
 * branch is picked by the input, so no hook talks to a network:
 *   - `exchange`: password `wrong` throws a coded error (`invalid_credentials`); anything else
 *     returns `{ token, refreshToken }` — never the password.
 *   - `refresh`: refresh token `reused` throws `ReauthRequiredError("refresh_token_reused")`;
 *     `revoked-plain` throws the same signal as a plain Error with `code`/`reason` (no import);
 *     `bad-reason` signals re-auth with a reason that is not a code (dropped at the boundary);
 *     `bad-code` throws a code that is not a code (dropped: a plain `hook_failed`); `flaky` throws
 *     a plain Error; anything else rotates.
 */
const session: AuthDefinition = {
  key: "session",
  type: "bearer",
  displayName: "Email & password",
  accessTokenTtlSeconds: 604800,
  refreshTokenTtlSeconds: 2592000,
  fields: [
    { key: "email", label: "Email", type: "string", required: true },
    { key: "password", label: "Password", type: "secret", required: true },
  ],

  exchange({ fields }) {
    const f = (fields ?? {}) as Record<string, unknown>;
    if (f.password === "wrong") {
      throw Object.assign(new Error(`login refused for ${String(f.email)}`), {
        code: "invalid_credentials",
      });
    }
    return { token: `tok-${String(f.email)}`, refreshToken: "r1" };
  },

  refresh({ credential }) {
    const { refreshToken } = credential as { refreshToken?: string };
    switch (refreshToken) {
      case "reused":
        throw new ReauthRequiredError("refresh_token_reused");
      case "revoked-plain":
        throw Object.assign(new Error("org access revoked"), {
          code: "reauth_required",
          reason: "org_access_revoked",
        });
      case "bad-reason":
        throw Object.assign(new Error("x"), { code: "reauth_required", reason: "Bearer abc.def" });
      case "bad-code":
        throw Object.assign(new Error("x"), { code: "token=abc" });
      case "flaky":
        throw new Error("vendor answered 503");
    }
    return { token: "tok-2", refreshToken: "r2" };
  },

  revoke() {},

  sign({ request, credential }) {
    request.headers["authorization"] = `Bearer ${(credential as { token: string }).token}`;
    return request;
  },

  test() {
    return { ok: true };
  },
};

export default session;
