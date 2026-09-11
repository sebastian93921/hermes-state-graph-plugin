#!/usr/bin/env sh
# Install the Hermes State Graph plugin into $HERMES_HOME (default ~/.hermes).
#
#   ./install.sh              install (or update) both halves
#   ./install.sh --no-enable  copy files only; don't run `hermes plugins enable`
#   ./install.sh --uninstall  remove the files this script installed
#
# Idempotent: re-run it after `git pull` to update an existing install.
set -eu

SRC=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

DESKTOP_DIR="$HERMES_HOME/desktop-plugins/state-graph"
AGENT_DIR="$HERMES_HOME/plugins/state-graph"
SKILL_DIR="$HERMES_HOME/skills/state-graph-directives"

MODE=install

for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE=uninstall ;;
    --no-enable) MODE=no-enable ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '%s\n' "$*"; }

if [ "$MODE" = uninstall ]; then
  rm -rf "$DESKTOP_DIR" "$AGENT_DIR" "$SKILL_DIR"
  say "removed:"
  say "  $DESKTOP_DIR"
  say "  $AGENT_DIR"
  say "  $SKILL_DIR"
  say
  say "If you enabled the agent half, drop it from \$HERMES_HOME/config.yaml too:"
  say "  plugins:"
  say "    enabled: [ ... ]        # remove 'state-graph'"
  exit 0
fi

if [ ! -f "$SRC/desktop/state-graph/plugin.js" ]; then
  say "cannot find desktop/state-graph/plugin.js next to this script — run install.sh from the repo root." >&2
  exit 1
fi

say "installing into $HERMES_HOME"

mkdir -p "$DESKTOP_DIR" "$AGENT_DIR" "$SKILL_DIR"

# desktop half: the pane, the status-bar chip, the transcript directives, the palette commands
cp "$SRC/desktop/state-graph/plugin.js" "$DESKTOP_DIR/plugin.js"

# agent half: the state_graph_note tool + the two gate hooks
cp "$SRC/agent/state-graph/plugin.py" "$AGENT_DIR/plugin.py"
cp "$SRC/agent/state-graph/plugin.yaml" "$AGENT_DIR/plugin.yaml"
cp "$SRC/agent/state-graph/__init__.py" "$AGENT_DIR/__init__.py"

# guidance so the agent declares tasks without being told every time
cp "$SRC/skill/SKILL.md" "$SKILL_DIR/SKILL.md"

# a stale bytecode cache can shadow an updated plugin.py
rm -rf "$AGENT_DIR/__pycache__"

say "  $DESKTOP_DIR/plugin.js"
say "  $AGENT_DIR/{plugin.py,plugin.yaml,__init__.py}"
say "  $SKILL_DIR/SKILL.md"

if [ "$MODE" = no-enable ]; then
  say
  say "Next: hermes plugins enable state-graph"
  exit 0
fi

if command -v hermes >/dev/null 2>&1; then
  hermes plugins enable state-graph >/dev/null 2>&1 || true
  if hermes plugins doctor "$AGENT_DIR" --ci 2>&1 | grep -q "OK: runtime discovery"; then
    say
    say "agent half: registered"
  else
    say
    say "agent half: could not verify — run this to see why:"
    say "  hermes plugins doctor $AGENT_DIR --ci"
  fi
else
  say
  say "'hermes' is not on PATH in this shell; enable the agent half with:"
  say "  hermes plugins enable state-graph"
fi

say
say "Finish:"
say "  1. Restart the gateway in the app  (⌘K -> Restart gateway)"
say "  2. Open a NEW chat — a session created before the plugin was enabled never"
say "     gets the state_graph_note tool."
say "The pane itself needs no restart: the app hot-loads it within a few seconds."
