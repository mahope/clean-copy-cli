#!/bin/sh
# clean-copy installer — installs to ~/.local/bin
# Usage: curl -fsSL https://raw.githubusercontent.com/mahope/clean-copy-cli/main/tools/install.sh | bash
set -e

VERSION="v1.5.2"
PREFIX="${HOME}/.local"
BIN_DIR="$PREFIX/bin"

command -v node >/dev/null 2>&1 || {
  echo "error: Node.js 16+ is required (https://nodejs.org)" >&2
  exit 1
}

mkdir -p "$BIN_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="https://github.com/mahope/clean-copy-cli/releases/download/${VERSION}/clean-copy-${VERSION#v}.tar.gz"
echo "Downloading clean-copy ${VERSION}..."
curl -fsSL "$URL" | tar -xz -C "$TMP"

install -m 0755 "$TMP/clean-copy.js" "$BIN_DIR/clean-copy" 2>/dev/null ||
  cp "$TMP/clean-copy.js" "$BIN_DIR/clean-copy" && chmod 0755 "$BIN_DIR/clean-copy"
cp "$TMP/clean_copy_core.js" "$TMP/package.json" "$BIN_DIR/"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "note: add $BIN_DIR to your PATH (e.g. add 'export PATH=\"\$HOME/.local/bin:\$PATH\"' to your shell profile)";;
esac

echo "Installed. Try it:"
echo "  printf '<h1>Hi</h1>' | $BIN_DIR/clean-copy -q"
