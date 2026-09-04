#!/bin/sh
# Sparrow loop Stop-hook (Claude Code).
#
# Catches three failures, all of which end a turn with the agent unreachable:
#   1. DRIFT -- the loop is engaged but nothing has heartbeated recently (no
#      listener at all).
#   2. KILLED/STOPPED -- the listener stamped the heartbeat on its way out
#      (`killed:SIGTERM`, `killed:SIGHUP`, `stopped:SIGINT`). A Claude Code
#      session interrupt kills the tracked background `sparrow await`, and the
#      heartbeat it left behind stays FRESH for the whole window -- so this word
#      SKIPS the freshness check entirely and blocks immediately. (Three prod
#      sessions ended silently on exactly this, in one day.)
#   3. ONLINE-BUT-DEAF -- a listener IS alive, but it is `sparrow watch` or
#      `sparrow loop`: both hold the events stream open forever, so presence goes
#      green while nothing can ever re-enter a turn-based session. Only
#      `sparrow await` is a WAKE PATH -- it exits when work arrives, and that
#      exit is what gets a turn-based agent re-invoked.
# If the loop switch is absent or paused, stay silent.
#
# HOW IT TELLS THEM APART: every CLI listener writes its own kind (`await`,
# `watch`, `loop`) as the heartbeat file's content while stamping the mtime, and
# writes `killed:<signal>` / `stopped:<signal>` as it dies.
# `killed`/`stopped` (fresh or stale) -> block, naming the cause. Fresh +
# `await` -> allow. Fresh + `watch`/`loop` -> block with the hold-only reason.
# Stale/absent -> the drift block.
#
# BE HONEST ABOUT THE REMAINING SCOPE. An EMPTY heartbeat (an older CLI, or a
# hand-rolled curl loop that touches the file itself) claims no kind, and this
# hook does NOT guess: it allows the stop. So a wake path built outside the CLI
# is invisible to it, in both directions -- it can neither confirm nor deny one.
# Waking is ultimately the agent's HARNESS's job; this hook is a floor, not a
# substitute for a re-armed `sparrow await`.
#
# Contract (Stop hook): print {"decision":"block","reason":"..."} on stdout and
# exit 0 to block the stop; exit 0 with no output to allow it. This script NEVER
# hard-blocks and NEVER wedges a session — any error path exits 0 (allow).
set -u

STATE_DIR="${SPARROW_STATE_DIR:-$HOME/.sparrow}"
LOOP_STATE_FILE="$STATE_DIR/loop-state"
HEARTBEAT_FILE="$STATE_DIR/heartbeat"
FRESH_SECONDS="${SPARROW_HEARTBEAT_MAX_AGE:-120}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd || echo "")

# Allow the stop AND (since the turn is genuinely ending) hand off to the
# auto-status hook to advertise idle. auto-status self-guards on the loop switch
# and creds, so this is a safe no-op when the skill isn't fully set up. Its
# output is discarded so it can never pollute this Stop hook's decision channel.
allow_stop() {
  if [ -n "$SCRIPT_DIR" ] && [ -x "$SCRIPT_DIR/sparrow-auto-status.sh" ]; then
    "$SCRIPT_DIR/sparrow-auto-status.sh" stop >/dev/null 2>&1 || true
  fi
  exit 0
}

# Read the hook's stdin JSON (best-effort). Honor stop_hook_active so we never
# trap the agent in an infinite block loop.
input=$(cat 2>/dev/null || true)
case "$input" in
  *'"stop_hook_active":true'* | *'"stop_hook_active": true'*) allow_stop ;;
esac

# No loop switch, or paused → nothing to enforce.
[ -f "$LOOP_STATE_FILE" ] || allow_stop
state=$(tr -d ' \t\r\n' < "$LOOP_STATE_FILE" 2>/dev/null || echo "")
[ "$state" = "engaged" ] || allow_stop

# Fresh heartbeat → a listener is alive. WHICH one decides: `await` can wake this
# session, `watch`/`loop` can only hold it online, anything else is unjudgeable.
# `hold_kind` stays empty unless we found a hold-only listener, so the tail of
# this script builds the right reason for whichever failure we are in.
hold_kind=""
dead_word=""
dead_signal=""
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
now=$(date +%s 2>/dev/null || echo 0)
if [ -f "$HEARTBEAT_FILE" ]; then
  content=$(head -c 64 "$HEARTBEAT_FILE" 2>/dev/null | tr -d ' \t\r\n' || echo "")
  # A TERMINAL stamp is not subject to the freshness window: the listener told us
  # it is gone, and it is freshest exactly when it just died.
  case "$content" in
    killed | killed:*) dead_word="killed" ;;
    stopped | stopped:*) dead_word="stopped" ;;
  esac
  if [ -n "$dead_word" ]; then
    case "$content" in
      *:*) dead_signal=$(printf '%s' "${content#*:}" | tr -cd 'A-Za-z0-9_') ;;
    esac
  else
    hb=$(mtime "$HEARTBEAT_FILE")
    if [ -n "${hb:-}" ] && [ "$now" -gt 0 ] 2>/dev/null; then
      age=$((now - hb))
      if [ "$age" -ge 0 ] && [ "$age" -lt "$FRESH_SECONDS" ]; then
        case "$content" in
          watch | loop) hold_kind="$content" ;;
          # `await` (a real wake path) or empty/unknown (legacy or third-party
          # heartbeat -- we cannot judge, so we do not) → allow, as always.
          *) allow_stop ;;
        esac
      fi
    fi
  fi
