/**
 * Typed errors. Each carries the phase it failed in, mirroring the Invocation
 * RFC's error table so callers can decide what is retryable.
 */
import type { CredentialErrorCode } from "@w6w/types";

export type ErrorPhase = "load" | "resolution" | "auth" | "execute" | "output";

export class W6WError extends Error {
  constructor(
    /** Machine-readable code, e.g. `unknown_action`, `param_invalid`. */
    readonly code: string,
    readonly phase: ErrorPhase,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "W6WError";
  }

  toJSON() {
    return { code: this.code, phase: this.phase, message: this.message, details: this.details };
  }
}

/** Thrown while loading/parsing an app off disk. */
export class LoadError extends W6WError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, "load", message, details);
    this.name = "LoadError";
  }
}

/**
 * A credential-resolution failure. Phase is always `auth`; `code` is one of
 * `CREDENTIAL_ERROR_CODES` (@w6w/types). Messages name keys and ids, never a
 * credential.
 */
export function credentialError(
  code: CredentialErrorCode,
  message: string,
  details?: unknown,
): W6WError {
  return new W6WError(code, "auth", message, details);
}
