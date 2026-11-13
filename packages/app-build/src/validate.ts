import type { BuildOptions } from "./build.ts";

export type ValidateResult =
  | { ok: true; id: string; version: string }
  | { ok: false; errors: { code: string; message: string }[] };

/** Validate an app directory without leaving output behind. (Stub: implemented in a later slice.) */
export function validateApp(_appDir: string, _opts: BuildOptions = {}): Promise<ValidateResult> {
  return Promise.resolve({
    ok: false,
    errors: [{ code: "not_implemented", message: "validateApp is not implemented yet" }],
  });
}