fi

# Engaged, and either drifted or held online by a deaf listener. Best-effort
# unread count to enrich the nudge (never required; skip silently if we can't).
unread=""
count_unread() {
  server="${SPARROW_SERVER:-}"
  token="${SPARROW_TOKEN:-}"
  if [ -z "$server" ] || [ -z "$token" ]; then
    # Fall back to the credential store (needs node — optional): the profile
    # named by SPARROW_PROFILE if set (what a project-scope install stamps into
    # this hook's command), else defaultProfile.
    creds="${XDG_CONFIG_HOME:-$HOME/.config}/sparrow/credentials.json"
    if [ -r "$creds" ] && command -v node >/dev/null 2>&1; then
      pair=$(node -e '
        try {
          const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          const want = (process.env.SPARROW_PROFILE || "").trim();
          const profiles = c.profiles || {};
          // A profile named EXPLICITLY that is not there resolves to nothing --
          // falling back to the default would act as somebody else.
          if (want && !profiles[want]) process.exit(0);
          const p = profiles[want || c.defaultProfile];
          if (p && p.server && p.token) process.stdout.write(p.server + "\n" + p.token);
        } catch {}
      ' "$creds" 2>/dev/null || true)
      server=$(printf '%s' "$pair" | sed -n '1p')
      token=$(printf '%s' "$pair" | sed -n '2p')
    fi
  fi
  [ -n "$server" ] && [ -n "$token" ] && command -v curl >/dev/null 2>&1 || return 0
  server=$(printf '%s' "$server" | sed 's:/*$::')
  body=$(curl -fsS --max-time 5 "$server/api/v1/me/inbox" \
    -H "authorization: Bearer $token" 2>/dev/null || true)
  [ -n "$body" ] || return 0
  if command -v node >/dev/null 2>&1; then
    node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        try { const j=JSON.parse(s); if(Array.isArray(j.items)) process.stdout.write(String(j.items.length)); } catch {}
      });' <<EOF 2>/dev/null || true
$body
EOF
  fi
}
unread=$(count_unread)

# Build the reason (mention unread only when we have a positive count).
suffix=""
if [ -n "$unread" ] && [ "$unread" -gt 0 ] 2>/dev/null; then
  suffix=" (+ $unread unread)"
fi
if [ -n "$dead_word" ]; then
  if [ "$dead_word" = killed ]; then
    if [ -n "$dead_signal" ]; then
      cause="was killed ($dead_signal -- usually a session interrupt)"
    else
      cause="was killed (usually a session interrupt)"
    fi
  else
    cause="was stopped (Ctrl-C)"
  fi
  reason="Sparrow loop is engaged but your listener $cause${suffix} -- nothing is listening now, so nothing can wake this session. Re-arm it: run sparrow await --timeout 900 as a tracked background task (its exit is your wake-up call), then drain with sparrow pop when it exits. To step away on purpose run 'sparrow skill pause' (or 'sparrow-skill pause')."
elif [ -n "$hold_kind" ]; then
  reason="Sparrow loop is engaged and a listener IS alive, but it is sparrow $hold_kind${suffix} -- that holds you online (green presence) and can never wake this turn-based session, which is the online-but-deaf state, worse than being offline. Run sparrow await --timeout 900 as a tracked background task instead: it holds the stream the same way but EXITS when work arrives, and that exit is what re-invokes you -- then drain with sparrow pop. Keep sparrow $hold_kind only if you are genuinely always-running (a process that keeps thinking between messages). To step away on purpose run 'sparrow skill pause' (or 'sparrow-skill pause')."
else
  reason="Sparrow loop is engaged but no listener is running${suffix}. Turn-based (you think only when invoked)? Re-arm your wake command: sparrow await --timeout 900 as a background task, then drain with sparrow pop when it exits. Always-running? Re-start sparrow watch/loop. Note this hook checks the heartbeat a listener leaves behind -- a heartbeat with no listener kind (an older CLI, or your own curl loop) it cannot judge, so a re-armed await is on you. To step away on purpose run 'sparrow skill pause' (or 'sparrow-skill pause')."
fi

# Emit the block decision. Keep the reason free of double-quotes/newlines so this
# hand-rolled JSON stays valid without an escaper.
printf '{"decision":"block","reason":"%s"}\n' "$reason"
exit 0
