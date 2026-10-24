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

// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const WINDOWS_DRIVE = /^[A-Za-z]:/;
const CREDENTIAL_EXACT = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".env",
]);
const CREDENTIAL_KEYS = /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/;
const CREDENTIAL_EXT = /\.(pem|key|p12|pfx)$/;

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) i++;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/** Credential-bearing path segment, matched on the canonical (NFC, case-folded) form. */
function isCredentialSegment(segment: string): boolean {
  // Trailing dots/spaces are ignored by some filesystems (`.env.`, `.git `), so ignore them too.
  const c = canonicalSkillPath(segment).replace(/[ .]+$/, "");
  return CREDENTIAL_EXACT.has(c) || c.startsWith(".env.") || CREDENTIAL_KEYS.test(c) ||
    CREDENTIAL_EXT.test(c);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Extensions treated as scripts: accepted, never run, flagged `inert_script`. */
const SCRIPT_EXT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd)$/;
const NAME_GRAMMAR = /^[a-z0-9-]+$/;
/** Nesting deeper than this is refused by the node walk (bounds recursion). */
const MAX_FRONTMATTER_DEPTH = 100;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Count nodes the way a JSON copy would visit them: every reference visit counts, so YAML alias
 * fan-out (shared subtrees) is charged in full. A reference to one of its own ancestors is a
 * cycle. Only arrays and plain objects are descended into; anything else is a leaf.
 */
function walkFrontmatter(root: unknown): "ok" | "too_many" | "cyclic" {
  let count = 0;
  const ancestors = new Set<unknown>();
  const visit = (v: unknown, depth: number): "ok" | "too_many" | "cyclic" => {
    if (++count > MAX_FRONTMATTER_NODES) return "too_many";
    if (!Array.isArray(v) && !isPlainObject(v)) return "ok";
    if (ancestors.has(v)) return "cyclic";
    if (depth > MAX_FRONTMATTER_DEPTH) return "too_many";
    ancestors.add(v);
    const kids = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
    for (const k of kids) {
      const r = visit(k, depth + 1);
      if (r !== "ok") return r;
    }
    ancestors.delete(v);
    return "ok";
  };
  return visit(root, 0);
}

/**
 * Judge an entry list (and, from S3, the server-parsed frontmatter). Pure and deterministic:
 * entries are sorted internally and issues are emitted in (path, code, message) order, so input
 * order never changes the report. `root` is published only when there are no errors.
 */
