#!/bin/sh
# Sparrow SessionStart hook (Codex).
#
# Codex has no per-turn system channel, so the come-online protocol has to be
# INJECTED at the top of a session or it is never read. A SessionStart hook that
# prints {"hookSpecificOutput":{"hookEventName":"SessionStart",
# "additionalContext":"..."}} on stdout has that text placed into the session's
# context (live-verified on codex-cli 0.153.3).
#
# It says only what the agent cannot work out for itself: which state dir is in
# play, whether a listener is alive right now, and the ONE command to run when
# none is. Everything else is in SKILL.md, which this points at.
#
# Contract: honors the loop switch (absent/paused = print nothing at all), never
# fails a session — every error path exits 0 with no output.
set -u

STATE_DIR="${SPARROW_STATE_DIR:-$HOME/.sparrow}"
LOOP_STATE_FILE="$STATE_DIR/loop-state"
HEARTBEAT_FILE="$STATE_DIR/heartbeat"
FRESH_SECONDS="${SPARROW_HEARTBEAT_MAX_AGE:-120}"
# Baked at install time: Codex hook payloads carry no project-dir variable.
SKILL_PATH="${SPARROW_SKILL_PATH:-.agents/skills/sparrow/SKILL.md}"

cat >/dev/null 2>&1 || true

[ -f "$LOOP_STATE_FILE" ] || exit 0
state=$(tr -d ' \t\r\n' < "$LOOP_STATE_FILE" 2>/dev/null || echo "")
[ "$state" = "engaged" ] || exit 0

# What is listening right now? Same vocabulary as the Stop hook: a fresh `await`
# is the only state that needs no action.
listener="none"
if [ -f "$HEARTBEAT_FILE" ]; then
  content=$(head -c 64 "$HEARTBEAT_FILE" 2>/dev/null | tr -d ' \t\r\n' || echo "")
  case "$content" in
    killed | killed:*) listener="killed" ;;
    stopped | stopped:*) listener="stopped" ;;
    *)
      now=$(date +%s 2>/dev/null || echo 0)
      hb=$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || echo "")
      if [ -n "$hb" ] && [ "$now" -gt 0 ] 2>/dev/null; then
        age=$((now - hb))
        if [ "$age" -ge 0 ] && [ "$age" -lt "$FRESH_SECONDS" ] 2>/dev/null; then
          case "$content" in
            await | watch | loop) listener="$content" ;;
            *) listener="unknown" ;;
          esac
        fi
      fi
      ;;
  esac
fi

case "$listener" in
  await) advice="A wake-capable sparrow await is already running - leave it alone, and re-arm it the moment it exits." ;;
  watch | loop) advice="A sparrow $listener listener is holding you online but CANNOT wake you: if you are turn-based, replace it with sparrow await --timeout 900 as a background task." ;;
  unknown) advice="Something is heartbeating but claims no listener kind, so it cannot be judged: if you did not arm a wake path yourself, run sparrow await --timeout 900 as a background task." ;;
  killed | stopped) advice="Your listener was $listener - nothing can wake you. Run sparrow await --timeout 900 as a background task before anything else." ;;
  *) advice="No listener is running. Run sparrow await --timeout 900 as a background task before anything else." ;;
esac

# Hand-rolled JSON: keep the payload free of double quotes, backslashes and
# newlines so it stays valid without an escaper.
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Sparrow: this workspace is Sparrow-enabled and your loop switch is engaged (state dir %s). Read the sparrow skill at %s (invoke it with $sparrow) before you touch the inbox. %s Then drain with sparrow pop until it answers Inbox empty., reply in-room, and re-arm await as the LAST thing you do in every turn. Never pipe sparrow output through jq or grep. To step away on purpose: sparrow skill pause."}}\n' \
  "$STATE_DIR" "$SKILL_PATH" "$advice"
exit 0
