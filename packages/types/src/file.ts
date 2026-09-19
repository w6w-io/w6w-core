/**
 * FileRef / ctx.file — the binary channel's vocabulary.
 * See rfcs/param.md (`type: "file"`), rfcs/action.md (`OutputField.type`),
 * and rfcs/hook-runtime.md (`## Amendment` — `ctx.file`).
 */

/** Hard ceiling on ONE file's bytes. Host-enforced on create AND on read. */
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Hard ceiling on the total bytes one run may create. Host-enforced on create. */
export const RUN_FILE_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * A reference to bytes held in the host's run file store. Plain JSON — it travels in step output,
 * in params, and in invocation records, exactly like any other value.
 *
 * Possessing a `FileRef` is NOT authorization to read it. The host resolves `id` inside the run's
 * own scope and refuses anything outside it (opaque UUID + scope-filtered lookup, never a signed
 * token, never a path, never a URL, never a presigned credential).
 */
export interface FileRef {
  /** Discriminator. The literal `"file"` — how any consumer tells a FileRef from a plain object. */
  kind: "file";
  /** Opaque, host-minted, unguessable id (UUID). */
  id: string;
  /** IANA media type recorded at create time. */
  contentType: string;
  /** Exact byte length. Never greater than FILE_MAX_BYTES. */
  size: number;
  /** Advisory display name. Never a filesystem path. */
  filename: string;
  /** RFC 3339 instant after which the host MUST refuse to read the bytes. */
  expiresAt: string;
}

/** True when `v` is a well-formed FileRef. Pure predicate — performs no I/O and grants nothing. */
export function isFileRef(v: unknown): v is FileRef {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.kind === "file" &&
    typeof r.id === "string" &&
    typeof r.contentType === "string" &&
    typeof r.size === "number" &&
    typeof r.filename === "string" &&
    typeof r.expiresAt === "string"
  );
}

/**
 * `ctx.file` — exactly two methods, whole-buffer only. No streaming, no open/close, no listing, no
 * delete. Every call is proxied to the host; the sandbox never holds a handle.
 */
export interface FileCapability {
  /** Fetch a ref's bytes. A bare string is treated as a `FileRef.id`. Rejects outside the run's scope. */
  read(ref: FileRef | string): Promise<{ ref: FileRef; bytes: Uint8Array }>;
  /** Store bytes and mint a ref. Rejects above FILE_MAX_BYTES or the run's remaining budget. */
  create(bytes: Uint8Array, meta: { contentType: string; filename: string }): Promise<FileRef>;
}
