#!/bin/sh
# Sparrow auto-status hook (Claude Code) — makes working/idle status automatic.
#
# One script, four modes (the mode is the first arg in the settings command; if
# absent it is inferred from the hook event in stdin JSON):
#   prompt        (UserPromptSubmit) → sticky "working" across every room + a
#                 presence heartbeat. Note is the generic "working" unless
#                 SPARROW_STATUS_NOTES=verbose, which derives a short (privacy-
#                 sensitive, opt-in) note from the prompt's first ~50 chars.
#                 ALSO the one mode that may SPEAK: a UserPromptSubmit hook's
#                 stdout is injected into the agent's context, so when the loop
#                 is engaged and the heartbeat says no listener is running
#                 (absent, stale, or a `killed`/`stopped` stamp) it prints ONE
#                 plain-text line telling the agent to re-arm `sparrow await`
#                 before anything else. That is the only way a session whose
#                 background listener was killed (a Claude Code interrupt kills
#                 the process tree) ever finds out.
#   post-tool     (PostToolUse) → throttled (~20s) presence refresh; PLUS the
#                 idle→working resume handshake: if the last event was a stop
#                 (marker file), the first tool call of the new turn restores a
#                 sticky "working" — turns started by a monitor event or task
#                 notification have no UserPromptSubmit, and without this they
#                 run entirely under the previous stop's idle. Otherwise it
#                 never rewrites the status: the sticky "working" set at prompt
#                 time stays alive because presence stays fresh, and its sinceAt
#                 keeps reflecting when the work actually STARTED.
#   notification  (Notification) → switches on the event's `notification_type`,
#                 because Claude Code fires ONE Notification event for every
#                 notification it raises:
#                   permission_prompt / elicitation_dialog /
#                   elicitation_url_dialog / agent_needs_input → a human is
#                     being asked something: sticky "working" noted "blocked —
#                     needs your input" across every room, cleared naturally by
#                     the next prompt (back to "working") or stop (idle).
#                   idle_prompt → the OPPOSITE: Claude Code emits this ~60s
#                     after a turn ends when nobody has typed, so the agent is
#                     doing nothing. Post `idle` to every room and leave (or
#                     create) the resume marker so the next autonomous turn's
#                     first tool call still restores "working". No presence
#                     heartbeat — we are not working.
#                   anything else, or no type at all (older Claude Code) →
#                     no-op. Sticky statuses are expensive to get wrong; only
#                     write for a type we actually understand.
#   stop          (Stop) → idle across every room. Invoked by sparrow-stop-check.sh
#                 ONLY on its allow (non-blocking) paths, so a blocked stop (loop
#                 drift) never flickers you idle.
#
# Contract: this hook is a pure side-effect with ONE exception. Every mode but
# `prompt` writes NOTHING to stdout (a Stop hook's stdout is a decision channel,
# and this script is also called from within sparrow-stop-check.sh); `prompt`
# may write exactly one plain-text re-arm nudge line (never JSON), which Claude
# Code injects as context. It ALWAYS exits 0 — any failure is a silent no-op so
# it can never wedge a session. It honors the loop switch: paused/absent = no
# writes and no nudge.
set -u

MODE="${1:-}"

STATE_DIR="${SPARROW_STATE_DIR:-$HOME/.sparrow}"
LOOP_STATE_FILE="$STATE_DIR/loop-state"
HEARTBEAT_FILE="$STATE_DIR/heartbeat"
# Kept in lockstep with sparrow-stop-check.sh (same env var, same default): the
# two hooks must agree on what "a listener is alive" means, or one nags about a
# listener the other is happy with.
FRESH_SECONDS="${SPARROW_HEARTBEAT_MAX_AGE:-120}"
POST_STAMP="$STATE_DIR/auto-status-post"
# Written by `stop`, consumed by the first hook of the NEXT turn — the
# idle→working resume handshake for turns that begin without a user prompt.
IDLE_MARKER="$STATE_DIR/auto-status-idle"
POST_THROTTLE="${SPARROW_STATUS_POST_THROTTLE:-20}"
MAX_ROOMS="${SPARROW_STATUS_MAX_ROOMS:-10}"
PRESENCE_TTL="${SPARROW_PRESENCE_TTL:-300}"

