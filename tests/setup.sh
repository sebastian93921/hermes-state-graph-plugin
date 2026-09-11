#!/usr/bin/env sh
# Wire up the offline test suite: npm deps + the SDK stub, then copy the plugin
# under test into place.
#
#   ./setup.sh            use the installed plugin ($HERMES_HOME/desktop-plugins/state-graph/plugin.js)
#   ./setup.sh <path.js>  test a specific build
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
PLUGIN="${1:-$HERMES_HOME/desktop-plugins/state-graph/plugin.js}"

cd "$HERE"

if [ ! -f "$PLUGIN" ]; then
  echo "no plugin at $PLUGIN" >&2
  echo "install it first (../install.sh) or pass a path: ./setup.sh /path/to/plugin.js" >&2
  exit 1
fi

if command -v npm >/dev/null 2>&1; then
  echo "installing test deps (react, react-dom, nanostores, jsdom)…"
  npm install --no-audit --no-fund --silent
else
  echo "npm not found — install react react-dom nanostores @nanostores/react jsdom into ./node_modules yourself" >&2
fi

# The app resolves `@hermes/plugin-sdk` inside its own build; here the stub stands
# in for it. It mirrors the real contract: real nanostores atoms, real
# @nanostores/react useStore, light stubs for the UI kit.
mkdir -p node_modules/@hermes
rm -rf node_modules/@hermes/plugin-sdk
ln -s ../../sdk-stub/@hermes/plugin-sdk node_modules/@hermes/plugin-sdk

cp "$PLUGIN" ./plugin.js
echo "plugin under test: $PLUGIN"
echo "now run: node run.mjs"