export function validateSkillPackage(
  input: { entries: SkillEntry[]; frontmatter: unknown; limits?: SkillPackageLimits },
): SkillPackageReport {
  const limits = input.limits ?? DEFAULT_SKILL_PACKAGE_LIMITS;
  const errors: SkillPackageIssue[] = [];
  const warnings: SkillPackageIssue[] = [];
  const err = (code: SkillPackageCode, message: string, path?: string) =>
    errors.push(path === undefined ? { code, message } : { code, path, message });
  const warn = (code: SkillPackageCode, message: string, path?: string) =>
    warnings.push(path === undefined ? { code, message } : { code, path, message });

  const entries = [...input.entries].sort((a, b) =>
    cmp(a.path, b.path) || cmp(a.kind, b.kind) || a.size - b.size
  );
  if (entries.length === 0) err("no_entries", "package has no entries");

  // Pass 1: split each entry (NFC) and decide the single wrapper dir to strip.
  const parsed = entries.map((e) => {
    const norm = e.path.normalize("NFC");
    const body = e.kind === "dir" && norm.endsWith("/") ? norm.slice(0, -1) : norm;
    return { e, segs: body.split("/") };
  });
  const tops = new Set<string>();
  let topLevelFile = false;
  for (const { e, segs } of parsed) {
    if (segs.length === 1 && e.kind !== "dir") topLevelFile = true;
    tops.add(segs[0]);
  }
  const wrapper = !topLevelFile && tops.size === 1 ? [...tops][0] : "";
  const strip = wrapper !== "" && wrapper !== "." && wrapper !== ".." && wrapper !== "SKILL.md";

  // Pass 2: per-entry rules.
  const seen = new Map<string, string[]>();
  let files = 0;
  let total = 0;
  let skillMd = false;
  for (const { e, segs } of parsed) {
    const p = e.path;
    if (e.kind === "symlink") err("entry_symlink", "symlinks are not allowed", p);
    else if (e.kind === "hardlink") err("entry_hardlink", "hardlinks are not allowed", p);
    else if (e.kind === "device") err("entry_device", "device entries are not allowed", p);
    else if (e.kind === "other") err("entry_other", "unsupported entry type", p);

    if (e.kind === "file") {
      files++;
      if (SCRIPT_EXT.test(e.path.normalize("NFC").toLowerCase())) {
        warn("inert_script", "script files are stored as inert data and never executed", p);
      }
      if (!Number.isFinite(e.size) || e.size < 0) {
        err("file_too_large", "invalid file size", p);
      } else {
        total += e.size;
        if (e.size > limits.maxFileBytes) {
          err("file_too_large", `file exceeds ${limits.maxFileBytes} bytes`, p);
        }
      }
    }

    const raw = e.path;
    if (raw.startsWith("/") || raw.startsWith("\\") || WINDOWS_DRIVE.test(raw)) {
      err("path_absolute", "absolute paths are not allowed", p);
      continue;
    }
    let bad = false;
    if (hasLoneSurrogate(raw)) {
      err("path_invalid_text", "path contains invalid surrogate text", p);
      bad = true;
    }
    if (raw.includes("\\")) {
      err("path_backslash", "backslash separators are not allowed", p);
      bad = true;
    }
    if (CONTROL_CHARS.test(raw)) {
      err("path_control_char", "path contains control characters", p);
      bad = true;
    }
    if (segs.some((s) => s === "")) {
      err("path_empty_segment", "path has an empty segment", p);
      bad = true;
    }
    if (segs.some((s) => s === ".." || s === ".")) {
      err("path_traversal", "path contains a dot segment", p);
      bad = true;
    }
    if (segs.some(isCredentialSegment)) {
      err("credential_path", "credential-bearing paths are not allowed", p);
      bad = true;
    }

    const rel = strip ? segs.slice(1) : segs;
    if (rel.length === 0) continue; // the stripped wrapper dir itself
    if (e.kind === "file" && rel.length === 1 && rel[0] === "SKILL.md") skillMd = true;
    if (bad) continue;
    if (rel.length > limits.maxDepth) {
      err("path_too_deep", `path deeper than ${limits.maxDepth} segments`, p);
    }
    if (new TextEncoder().encode(rel.join("/")).length > limits.maxPathBytes) {
      err("path_too_long", `path longer than ${limits.maxPathBytes} bytes`, p);
    }
    const key = canonicalSkillPath(rel.join("/"));
    const group = seen.get(key);
    if (group) group.push(p);
    else seen.set(key, [p]);
  }

  for (const paths of seen.values()) {
    if (paths.length > 1) {
      for (const p of paths) {
        err("path_duplicate", "path collides after Unicode normalization and case folding", p);
      }
    }
  }
  if (files > limits.maxFiles) err("too_many_files", `more than ${limits.maxFiles} files`);
  if (total > limits.maxPackageBytes) {
    err("package_too_large", `package exceeds ${limits.maxPackageBytes} bytes`);
  }
  if (entries.length > 0 && !skillMd) {
    err("skill_md_missing", "SKILL.md must exist at the package root (exact case)");
  }

  // Frontmatter (the value the server parsed). Always judged, so errors accumulate.
  let name: string | null = null;
  let description: string | null = null;
  const metadata: Record<string, unknown> = {};
  const fm = input.frontmatter;
  const SKILL = "SKILL.md";
  if (fm === undefined || fm === null) {
    err("frontmatter_missing", "SKILL.md has no frontmatter", SKILL);
  } else if (!isPlainObject(fm)) {
    err("frontmatter_not_object", "frontmatter must be a plain mapping", SKILL);
  } else {
    const walk = walkFrontmatter(fm);
    if (walk === "too_many") {
      err(
        "frontmatter_too_many_nodes",
        `frontmatter exceeds ${MAX_FRONTMATTER_NODES} nodes or ${MAX_FRONTMATTER_DEPTH} levels`,
        SKILL,
      );
    } else if (walk === "cyclic") {
      err("frontmatter_not_object", "frontmatter contains a cyclic reference", SKILL);
    } else {
      const n = fm.name;
      if (
        typeof n !== "string" || n.length < 1 || n.length > SKILL_NAME_MAX || !NAME_GRAMMAR.test(n)
      ) {
        err(
          "frontmatter_name_invalid",
          `name must be a string of 1-${SKILL_NAME_MAX} characters from [a-z0-9-]`,
          SKILL,
        );
      } else name = n;
      const d = fm.description;
      if (typeof d !== "string" || d.trim() === "" || [...d].length > SKILL_DESCRIPTION_MAX) {
        err(
          "frontmatter_description_invalid",
          `description must be a non-empty string of at most ${SKILL_DESCRIPTION_MAX} characters`,
          SKILL,
        );
      } else description = d;
      for (const key of Object.keys(fm)) {
        if (key === "name" || key === "description") continue;
        // defineProperty: a literal `__proto__` key must stay an own data property.
        Object.defineProperty(metadata, key, {
          value: fm[key],
          enumerable: true,
          writable: true,
          configurable: true,
        });
        warn(
          "inert_field",
          `frontmatter key "${key}" is preserved as metadata and grants nothing`,
          SKILL,
        );
      }
    }
  }

  const order = (a: SkillPackageIssue, b: SkillPackageIssue) =>
    cmp(a.path ?? "", b.path ?? "") || cmp(a.code, b.code) || cmp(a.message, b.message);
  errors.sort(order);
  warnings.sort(order);
  return {
    ok: errors.length === 0,
    root: errors.length === 0 ? (strip ? wrapper : "") : null,
    name,
    description,
    metadata,
    errors,
    warnings,
  };
}
