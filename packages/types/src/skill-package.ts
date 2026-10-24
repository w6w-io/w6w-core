// Pure skill-package validator types + helpers (no I/O, no YAML, no ZIP).
// The server parses the frontmatter YAML and lists archive entries; this module only judges them.

/** Every stable issue code the validator can emit. Documented in core/docs/skill-packages.md. */
export const SKILL_PACKAGE_CODES = [
  // path arms
  "path_absolute",
  "path_traversal",
  "path_backslash",
  "path_control_char",
  "path_invalid_text",
  "path_not_nfc",
  "path_empty_segment",
  "path_too_deep",
  "path_too_long",
  "path_duplicate",
  "credential_path",
  // entry-kind arms
  "entry_symlink",
  "entry_hardlink",
  "entry_device",
  "entry_other",
  // limits
  "file_too_large",
  "package_too_large",
  "too_many_files",
  // package shape
  "skill_md_missing",
  "no_entries",
  // frontmatter
  "frontmatter_missing",
  "frontmatter_unterminated",
  "frontmatter_too_large",
  "frontmatter_too_many_nodes",
  "frontmatter_not_object",
  "frontmatter_name_invalid",
  "frontmatter_description_invalid",
  // warnings
  "inert_field",
  "inert_script",
] as const;

export type SkillPackageCode = typeof SKILL_PACKAGE_CODES[number];

export type SkillEntryKind = "file" | "dir" | "symlink" | "hardlink" | "device" | "other";

export interface SkillEntry {
  path: string;
  size: number;
  kind: SkillEntryKind;
}

export interface SkillPackageLimits {
  maxFileBytes: number;
  maxPackageBytes: number;
  maxFiles: number;
  maxDepth: number;
  maxPathBytes: number;
}

export interface SkillPackageIssue {
  code: SkillPackageCode;
  path?: string;
  message: string;
}

export interface SkillPackageReport {
  ok: boolean;
  /** Stripped top-level dir ("" when none was stripped); null when no root could be published. */
  root: string | null;
  name: string | null;
  description: string | null;
  /** Every frontmatter key other than name/description, verbatim. Grants nothing. */
  metadata: Record<string, unknown>;
  errors: SkillPackageIssue[];
  warnings: SkillPackageIssue[];
}

export const DEFAULT_FRONTMATTER_MAX_BYTES = 16 * 1024;
/** Cap on nodes visited by the server's post-parse walk (bounds YAML alias fan-out). */
export const MAX_FRONTMATTER_NODES = 10_000;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;

export const DEFAULT_SKILL_PACKAGE_LIMITS: Readonly<SkillPackageLimits> = Object.freeze({
  maxFileBytes: 1024 * 1024,
  maxPackageBytes: 10 * 1024 * 1024,
  maxFiles: 200,
  maxDepth: 8,
  maxPathBytes: 255,
});

/**
 * Canonical (storage-comparable) form of an entry path: NFC, case-folded (lowercase), `/`
 * separators untouched. Percent sequences are NOT decoded.
 */
export function canonicalSkillPath(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export type FrontmatterExtract = { raw: string } | {
  error: "frontmatter_missing" | "frontmatter_unterminated" | "frontmatter_too_large";
};

/** Pull the leading `---\n…\n---` block out of decoded SKILL.md text. */
export function extractSkillFrontmatter(
  skillMdText: string,
  opts: { maxBytes?: number } = {},
): FrontmatterExtract {
  const maxBytes = opts.maxBytes ?? DEFAULT_FRONTMATTER_MAX_BYTES;
  const text = skillMdText.charCodeAt(0) === 0xfeff ? skillMdText.slice(1) : skillMdText;
  const lines = text.split("\n");
  if (lines[0].replace(/\r$/, "") !== "---") return { error: "frontmatter_missing" };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, "") === "---") {
      const raw = lines.slice(1, i).join("\n").replace(/\r$/, "");
      if (new TextEncoder().encode(raw).length > maxBytes) {
        return { error: "frontmatter_too_large" };
      }
      return { raw };
    }
    // bail early on oversize unterminated input too
  }
  // Unterminated: oversize is the more useful diagnosis when the tail already blows the cap.
  const rest = lines.slice(1).join("\n");
  if (new TextEncoder().encode(rest).length > maxBytes) return { error: "frontmatter_too_large" };
  return { error: "frontmatter_unterminated" };
}

/** STUB (S1): returns an empty report; rules land in later slices. */
export function validateSkillPackage(
  _input: { entries: SkillEntry[]; frontmatter: unknown; limits?: SkillPackageLimits },
): SkillPackageReport {
  return {
    ok: true,
    root: null,
    name: null,
    description: null,
    metadata: {},
    errors: [],
    warnings: [],
  };
}
