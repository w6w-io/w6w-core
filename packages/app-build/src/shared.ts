import { LoadError, resolveSharedRoots as resolve } from "@w6w/runtime";
import { BuildError } from "./errors.ts";

/** Keep the builder's public refusal type while sharing validation with source loading. */
export async function resolveSharedRoots(appDir: string): Promise<string[]> {
  try {
    return await resolve(appDir);
  } catch (error) {
    if (error instanceof LoadError) throw new BuildError(error.code, error.message, appDir);
    throw error;
  }
}