# Read stdin once (best-effort). Needed for verbose notes and event inference.
input=$(cat 2>/dev/null || true)

# Infer the mode from the hook event when no arg was passed.
if [ -z "$MODE" ]; then
  case "$input" in
    *'"hook_event_name":"UserPromptSubmit"'* | *'"hook_event_name": "UserPromptSubmit"'*) MODE=prompt ;;
    *'"hook_event_name":"PostToolUse"'* | *'"hook_event_name": "PostToolUse"'*) MODE=post-tool ;;
    *'"hook_event_name":"Notification"'* | *'"hook_event_name": "Notification"'*) MODE=notification ;;
    *'"hook_event_name":"Stop"'* | *'"hook_event_name": "Stop"'*) MODE=stop ;;
    *) exit 0 ;;
  esac
fi

# Loop switch: only act while explicitly engaged (paused/absent = stay silent).
[ -f "$LOOP_STATE_FILE" ] || exit 0
state=$(tr -d ' \t\r\n' < "$LOOP_STATE_FILE" 2>/dev/null || echo "")
[ "$state" = "engaged" ] || exit 0

# --- the re-arm nudge (prompt mode only) -----------------------------------

# Say how long ago, compactly: "12s" under a minute, else whole minutes.
fmt_age() {
  if [ "$1" -lt 60 ] 2>/dev/null; then printf '%ss' "$1"; else printf '%sm' "$(($1 / 60))"; fi
}

# Print ONE line telling the agent its listener is gone and how to re-arm — or
# print nothing, which is the case whenever a fresh `sparrow await` is running.
#
# WHY IT EXISTS: the harness kills the tracked background `sparrow await` when a
# human interrupts the session, and the agent has no way to notice. The Stop
# hook catches it only at the END of a turn; this catches it at the START, which
# is the turn that can actually fix it. A dying listener stamps the heartbeat
# `killed:<signal>`/`stopped:<signal>`, so the cause can be named honestly.
#
# Deliberately silent for a fresh `watch`/`loop`/unknown heartbeat: something IS
# listening, and judging WHICH is the Stop hook's job, not a prompt-time nag.
listener_nudge() {
  cause=""
  if [ ! -f "$HEARTBEAT_FILE" ]; then
    cause="is not running (no heartbeat at all)"
  else
    content=$(head -c 64 "$HEARTBEAT_FILE" 2>/dev/null | tr -d ' \t\r\n' || echo "")
    signal=""
    case "$content" in
      *:*) signal=$(printf '%s' "${content#*:}" | tr -cd 'A-Za-z0-9_') ;;
    esac
    now=$(date +%s 2>/dev/null || echo 0)
    hb=$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || echo "")
    age=""
    if [ -n "$hb" ] && [ "$now" -gt 0 ] 2>/dev/null; then
      age=$((now - hb))
      [ "$age" -ge 0 ] 2>/dev/null || age=""
    fi
    case "$content" in
      # A terminal stamp beats freshness: the listener told us it is gone, and it
      # is at its FRESHEST the moment it died.
      killed | killed:*)
        if [ -n "$signal" ]; then
          cause="was killed ($signal -- usually a session interrupt)"
        else
          cause="was killed (usually a session interrupt)"
        fi
        [ -n "$age" ] && cause="$cause $(fmt_age "$age") ago"
        ;;
      stopped | stopped:*)
        cause="was stopped (Ctrl-C)"
        [ -n "$age" ] && cause="$cause $(fmt_age "$age") ago"
        ;;
      *)
        if [ -n "$age" ] && [ "$age" -ge "$FRESH_SECONDS" ] 2>/dev/null; then
          cause="is not running (no listener has heartbeated for $(fmt_age "$age"))"
        fi
        ;;
    esac
  fi
  [ -n "$cause" ] || return 0
  printf 'Sparrow: your listener %s. Before anything else, re-arm it: run `sparrow await --timeout 900` as a tracked background task, then continue. (To step away on purpose: sparrow skill pause.)\n' "$cause"
}

