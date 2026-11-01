#!/usr/bin/env bash
# The ONE list of checks for w6w-core. CI runs exactly this file, and so does the pre-push hook
# (w6w-io/w6w .githooks/pre-push), so a push that passes here passes CI. Add a check HERE,
# never only in ci.yml. Needs deno, node 24, jq and network (npm, for the publish dry-run).
set -euo pipefail
cd "$(dirname "$0")/.."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 24 ]; then
  echo "verify: Node $(node --version) — CI runs Node 24; run w6w-io/w6w scripts/install-hooks.sh to fetch it" >&2
  exit 1
fi

step() { printf '\n== %s\n' "$*"; }

step "package.json and deno.json versions agree"
rc=0
for d in packages/*/; do
  [ -f "$d/package.json" ] && [ -f "$d/deno.json" ] || continue
  p=$(jq -r .version "$d/package.json")
  n=$(jq -r .version "$d/deno.json")
  if [ "$p" != "$n" ]; then echo "::error::$d package.json $p != deno.json $n"; rc=1; else echo "ok $d $p"; fi
done
[ "$rc" = 0 ]

step typecheck;    deno check packages/ scripts/
step lint;         deno lint packages/ scripts/
# fixtures/ is excluded on purpose: some fixtures are byte-exact inputs (built bundles, digests).
step "fmt --check"; deno fmt --check packages/ scripts/
step test;         deno task test

step "@w6w/expr: build, pack smoke, publish dry-run"
(
  cd packages/expr
  npm run build
  bash scripts/pack-smoke.sh
  VER="$(node -p "require('./package.json').version")"
  if npm view "@w6w/expr@$VER" version >/dev/null 2>&1; then
    echo "@w6w/expr@$VER is already on npm — dry-run publish skipped"
  else
    npm publish --dry-run
  fi
)
printf '\nverify: ok\n'
