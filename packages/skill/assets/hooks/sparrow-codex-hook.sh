#!/bin/sh
# Sparrow hook wrapper (Codex) — stamp that this event REALLY fired, then run it.
#
# WHY THIS EXISTS. Codex has two silent trust gates in front of a project's
# hooks: an untrusted project has its whole `.codex/` layer ignored, and a
# non-managed hooks.json additionally needs per-hook review (`/hooks` in the TUI,
# or `--dangerously-bypass-hook-trust` headless). Neither gate reports anything —
# no warning, no error, no log line. So the presence of `.codex/hooks.json` on
# disk proves NOTHING about whether a single hook will ever run, and a `status`
# that just checked for files would be lying with a green tick.
#
# Every hook we install therefore runs through here first and touches
# `<state dir>/hooks-fired/<Event>`. `sparrow skill verify` reads those stamps:
# an event with a stamp has been OBSERVED firing, and an event without one is
# reported UNVERIFIED. That is the only honest signal available.
#
# Usage: sparrow-codex-hook.sh <Event> <script> [args...]
# Contract: stdin, stdout and the exit status all belong to <script> (we `exec`
# into it, so the hook's decision channel is untouched). Every failure path here
# exits 0 with no output — a broken wrapper must never wedge a session.
set -u

event="${1:-}"
[ -n "$event" ] || exit 0
shift
script="${1:-}"
[ -n "$script" ] || exit 0
shift

# Keep the filename to a bare event word — this is derived from our own
# hooks.json, but a stray path separator must never escape the state dir.
event=$(printf '%s' "$event" | tr -cd 'A-Za-z0-9_-')
STATE_DIR="${SPARROW_STATE_DIR:-$HOME/.sparrow}"
FIRED_DIR="$STATE_DIR/hooks-fired"
if [ -n "$event" ]; then
  mkdir -p "$FIRED_DIR" 2>/dev/null || true
  : > "$FIRED_DIR/$event" 2>/dev/null || true
fi

[ -x "$script" ] || exit 0
exec "$script" "$@"
