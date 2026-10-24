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
- Paths are compared in NFC and case-folded. Percent-sequences are literal names, never decoded.
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
| `path_too_long`                   | More than `maxPathBytes` bytes                                                            |
| `path_duplicate`                  | Collision after NFC and case-fold; reported on every member                               |
| `credential_path`                 | Credential-looking path (see above)                                                       |
| `entry_symlink`                   | Symlink entry                                                                             |
| `entry_hardlink`                  | Hardlink entry                                                                            |
| `entry_device`                    | Device entry                                                                              |
| `entry_other`                     | Any other non-file, non-dir kind                                                          |
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