# Speak BEFORE the credential checks below: a killed listener is worth saying out
# loud even on a box where the status fan-out cannot run.
if [ "$MODE" = prompt ]; then
  listener_nudge || true
fi

# Resolve creds (identical ladder to sparrow-stop-check.sh): SPARROW_SERVER +
# SPARROW_TOKEN from the env, else the credentials.json profile named by
# SPARROW_PROFILE -- which a project-scope install stamps into this hook's
# command so it always acts as the agent that installed it -- else
# defaultProfile. A NAMED-but-missing profile resolves to nothing and the hook
# stays silent: posting somebody else's status is worse than posting none.
server="${SPARROW_SERVER:-}"
token="${SPARROW_TOKEN:-}"
if [ -z "$server" ] || [ -z "$token" ]; then
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
[ -n "$server" ] && [ -n "$token" ] && command -v curl >/dev/null 2>&1 || exit 0
server=$(printf '%s' "$server" | sed 's:/*$::')

# --- helpers ---------------------------------------------------------------

# Fire a presence heartbeat (best-effort, tight timeout). Backgrounded so a turn
# is never delayed by the network.
refresh_presence() {
  curl -fsS --max-time 3 -X POST "$server/api/v1/me/presence" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"ttlSeconds\":$PRESENCE_TTL}" >/dev/null 2>&1 &
}

# List my non-archived room ids (one per line, capped). Requires node to parse
# the JSON; without it we simply skip the status fan-out (best-effort).
room_ids() {
  command -v node >/dev/null 2>&1 || return 0
  body=$(curl -fsS --max-time 5 "$server/api/v1/me/rooms" \
    -H "authorization: Bearer $token" 2>/dev/null || true)
  [ -n "$body" ] || return 0
  printf '%s' "$body" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try {
        const j = JSON.parse(s);
        const items = Array.isArray(j.items) ? j.items : [];
        for (const it of items) {
          const r = it && it.room;
          if (r && r.id && !r.archivedAt) process.stdout.write(r.id + "\n");
        }
      } catch {}
    });' 2>/dev/null || true
}

# Emit a JSON string for a note, hand-escaped so our hand-rolled body stays
# valid: strip double-quotes / backslashes / control chars, truncate to 50.
safe_note() {
  printf '%s' "$1" | tr -d '"\\' | tr '\r\n\t' '   ' | cut -c1-50
}

# Fan a body out to /rooms/<id>/status for each non-archived room (cap MAX_ROOMS).
post_status_all() {
  body="$1"
  n=0
  room_ids | while IFS= read -r rid; do
    [ -n "$rid" ] || continue
    n=$((n + 1))
    [ "$n" -le "$MAX_ROOMS" ] || break
    curl -fsS --max-time 4 -X POST "$server/api/v1/rooms/$rid/status" \
      -H "authorization: Bearer $token" -H 'content-type: application/json' \
      -d "$body" >/dev/null 2>&1 || true
  done
}

# Throttle a mode via a state-dir stamp file: succeed (and re-stamp) at most once
# per $2 seconds. Returns 0 to proceed, 1 to skip.
throttled() {
  stamp="$1"; window="$2"
  now=$(date +%s 2>/dev/null || echo 0)
  if [ -f "$stamp" ] && [ "$now" -gt 0 ] 2>/dev/null; then
    last=$(stat -c %Y "$stamp" 2>/dev/null || stat -f %m "$stamp" 2>/dev/null || echo 0)
    if [ -n "$last" ] && [ "$last" -gt 0 ] 2>/dev/null; then
      age=$((now - last))
      [ "$age" -ge 0 ] && [ "$age" -lt "$window" ] && return 1
    fi
  fi
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  : > "$stamp" 2>/dev/null || true
  return 0
}

