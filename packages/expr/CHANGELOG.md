# Changelog

All notable changes to `@w6w/expr` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.1]

### Added

- `matchesParamCondition`, `effectiveParam`, `PARAM_OVERLAY_KEYS` and the `ParamCondition` /
  `ParamOverlay` / `ParamWhen` types: the shared evaluator and overlay for `Param.when`.
- `parseTemplate(input, mode, escape?)` takes an opt-in `TemplateEscape`: with it, `\{{` is read as
  a literal `{{` instead of opening a marker. `TemplateEscape` is exported.

## [0.1.0]

First npm release.

### Added

- Built ESM output with `.d.ts` declarations in `dist/`, published to npm (`npm install @w6w/expr`).
- `w6w-source` export condition resolving to `./mod.ts`, for in-repo tools only.

### Changed

- `package.json` `exports`/`types` now point at `dist/`; the tarball ships `dist`, `LICENSE`,
  `README.md` and `CHANGELOG.md` instead of raw TypeScript sources.
- `deno.json` now declares `"license": "MIT"` (the licence itself is unchanged).
