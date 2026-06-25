# Conformance fixtures

Black-box tests that any spec-compliant host can run against its own validator
to claim compliance with `manifestVersion: "1"`. Drop-in JSON files; no Deno
or TypeScript dependency.

## Layout

```
fixtures/
├── valid/
│   ├── <kind>/<name>.json    # MUST validate clean
│   └── …
└── invalid/
    ├── <kind>/<name>.json    # MUST fail validation
    └── _expected.json        # path → expected-error-substring (the rule each fixture violates)
```

`<kind>` is one of: `app`, `action`, `auth`.

## Usage

The reference suite in `validator/tests/fixtures.test.ts` walks these directories
and runs `validate{App,Action,Auth}` against each. A third-party host that
implements the spec can run the same walk against its own validator — the JSON
is the contract.

When adding a fixture:

- **`valid/`** — the file should be a minimal, focused example of one feature
  (auth methods, optional fields, edge cases). No `_expected.json` is needed.
- **`invalid/`** — add an entry to `invalid/_expected.json` keyed by the path
  relative to `fixtures/` (e.g. `"invalid/app/missing-id.json"`), with a value
  that is a substring expected to appear in at least one error's `path` field.
  This makes the "why is this invalid" intent reviewable in code review.
