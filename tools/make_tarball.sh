#!/usr/bin/env bash
# Build the release tarball for clean-copy-cli.
# Output: clean-copy-<version>.tar.gz containing exactly what an end user needs:
#   clean-copy.js, clean_copy_core.js, package.json, README.md, LICENSE
# Verifies the result runs standalone before declaring success.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
OUT="clean-copy-${VERSION}.tar.gz"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

for f in clean-copy.js clean_copy_core.js package.json README.md LICENSE; do
  [ -f "$f" ] || { echo "MISSING: $f" >&2; exit 1; }
  cp "$f" "$STAGE/"
done

tar -czf "$OUT" -C "$STAGE" .

# Self-check 1: extract somewhere fresh and run it
CHECK=$(mktemp -d)
trap 'rm -rf "$STAGE" "$CHECK"' EXIT
tar -xzf "$OUT" -C "$CHECK"
RESULT=$(printf '<h1>Self</h1><p>Some <b>bold</b> text</p>' | node "$CHECK/clean-copy.js" -q)
echo "$RESULT" | grep -q 'Some \*\*bold\*\* text' || {
  echo "SELF-CHECK FAILED: tarball output was:" >&2; echo "$RESULT" >&2; exit 1; }

# Self-check 2: version inside matches package.json
GV=$(node -p "require('$CHECK/package.json').version")
[ "$GV" = "$VERSION" ] || { echo "SELF-CHECK FAILED: version mismatch $GV != $VERSION" >&2; exit 1; }

SHA=$(shasum -a 256 "$OUT" | awk '{print $1}')
echo "OK: $OUT ($SHA)"
