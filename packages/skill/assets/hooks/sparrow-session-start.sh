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

# Read the heartbeat's two tokens: the stamp/kind, and the `await` GENERATION
# nonce a dead stamp may carry (`killed:SIGTERM 4f2c...`).
#
# WHY THE NONCE MATTERS: arming `sparrow await` supersedes the previous listener
# (newest wins, see the CLI's await-owner.ts), and the superseded process can
# still be killed minutes later. Its `killed:` stamp would then describe a
# corpse while a healthy successor is listening. So a tagged stamp counts only
# while it names the LIVE generation in <state dir>/await-owner.json; otherwise
# the heartbeat is treated as unjudgeable. An untagged stamp (watch/loop, or any
# older CLI) is judged exactly as before, as is a missing owner record.
sparrow_heartbeat_read() {
  sparrow_hb_raw=$(head -c 96 "$HEARTBEAT_FILE" 2>/dev/null | tr '\t\r\n' '   ' || echo "")
  sparrow_hb_word=$(printf '%s' "$sparrow_hb_raw" | sed -n 's/^ *\([^ ][^ ]*\).*$/\1/p')
  sparrow_hb_gen=$(printf '%s' "$sparrow_hb_raw" | sed -n 's/^ *[^ ][^ ]*  *\([A-Za-z0-9][A-Za-z0-9]*\).*$/\1/p')
  if [ -n "$sparrow_hb_gen" ]; then
    sparrow_live_gen=$(sed -n 's/.*"nonce"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9][A-Za-z0-9]*\)".*/\1/p' \
      "$STATE_DIR/await-owner.json" 2>/dev/null | head -n 1)
    if [ -n "$sparrow_live_gen" ] && [ "$sparrow_hb_gen" != "$sparrow_live_gen" ]; then
      sparrow_hb_word=""   # a superseded generation's stamp: no judgement
    fi
  fi
  printf '%s' "$sparrow_hb_word"
}

# What is listening right now? Same vocabulary as the Stop hook: only a fresh
# `await:codex` proves the CLI found this Codex thread's queue bridge.
listener="none"
if [ -f "$HEARTBEAT_FILE" ]; then
  content=$(sparrow_heartbeat_read)
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
            await | await:codex | watch | loop) listener="$content" ;;
            *) listener="unknown" ;;
          esac
        fi
      fi
      ;;
  esac
fi

# ONE PRESCRIPTION, TWO LANGUAGES. Several agents on one machine share ONE
# credentials.json, so a bare `sparrow await` in a fresh shell arms whichever
# neighbour owns defaultProfile. A project-scope install stamps SPARROW_PROFILE
# into this hook's command precisely so it knows which agent it speaks for. The
# rendering must match the CLI's `awaitCommand()`
# (packages/skill/src/listener.ts) exactly; listener.test.ts pins the pair.
sparrow_cmd() {
  if [ -n "${SPARROW_PROFILE:-}" ]; then
    printf 'sparrow %s --profile %s' "$1" "$SPARROW_PROFILE"
  else
    printf 'sparrow %s' "$1"
  fi
}
await_command=$(sparrow_cmd await)
pop_command=$(sparrow_cmd pop)

case "$listener" in
  await:codex) advice="A Codex-bridged await listener is present and can deliver the next turn." ;;
  await) advice="A passive await listener is present, but it has no verified route back into this Codex thread. Re-arm it with the current CLI: run unbounded $await_command as a background task." ;;
  watch | loop) advice="A sparrow $listener listener is holding you online but CANNOT wake you: if you are turn-based, replace it with unbounded $await_command as a background task." ;;
  unknown) advice="Something is heartbeating but claims no listener kind, so it cannot be judged: if you did not arm a wake path yourself, run unbounded $await_command as a background task." ;;
  killed | stopped) advice="Your listener was $listener - nothing can wake you. Run unbounded $await_command as a background task before anything else." ;;
  *) advice="No listener is running. Run unbounded $await_command as a background task before anything else." ;;
esac

advice="$advice Plain process exit alone does not start a Codex turn; current Sparrow detects CODEX_THREAD_ID and supplies the queue bridge automatically. Ordinary timeouts do not queue turns; a terminal client-upgrade response does."

# Hand-rolled JSON: keep the payload free of double quotes, backslashes and
# newlines so it stays valid without an escaper.
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Sparrow: this workspace is Sparrow-enabled and your loop switch is engaged (state dir %s). Read the sparrow skill at %s (invoke it with $sparrow) before you touch the inbox. %s Then drain with %s until it answers Inbox empty., reply in-room, and re-arm await as the LAST thing you do in every turn. Never pipe sparrow output through jq or grep. To step away on purpose: sparrow skill pause."}}\n' \
  "$STATE_DIR" "$SKILL_PATH" "$advice" "$pop_command"
exit 0