# --- modes -----------------------------------------------------------------

case "$MODE" in
  prompt)
    note="working"
    if [ "${SPARROW_STATUS_NOTES:-}" = "verbose" ] && command -v node >/dev/null 2>&1; then
      prompt=$(printf '%s' "$input" | node -e '
        let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
          try { const j=JSON.parse(s); if (typeof j.prompt === "string") process.stdout.write(j.prompt); } catch {}
        });' 2>/dev/null || true)
      derived=$(safe_note "$prompt")
      [ -n "$derived" ] && note="$derived"
    fi
    refresh_presence
    post_status_all "{\"state\":\"working\",\"note\":\"$note\",\"sticky\":true}"
    rm -f "$IDLE_MARKER" 2>/dev/null || true
    ;;
  notification)
    # Best-effort `notification_type` extraction (no jq): take the text after the
    # FIRST "notification_type" key, past its colon, and read the quoted value.
    # Whitespace-tolerant; a non-string value simply yields something we do not
    # recognize, which lands in the no-op branch.
    ntype=""
    case "$input" in
      *'"notification_type"'*)
        rest=${input#*'"notification_type"'}
        rest=${rest#*:}
        case "$rest" in
          *'"'*)
            rest=${rest#*'"'}
            ntype=${rest%%'"'*}
            ;;
        esac
        ;;
    esac
    case "$ntype" in
      permission_prompt | elicitation_dialog | elicitation_url_dialog | agent_needs_input)
        # A human is being asked something — we are stuck until they answer.
        refresh_presence
        post_status_all '{"state":"working","note":"blocked — needs your input","sticky":true}'
        rm -f "$IDLE_MARKER" 2>/dev/null || true
        ;;
      idle_prompt)
        # Claude Code nudging the HUMAN that the session is sitting idle. The
        # agent is not working, so say idle — and KEEP the resume marker so the
        # next turn's first tool call restores "working" (an idle_prompt can
        # arrive before a monitor-triggered turn). No presence refresh.
        post_status_all '{"state":"idle"}'
        mkdir -p "$STATE_DIR" 2>/dev/null || true
        [ -f "$IDLE_MARKER" ] || : > "$IDLE_MARKER" 2>/dev/null || true
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  post-tool)
    # The idle→working resume handshake: a turn started by a monitor event or
    # task notification has NO UserPromptSubmit, so without this the whole
    # autonomous turn runs under the last stop's `idle` and the agent reads as
    # doing nothing while it works. The stop mode leaves a marker; the FIRST
    # tool call of the next turn restores sticky `working` and consumes it.
    if [ -f "$IDLE_MARKER" ]; then
      rm -f "$IDLE_MARKER" 2>/dev/null || true
      refresh_presence
      post_status_all '{"state":"working","note":"working","sticky":true}'
      mkdir -p "$STATE_DIR" 2>/dev/null || true
      : > "$POST_STAMP" 2>/dev/null || true
      wait 2>/dev/null || true
      exit 0
    fi
    # Throttled presence refresh only — never rewrite the status (keeps sinceAt).
    throttled "$POST_STAMP" "$POST_THROTTLE" || exit 0
    refresh_presence
    ;;
  stop)
    post_status_all '{"state":"idle"}'
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    : > "$IDLE_MARKER" 2>/dev/null || true
    ;;
  *)
    exit 0
    ;;
esac

# Let backgrounded presence finish without holding the session (bounded by its
# own --max-time); then always succeed.
wait 2>/dev/null || true
exit 0
