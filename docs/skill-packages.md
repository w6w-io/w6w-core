# Skill packages

A skill package is a directory (usually uploaded as a ZIP) containing a `SKILL.md` and supporting
files. `@w6w/types` exports a pure validator, `validateSkillPackage`, which judges the entry list
and the already-parsed frontmatter. It does no I/O, no ZIP reading and no YAML parsing: the caller
supplies `entries` (`{path, size, kind}`) and the frontmatter value. `extractSkillFrontmatter` pulls
the raw `---` block out of the `SKILL.md` text for the caller to parse.

Skills are stored and listed only. Nothing in a package is ever executed, and no frontmatter key
grants anything.

## Format

- `SKILL.md` must exist at the package root, matched exactly (case-sensitive), as a file.
- If every entry shares one top-level directory and there is no top-level `SKILL.md`, that directory
  is stripped once. The stripped root is reported.
- `SKILL.md` starts with a `---` ... `---` frontmatter block (a BOM is stripped, CRLF accepted).
- Frontmatter is a plain object with `name` (1-64 chars, `[a-z0-9-]`) and a non-empty `description`
  (at most 1024 characters). Every other key is kept verbatim as `metadata`.
- Paths are compared by one shared key, `canonicalSkillPath`: NFC, `toLowerCase()`, NFC again. This
  is `toLowerCase`, not full Unicode case folding (for example `ß` and `SS` do not collide), so any
  other component that keys on paths must import this function rather than reimplement it.
  Percent-sequences are literal names, never decoded.
- **Work is bounded before any normalization.** `String.prototype.normalize` is quadratic on a long
  run of mixed-class combining marks (one 65 KB name costs about 0.8 s), so `canonicalSkillPath` is
  O(n²) in the worst case and does **not** bound its input. Callers must cap the length of the
  string first (for example a storage `path_key` builder rejects anything over `maxPathBytes` before
  calling it). `validateSkillPackage` does this itself: an entry whose raw path is longer than
  `rawPathUnitCap(maxPathBytes)` = `4 * maxPathBytes + 1` UTF-16 units is reported `path_too_long`
  and is never normalized, case-folded or keyed. NFC shrinks at most 1.5 units per byte, so a path
  whose wrapper dir and remaining path are each within `maxPathBytes` NFC bytes is never
  over-rejected. The same cap bounds the wrapper dir: the wrapper is part of the raw path. A missing
  or NaN `maxPathBytes` still uses the default's cap for this gate.
- **Entry count is the caller's cap.** The validator checks `maxFiles` only after visiting every
  entry, so the caller (the ZIP reader) must stop reading the central directory at its own entry
  count limit before building the list.
- Scripts (`.sh`, `.py`, `.js` and similar) are accepted as inert files.

## Default limits

| Limit                                       | Default |
| ------------------------------------------- | ------- |
| `maxFileBytes`                              | 1 MiB   |
| `maxPackageBytes`                           | 10 MiB  |
| `maxFiles`                                  | 200     |
| `maxDepth`                                  | 8       |
| `maxPathBytes`                              | 255     |
| frontmatter bytes                           | 16 KiB  |
| frontmatter nodes (`MAX_FRONTMATTER_NODES`) | 10000   |

Exactly at a limit passes; one over fails.

## Credential paths

Rejected by canonical path segment: `.env`, `.env.*`, `.git`, `.ssh`, `.aws`, `.npmrc`, `.pypirc`,
`.netrc`, `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519` (and `.pub`), `*.pem`, `*.key`, `*.p12`,
`*.pfx`. Case does not matter.

## Codes

Errors unless marked warning. A report is `ok` only with no errors, and publishes `root` only then.

| Code                              | Meaning                                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------------- |
| `path_absolute`                   | Absolute path (`/x`, `C:\x`, `\\host`)                                                    |
| `path_traversal`                  | `..` (or `.`) segment                                                                     |
| `path_backslash`                  | Backslash separator                                                                       |
| `path_control_char`               | NUL, control, bidi or line-separator character                                            |
| `path_invalid_text`               | Invalid surrogate text                                                                    |
| `path_not_nfc`                    | Reserved, never emitted: NFD paths are normalized to NFC and only collisions are rejected |
| `path_empty_segment`              | Empty segment (`a//b`)                                                                    |
| `path_too_deep`                   | Deeper than `maxDepth`                                                                    |
| `path_too_long`                   | More than `maxPathBytes` bytes, or over `rawPathUnitCap` raw units                        |
| `path_duplicate`                  | Collision on `canonicalSkillPath` (NFC + `toLowerCase`); reported on every member         |
| `credential_path`                 | Credential-looking path (see above)                                                       |
| `entry_symlink`                   | Symlink entry                                                                             |
| `entry_hardlink`                  | Hardlink entry                                                                            |
| `entry_device`                    | Device entry                                                                              |
| `entry_other`                     | Any kind outside the `SkillEntryKind` union (fails closed)                                |
| `file_too_large`                  | File over `maxFileBytes` (or invalid size)                                                |
| `package_too_large`               | Aggregate over `maxPackageBytes`                                                          |
| `too_many_files`                  | More than `maxFiles` files                                                                |
| `skill_md_missing`                | No `SKILL.md` at the root                                                                 |
| `no_entries`                      | Empty entry list                                                                          |
| `frontmatter_missing`             | No frontmatter block or value                                                             |
| `frontmatter_unterminated`        | Opening `---` without a closing one                                                       |
| `frontmatter_too_large`           | Block over the byte limit                                                                 |
| `frontmatter_too_many_nodes`      | Walk exceeded `MAX_FRONTMATTER_NODES` (or nesting over 100)                               |
| `frontmatter_not_object`          | Not a plain object (array, primitive, class instance, cycle)                              |
| `frontmatter_name_invalid`        | `name` missing, not a string, or outside the grammar                                      |
| `frontmatter_description_invalid` | `description` empty or too long                                                           |
| `inert_field`                     | Warning: extra frontmatter key preserved in `metadata`, grants nothing                    |
| `inert_script`                    | Warning: script file accepted as inert data                                               |

## Interchangeability

This is the w6w skill-package format. Not every third-party format is interchangeable: a package
from another tool may be rejected (for example for credential paths or symlinks), and keys such as
`allowed-tools` are kept as inert metadata rather than honoured.

A missing, partial or `NaN` limit fails closed: the comparison is written so that it errors, with
the same per-limit codes (`file_too_large`, `too_many_files`, and so on).
