#!/usr/bin/env bash
# Pack @w6w/expr and prove the tarball works for a plain-Node consumer (ESM + require).
# Never writes into the checkout beyond the prepack build (dist/, gitignored).
set -euo pipefail

fatal() { echo "PACK-SMOKE FAIL: $*" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$HERE"
mkdir "$TMP/pack" "$TMP/consumer"
# prepack runs the build, so dist/ is always present in the tarball.
TGZ="$(npm pack --silent --pack-destination "$TMP/pack" | tail -n1)"
[ -f "$TMP/pack/$TGZ" ] || fatal "npm pack produced no tarball"

EXPECT="CHANGELOG.md
LICENSE
README.md
dist/mod.d.ts
dist/mod.js
dist/src/jsonlogic.d.ts
dist/src/jsonlogic.js
dist/src/param-when.d.ts
dist/src/param-when.js
dist/src/template.d.ts
dist/src/template.js
package.json"
GOT="$(tar -tzf "$TMP/pack/$TGZ" | sed 's#^package/##' | grep -v '/$' | LC_ALL=C sort)"
[ "$GOT" = "$(printf '%s\n' "$EXPECT" | LC_ALL=C sort)" ] || fatal "tarball file set differs:
$GOT"

tar -xzf "$TMP/pack/$TGZ" -C "$TMP/pack"
[ "$(node -p "require('$TMP/pack/package/package.json').license")" = "MIT" ] || fatal "packed license is not MIT"
head -n1 "$TMP/pack/package/LICENSE" | grep -q '^MIT License' || fatal "LICENSE does not begin 'MIT License'"

cd "$TMP/consumer"
echo '{"name":"smoke","version":"0.0.0","private":true}' > package.json
npm install --silent --no-audit --no-fund "$TMP/pack/$TGZ" >/dev/null

cat > check.mjs <<'J'
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const esm = await import("@w6w/expr");
const cjs = createRequire(import.meta.url)("@w6w/expr");
assert.equal(esm.evaluate({ "==": [{ var: "a" }, 1] }, { a: 1 }), true);
const parts = esm.parseRenderTemplate("Hi {{ vars.n }}");
assert.equal(parts.length, 2);
assert.equal(parts[0].kind, "text");
assert.equal(parts[1].kind, "var");
assert.equal(parts[1].ref, "vars.n");
assert.equal(cjs.evaluate({ "==": [{ var: "a" }, 1] }, { a: 1 }), true);
assert.ok(cjs.ExprError === esm.ExprError, "ExprError identity differs between require and import");
console.log("esm ok", true, "cjs ok");
J
node check.mjs
echo "PACK-SMOKE OK"
