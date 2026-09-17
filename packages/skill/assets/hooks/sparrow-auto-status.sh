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
#   stop-failure  (StopFailure) → the USAGE-LIMIT mode. Claude Code fires
#                 StopFailure — NOT the plain Stop hook — when a turn ends on an
#                 API error, naming it in `error_type`. A session that has hit
#                 its usage limit otherwise looks perfectly online: the
#                 background `sparrow await` still holds the stream and presence
#                 stays green, while every wake dies on the limit and nobody is
#                 told. So for the errors that mean THIS AGENT CANNOT RUN until
#                 something changes -- rate_limit, billing_error,
#                 authentication_failed, account_on_hold, oauth_org_not_allowed,
#                 cloud_credential_error -- this records a marker under
#                 <state dir>/blocked/ and posts a sticky `blocked — ...` note
#                 across the rooms. Every other value (overloaded, server_error,
#                 max_output_tokens, invalid_request, model_not_found, unknown,
#                 or no error at all) is retried by Claude Code or is our own
#                 bug: no-op, because a sticky status is expensive to get wrong.
#                 StopFailure output is discarded by Claude Code, so this mode is
#                 a pure side effect -- it never writes stdout and never blocks.
#
# THE MARKER PROTOCOL (and why it is not one file).
#   * Each block is its OWN file: <state dir>/blocked/<compact-iso>-<random>.json
#     holding {"version":1,"reason","at","session","prompt","resumesAt"?}. A
#     reader is "blocked" while ANY file is there: age is not evidence that a
#     quota recovered, so markers never expire — only evidence, the resume
#     notification, or `sparrow skill unblock` removes them.
#   * A clearing hook deletes exactly the files IT READ, by name. A replacement
#     written between the read and the delete has a different name, so a new
#     block can never be erased by a hook that never saw it.
#   * Clearing needs EVIDENCE OF A NEWER SUCCESSFUL TURN, never chronology from
#     ids: prompt ids do not order (a delayed PostToolUse from prompt A differs
#     from a newer marker for prompt B just as much as a genuinely older one
#     does). So `post-tool` deletes a marker only when the session transcript
#     shows an assistant entry that is NOT an API error with a timestamp later
#     than that marker's `at`. Missing prompt id, missing, unreadable or
#     ambiguous transcript, no node: FAIL CLOSED, the marker STAYS. The evidence
#     is tied to this STATE DIR, not to the marker's session id. NAMED RESIDUAL:
#     that is a recovery HEURISTIC, not proof -- sharing a state dir does not
#     establish that two sessions share one quota bucket (account, model or
#     provider can differ), so a successful turn elsewhere under this dir can
#     clear a marker whose own session is still limited. `sparrow skill unblock`
#     is the operator recovery when the limited session is closed.
#   * `quota_auto_resume_fired` is the one unconditional clear -- Claude Code is
#     telling us it resumed the work itself -- and it clears from a SNAPSHOT too,
#     so a block recorded while it ran survives it. When one does, the recovery
#     side effects are skipped as well: no presence, no `working`, and the
#     surviving marker's note stands.
#     `quota_auto_resume_stale` (it waited too long; a human must press Enter)
#     and `quota_auto_resume_disabled` (auto-resume is off) both mean the agent
#     still cannot run: markers stand, only the note changes. NAMED RESIDUAL, not a guarantee: a notification delivered
#     late, after a newer limit episode began, clears that episode's markers.
#     Recovery then depends on the actual wake/failure lifecycle -- the next
#     ATTEMPTED turn failing and StopFailure writing a fresh marker -- not on any
#     presumed hook ordering; if no turn is attempted, nothing re-blocks.
#   * NO EXPIRY. A marker's age is not evidence that quota recovered, so nothing
#     here times one out: markers stand until transcript evidence, a quota-resume
#     notification, or `sparrow skill unblock` removes them.
#   * `prompt` does not clear anything: a prompt proves an ATTEMPT, not restored
#     quota. It prints the standing-by line while a marker stands.
#   * Cost of being wrong, bounded: an attempted turn that fails again re-writes
#     a marker (new name, new `at`), so the worst case is ONE bounce of presence
#     per attempted turn, and the CLI is back in standby within a cadence.
#
#   subagent-start / subagent-stop (SubagentStart / SubagentStop) → the SUBAGENT
#                 INDICATOR. One marker file per running subagent under
#                 <state dir>/subagents/, named by `agent_id`, and the sticky
#                 note grows a summary of what is running: `working (2 subagents:
#                 code-review, explore)`. Both post that note themselves, because
#                 a FOREGROUND subagent blocks its parent -- no tool call fires
#                 while it runs, which is exactly when someone is watching.
#                 Output is discarded for both, so they write nothing to stdout.
#
# PAYLOAD FIELDS THIS HOOK READS, and nothing else. StopFailure: `error_type`
# (falling back to `error`), `session_id`, `prompt_id`, `transcript_path`,
# `hook_event_name`. Notification: `notification_type`, `quota_type`.
# Subagent{Start,Stop}: `agent_id`, `agent_type`. (The Stop hook, not this one,
# reads `background_tasks` -- see sparrow-stop-check.sh.) UserPromptSubmit: `prompt`,
# only under SPARROW_STATUS_NOTES=verbose. Plus a
# reset timestamp if a future Claude Code supplies one (`resets_at` /
# `resumes_at` / `resetsAt`) -- none is documented today, so `resumesAt` is
# optional everywhere. Everything else in the payload is undocumented and
# treated as optional: a missing field is a no-op, never an error.
#
# SCOPE IS THE PROFILE'S OWN STATE DIR. The markers, like every other file here,
# live in the SPARROW_STATE_DIR this hook command was stamped with, and the
# status fan-out posts as the stamped SPARROW_PROFILE to the rooms that profile
# belongs to. One session hitting its usage limit therefore cannot take a
# neighbouring agent offline -- an isolation that assumes the existing model:
# unrelated profiles use separate state dirs (what a project-scope install
# writes, and what `SPARROW_STATE_DIR` exists to pin).
#
# DEBUG CAPTURE (off by default). With SPARROW_HOOK_DEBUG=1 every invocation
# appends one line to <state dir>/hook-debug.log: the time, the mode, the hook
# event, the `notification_type`/`error_type` when present, and the SORTED
# TOP-LEVEL KEY NAMES of the payload. Names only -- no prompt text, no message
# bodies, no paths -- so a real usage-limit event can be reported without
# leaking content.
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
# One file per block (see THE MARKER PROTOCOL above).
BLOCKED_DIR="$STATE_DIR/blocked"
# One file per RUNNING SUBAGENT, named by its agent id (see THE SUBAGENT
# INDICATOR below), plus the last subagent summary we posted.
SUBAGENT_DIR="$STATE_DIR/subagents"
SUBAGENT_NOTE_STAMP="$STATE_DIR/auto-status-subagents"
# Longer than any session plausibly runs: past this a marker is a crash
# leftover, not a subagent. The trade is deliberate -- 12h of a phantom in the
# note is better than dropping a real long-running subagent from it.
SUBAGENT_STALE="${SPARROW_SUBAGENT_STALE:-43200}"
# `STATUS_NOTE_MAX` in @sparrow/common-types. The API REJECTS a longer note with
# 400 -- it does not truncate -- so the composer trims before it posts.
NOTE_MAX=140
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
    *'"hook_event_name":"StopFailure"'* | *'"hook_event_name": "StopFailure"'*) MODE=stop-failure ;;
    *'"hook_event_name":"SubagentStart"'* | *'"hook_event_name": "SubagentStart"'*) MODE=subagent-start ;;
    *'"hook_event_name":"SubagentStop"'* | *'"hook_event_name": "SubagentStop"'*) MODE=subagent-stop ;;
    *'"hook_event_name":"Stop"'* | *'"hook_event_name": "Stop"'*) MODE=stop ;;
    *) exit 0 ;;
  esac
fi

# First string value for `key` in the payload (no jq): the text after the first
# occurrence of "<key>", past its colon, up to the closing quote. Whitespace
# tolerant; a missing key or a non-string value yields nothing, which every
# caller treats as "not supplied".
payload_value() {
  _k="$1"
  case "$input" in
    *"\"$_k\""*) ;;
    *) return 0 ;;
  esac
  _rest=${input#*"\"$_k\""}
  _rest=${_rest#*:}
  case "$_rest" in
    *'"'*)
      _rest=${_rest#*'"'}
      printf '%s' "${_rest%%'"'*}"
      ;;
  esac
}

# Strip anything that would break our hand-rolled JSON, and cap the length.
safe_field() { printf '%s' "$1" | tr -d '"\\' | tr '\r\n\t' '   ' | cut -c1-"${2:-120}"; }

# Local HH:MM for an ISO timestamp. GNU `date -d` when it is really GNU (BSD's
# -d means something else entirely), else the ISO string's own clock field.
clock_of() {
  _iso="$1"
  [ -n "$_iso" ] || return 0
  if date --version >/dev/null 2>&1; then
    _c=$(date -d "$_iso" +%H:%M 2>/dev/null || true)
    [ -n "$_c" ] && { printf '%s' "$_c"; return 0; }
  fi
  printf '%s' "$_iso" | sed -n 's/.*T\([0-9][0-9]:[0-9][0-9]\).*/\1/p'
}

# Seconds since a file was last written, or nothing when it cannot be told.
file_age() {
  _fa_now=$(date +%s 2>/dev/null || echo 0)
  _fa_m=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo "")
  [ -n "$_fa_m" ] && [ "$_fa_now" -gt 0 ] 2>/dev/null || return 0
  _fa_a=$((_fa_now - _fa_m))
  [ "$_fa_a" -ge 0 ] 2>/dev/null && printf '%s' "$_fa_a"
}

# --- THE SUBAGENT INDICATOR -------------------------------------------------
#
# WHAT IT IS FOR. A foreground subagent blocks its parent completely: no tool
# calls, no output, nothing to see, while whoever is watching wonders what the
# agent is doing. `SubagentStart`/`SubagentStop` are the ONLY signal available --
# subagents are not separate OS processes (verified: a session running one showed
# only an MCP server and two background shells), and the docs say not to read
# `<session>/subagents/*.jsonl`. So each running subagent is one file here, named
# by its agent id, and a stop deletes exactly its own: the same
# snapshot-by-name discipline as the usage-limit markers, for the same reason.
#
# MEASURED 2026-09-17, against a real headless session, because the docs neither
# list the payloads nor promise this:
#   * Registering these two events with NO `matcher` key fires them for every
#     agent type (checked with an `Explore` subagent) -- the matcher there is an
#     exact agent-type name, so a named one would silently cover one type.
#   * SubagentStart carries agent_id, agent_type, cwd, hook_event_name,
#     prompt_id, session_id, transcript_path. SubagentStop adds
#     agent_transcript_path, background_tasks, effort{level},
#     last_assistant_message, permission_mode, session_crons, stop_hook_active.
#   * THE SAME `agent_id` APPEARS ON BOTH EVENTS -- which is exactly what this
#     marker protocol rests on, now verified rather than assumed.
#
# THE `sinceAt` TRADE. The server tracks `sinceAt` as "when the CURRENT note was
# set" and only preserves it when the note is byte-identical (see
# apps/api/src/status-store.ts). So every subagent boundary changes the note and
# restarts the age: the room shows "working (2 subagents: ...)" as fresh even
# though the turn began earlier. Accepted deliberately -- a live picture of what
# is running beats an accurate age for a note nobody could interpret.

# Delete markers too old to be real (hooks only; `sparrow skill status` is a
# read-only command and merely ignores them).
subagent_sweep() {
  [ -d "$SUBAGENT_DIR" ] || return 0
  for _sf in "$SUBAGENT_DIR"/*.json; do
    [ -f "$_sf" ] || continue
    _sa=$(file_age "$_sf")
    [ -n "$_sa" ] || continue
    [ "$_sa" -ge "$SUBAGENT_STALE" ] 2>/dev/null && rm -f "$_sf" 2>/dev/null
  done
  return 0
}

# The TYPE of every live subagent, one per line (stale markers ignored).
subagent_types() {
  [ -d "$SUBAGENT_DIR" ] || return 0
  for _sf in "$SUBAGENT_DIR"/*.json; do
    [ -f "$_sf" ] || continue
    _sa=$(file_age "$_sf")
    [ -n "$_sa" ] && [ "$_sa" -lt "$SUBAGENT_STALE" ] 2>/dev/null || continue
    _st=$(json_field "$_sf" type)
    printf '%s\n' "${_st:-unknown}"
  done
}

# The parenthetical summary, or nothing when no subagent is running:
#   (1 subagent: explore)
#   (3 subagents: code-review, 2× explore)
#   (6 subagents: code-review, 2× explore, general-purpose +1 more)
# Count is AGENTS; the list is sorted by type name (the `N×` prefix is not part
# of the sort key); `+N more` counts the types not named. `limit` caps how many
# types are named -- the composer lowers it until the whole note fits.
subagent_summary() {
  _limit="${1:-3}"
  _types=$(subagent_types | sort)
  [ -n "$_types" ] || return 0
  _n=$(printf '%s\n' "$_types" | grep -c . 2>/dev/null || echo 0)
  [ "$_n" -gt 0 ] 2>/dev/null || return 0
  _word=subagents
  [ "$_n" = 1 ] && _word=subagent
  if [ "$_limit" -le 0 ] 2>/dev/null; then
    printf '(%s %s)' "$_n" "$_word"
    return 0
  fi
  _list=$(printf '%s\n' "$_types" | uniq -c | awk -v limit="$_limit" '
    { count = $1; $1 = ""; sub(/^[ \t]+/, ""); type = $0
      named++
      if (named <= limit) { list = list (list == "" ? "" : ", ") (count > 1 ? count "× " type : type) }
      else { more++ } }
    END { if (more > 0) printf "%s +%d more", list, more; else printf "%s", list }')
  printf '(%s %s: %s)' "$_n" "$_word" "$_list"
}

# `<base> <summary>`, trimmed to fit NOTE_MAX. Deterministic: name fewer types
# (3 → 2 → 1 → none), then hard-cut as the last resort.
compose_note() {
  _base="$1"
  for _lim in 3 2 1 0; do
    _sum=$(subagent_summary "$_lim")
    if [ -z "$_sum" ]; then printf '%s' "$_base"; return 0; fi
    _out="$_base $_sum"
    # `${#var}` counts BYTES in dash, characters in bash; the server counts
    # characters. Bytes >= characters, so this can only trim EARLIER than
    # required -- never past the limit, which is the direction that matters when
    # the alternative is a 400.
    [ "${#_out}" -le "$NOTE_MAX" ] 2>/dev/null && { printf '%s' "$_out"; return 0; }
  done
  printf '%s' "$_out" | cut -c1-"$NOTE_MAX"
}

# Every usage-limit marker, oldest first (the filename starts with a compact
# timestamp, so the glob's own order is chronological).
blocked_markers() {
  [ -d "$BLOCKED_DIR" ] || return 0
  for _f in "$BLOCKED_DIR"/*.json; do
    [ -f "$_f" ] && printf '%s\n' "$_f"
  done
}

# Record ONE block under its own name. Never overwrites another marker, so a
# clearing hook that is holding an older snapshot cannot delete this one.
write_blocked_marker() {
  _reason="$1"; _session="$2"; _prompt="$3"; _resumes="$4"; _at="$5"
  mkdir -p "$BLOCKED_DIR" 2>/dev/null || true
  _name="$(printf '%s' "$_at" | tr -cd '0-9')-$$"
  _file="$BLOCKED_DIR/$_name.json"
  _tmp="$_file.tmp"
  if [ -n "$_resumes" ]; then
    printf '{"version":1,"reason":"%s","at":"%s","session":"%s","prompt":"%s","resumesAt":"%s"}\n' \
      "$_reason" "$_at" "$_session" "$_prompt" "$_resumes" > "$_tmp" 2>/dev/null || return 0
  else
    printf '{"version":1,"reason":"%s","at":"%s","session":"%s","prompt":"%s"}\n' \
      "$_reason" "$_at" "$_session" "$_prompt" > "$_tmp" 2>/dev/null || return 0
  fi
  mv -f "$_tmp" "$_file" 2>/dev/null || rm -f "$_tmp" 2>/dev/null || true
}

# THE MARKER BOUNDARY: now, with MILLISECONDS -- the precision the transcript
# uses. The original bug was truncation, not the source of time: a whole-second
# marker (18:00:00Z) lost to a success at 18:00:00.100Z that happened BEFORE the
# 18:00:00.900Z error, so a delayed PostToolUse cleared a live marker.
#
# Wall clock, deliberately, NOT a timestamp read out of the transcript: nothing
# ties the last error entry there to THIS StopFailure, so a transcript still
# holding yesterday's episode (this turn's entry not yet flushed) would date the
# marker yesterday, and yesterday's success would clear it at once. Reading the
# clock here is conservative by construction -- every entry already in the file
# was written on this machine before this hook ran, so any pre-existing success
# is strictly older than the boundary.
#
# GNU date first, then node, and only as a last resort whole seconds: on a system
# with neither, the boundary degrades to second precision and a success recorded
# inside the same second as the failure can clear the marker one turn early. The
# next failed turn re-writes it.
now_iso_ms() {
  _t=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || echo "")
  case "$_t" in
    "" | *N*) ;;
    *) printf '%s' "$_t"; return 0 ;;
  esac
  if command -v node >/dev/null 2>&1; then
    _t=$(node -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || echo "")
    [ -n "$_t" ] && { printf '%s' "$_t"; return 0; }
  fi
  date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true
}

# Does the session transcript PROVE a successful assistant turn after <iso>?
# Only `type`, `timestamp` and `isApiErrorMessage` are read from each line, and
# only the tail is read. Anything we cannot establish answers no (fail closed):
# no transcript, unreadable, no node, unparseable timestamps.
transcript_newer_than() {
  _tp="$1"; _iso="$2"
  [ -n "$_tp" ] && [ -n "$_iso" ] && [ -r "$_tp" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  _proof=$(tail -n 200 "$_tp" 2>/dev/null | SPARROW_MARKER_AT="$_iso" node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try {
        const at = Date.parse(process.env.SPARROW_MARKER_AT || "");
        if (Number.isNaN(at)) return;
        for (const line of s.split("\n")) {
          if (!line.trim()) continue;
          let j; try { j = JSON.parse(line); } catch (e) { continue; }
          if (!j || j.type !== "assistant" || j.isApiErrorMessage === true) continue;
          const t = Date.parse(j.timestamp || "");
          if (!Number.isNaN(t) && t > at) { process.stdout.write("1"); return; }
        }
      } catch (e) {}
    });' 2>/dev/null || true)
  [ "$_proof" = 1 ]
}

# One string field out of one of our own small JSON records.
json_field() {
  sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$1" 2>/dev/null | head -n 1
}

# The Notification event's type, read once (see the notification mode below).
ntype=$(payload_value notification_type)

# --- debug capture (SPARROW_HOOK_DEBUG=1; names, never content) -------------
if [ "${SPARROW_HOOK_DEBUG:-}" = 1 ]; then
  dbg_keys=""
  if command -v node >/dev/null 2>&1; then
    dbg_keys=$(printf '%s' "$input" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j&&typeof j==="object")process.stdout.write(Object.keys(j).sort().join(","))}catch(e){}})' 2>/dev/null || true)
  fi
  dbg_extra=""
  dbg_nt="$ntype"
  dbg_er=$(payload_value error_type)
  [ -n "$dbg_er" ] || dbg_er=$(payload_value error)
  [ -n "$dbg_nt" ] && dbg_extra=" notification_type=$(safe_field "$dbg_nt" 60)"
  [ -n "$dbg_er" ] && dbg_extra="$dbg_extra error_type=$(safe_field "$dbg_er" 60)"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  printf '%s mode=%s event=%s%s keys=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)" \
    "${MODE:-none}" "$(safe_field "$(payload_value hook_event_name)" 40)" \
    "$dbg_extra" "${dbg_keys:-unknown}" >> "$STATE_DIR/hook-debug.log" 2>/dev/null || true
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

listener_nudge() {
  cause=""
  if [ ! -f "$HEARTBEAT_FILE" ]; then
    cause="is not running (no heartbeat at all)"
  else
    content=$(sparrow_heartbeat_read)
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
  # Both runtimes re-arm the same way now: plain, unbounded `sparrow await` —
  # the CLI owns its own liveness, so there is no timer to re-arm on.
  #
  # QUALIFIED BY PROFILE. Several agents on one machine share ONE
  # credentials.json, so a bare re-arm in a fresh shell arms whichever neighbour
  # owns defaultProfile. A project-scope install stamps SPARROW_PROFILE into this
  # hook's command for exactly that reason; when it is set the nudge names it.
  # This must render exactly what the CLI's `awaitCommand()` renders
  # (packages/skill/src/listener.ts); listener.test.ts pins the pair.
  if [ -n "${SPARROW_PROFILE:-}" ]; then
    command="sparrow await --profile $SPARROW_PROFILE"
  else
    command='sparrow await'
  fi
  printf 'Sparrow: your listener %s. Before anything else, re-arm it: run `%s` as a tracked background task, then continue. (To step away on purpose: sparrow skill pause.)\n' "$cause" "$command"
}

# The standing-by line: while a usage-limit marker stands, the re-arm nudge is
# the WRONG advice -- the listener is fine, the session cannot run, and there is
# nothing to re-arm. Printing this does not clear anything: a prompt proves an
# attempt, not restored quota.
blocked_line() {
  _m=$(blocked_markers | tail -n 1)
  [ -n "$_m" ] || return 1
  _reason=$(json_field "$_m" reason)
  _at=$(json_field "$_m" at)
  _clock=$(clock_of "$_at")
  printf 'Sparrow: this session hit its usage limit at %s (%s); the listener is standing by and will reconnect when Claude Code resumes. Nothing to re-arm.\n' \
    "${_clock:-an unknown time}" "${_reason:-unknown}"
  return 0
}

# Speak BEFORE the credential checks below: a killed listener is worth saying out
# loud even on a box where the status fan-out cannot run.
if [ "$MODE" = prompt ]; then
  blocked_line || listener_nudge || true
fi

# --- usage-limit side effects, BEFORE the credential gate -------------------
#
# The local record has to land whether or not this box can reach the server: the
# Stop hook, the next prompt and `sparrow skill status` all read it.
blocked_note=""
case "$MODE" in
  stop-failure)
    # `error_type` is the documented field; `error` is honored as a fallback.
    err=$(payload_value error_type)
    [ -n "$err" ] || err=$(payload_value error)
    case "$err" in
      rate_limit | billing_error | authentication_failed | account_on_hold | oauth_org_not_allowed | cloud_credential_error) ;;
      # Retried by Claude Code, or our own bug: say nothing at all.
      *) exit 0 ;;
    esac
    at=$(now_iso_ms)
    resumes=$(payload_value resets_at)
    [ -n "$resumes" ] || resumes=$(payload_value resumes_at)
    [ -n "$resumes" ] || resumes=$(payload_value resetsAt)
    resumes=$(safe_field "$resumes" 40)
    write_blocked_marker "$(safe_field "$err" 60)" "$(safe_field "$(payload_value session_id)" 80)" \
      "$(safe_field "$(payload_value prompt_id)" 80)" "$resumes" "$at"
    if [ "$err" = rate_limit ]; then
      blocked_note="blocked — usage limit reached"
      _c=$(clock_of "$resumes")
      [ -n "$_c" ] && blocked_note="$blocked_note; resumes $_c"
    else
      blocked_note="blocked — $(safe_field "$err" 40)"
    fi
    ;;
  subagent-start)
    # LOCAL BOOKKEEPING ALWAYS RUNS, before the blocked gate below. Writing a
    # file contradicts nothing anybody can see; only the network post has to be
    # suppressed while a usage limit stands. Gating this instead would leave a
    # phantom subagent in the count for the whole blocked window.
    subagent_sweep
    _ag=$(safe_field "$(payload_value agent_id)" 80 | tr -cd 'A-Za-z0-9_-')
    _ty=$(safe_field "$(payload_value agent_type)" 60 | tr -cd 'A-Za-z0-9_-')
    if [ -n "$_ag" ]; then
      mkdir -p "$SUBAGENT_DIR" 2>/dev/null || true
      printf '{"version":1,"agent":"%s","type":"%s","at":"%s"}\n' \
        "$_ag" "${_ty:-unknown}" "$(now_iso_ms)" > "$SUBAGENT_DIR/$_ag.json" 2>/dev/null || true
    fi
    ;;
  subagent-stop)
    # Delete exactly THIS agent's marker, by name. An id with no marker is a
    # silent no-op (an older install, a swept phantom, a stop we never saw start).
    subagent_sweep
    _ag=$(safe_field "$(payload_value agent_id)" 80 | tr -cd 'A-Za-z0-9_-')
    [ -n "$_ag" ] && rm -f "$SUBAGENT_DIR/$_ag.json" 2>/dev/null
    ;;
  post-tool)
    subagent_sweep
    # Snapshot the markers, then delete only the ones this run can PROVE are
    # over. A marker written after this listing has a name we never saw.
    tpath=$(payload_value transcript_path)
    blocked_markers | while IFS= read -r _mk; do
      [ -n "$_mk" ] || continue
      transcript_newer_than "$tpath" "$(json_field "$_mk" at)" && rm -f "$_mk" 2>/dev/null
    done
    ;;
  notification)
    case "$ntype" in
      quota_auto_resume_fired)
        # The ONLY notification that means work resumed. `_stale` and `_disabled`
        # both mean the limit reset but Claude Code is NOT continuing on its own,
        # so they leave the markers exactly where they are. Clear by name, from a
        # snapshot.
        blocked_markers | while IFS= read -r _mk; do
          [ -n "$_mk" ] || continue
          rm -f "$_mk" 2>/dev/null || true
        done
        ;;
    esac
    ;;
esac

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

# Post a composed note to every room AND remember the subagent part of it, so
# the post-tool backstop can tell "the composition changed" from "somebody else
# wrote a different note". (A same-note repost is free server-side: `sinceAt` is
# preserved when the text is identical, so this stamp is a network optimisation,
# not a correctness dependency.)
post_note() {
  post_status_all "{\"state\":\"working\",\"note\":\"$(safe_json "$1")\",\"sticky\":true}"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  printf '%s' "$2" > "$SUBAGENT_NOTE_STAMP" 2>/dev/null || true
}

# Strip anything that would break the hand-rolled JSON body (the composed note
# is the only note here that is not a literal).
safe_json() { printf '%s' "$1" | tr -d '"\\' | tr '\r\n\t' '   '; }

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

# --- the blocked gate ------------------------------------------------------
#
# WHILE A MARKER STANDS, NOTHING MAY CLAIM OTHERWISE. A session that cannot run a
# single turn must not advertise presence or a `working`/`idle` status: the
# blocked note it just posted would be taken straight back down by the next hook
# (a prompt posting `working` + a 300s presence heartbeat was exactly the bug),
# and the CLI's presence clear is one-shot per standby, so nothing else undoes
# it. The directory is re-read HERE, immediately before any write, so a hook that
# overlapped the StopFailure cannot erase what it recorded.
#
# Exempt: `stop-failure` (it is the one writing the blocked note) and the
# notification types that resolve the block, which have already cleared or
# deliberately updated the note above.
case "$MODE" in
  stop-failure) ;;
  notification)
    case "$ntype" in
      quota_auto_resume_stale | quota_auto_resume_disabled)
        # These SAY the agent is still blocked, so they only make sense while a
        # marker stands. If the block cleared meanwhile, say nothing at all.
        [ -n "$(blocked_markers | head -n 1)" ] || exit 0
        ;;
      *)
        # `quota_auto_resume_fired` included, deliberately: its clear works from
        # a snapshot, so a marker written while it ran SURVIVES -- and that
        # marker is a live block that its `working` + presence would contradict.
        # Re-read, and let the survivor's note stand.
        [ -n "$(blocked_markers | head -n 1)" ] && exit 0
        ;;
    esac
    ;;
  *) [ -n "$(blocked_markers | head -n 1)" ] && exit 0 ;;
esac

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
    # Whoever is running under this turn goes in the note too (capped at 140).
    _sum=$(subagent_summary)
    note=$(compose_note "$note")
    refresh_presence
    post_note "$note" "$_sum"
    rm -f "$IDLE_MARKER" 2>/dev/null || true
    ;;
  subagent-start | subagent-stop)
    # POST THE NOTE HERE, not only at turn boundaries: a FOREGROUND subagent
    # blocks its parent, so no tool call happens while it runs -- which is
    # exactly when someone is watching and wondering. The cost is the `sinceAt`
    # reset named above.
    _sum=$(subagent_summary)
    refresh_presence
    post_note "$(compose_note working)" "$_sum"
    rm -f "$IDLE_MARKER" 2>/dev/null || true
    ;;
  notification)
    case "$ntype" in
      permission_prompt | elicitation_dialog | elicitation_url_dialog | agent_needs_input)
        # A human is being asked something — we are stuck until they answer.
        refresh_presence
        post_status_all '{"state":"working","note":"blocked — needs your input","sticky":true}'
        rm -f "$IDLE_MARKER" 2>/dev/null || true
        ;;
      quota_auto_resume_fired)
        # Back to work. The markers are already gone (above); the resume
        # handshake in post-tool takes it from here.
        qt=$(payload_value quota_type)
        note="working"
        [ -n "$qt" ] && note="working (quota $(safe_field "$qt" 30) resumed)"
        refresh_presence
        post_status_all "{\"state\":\"working\",\"note\":\"$note\",\"sticky\":true}"
        rm -f "$IDLE_MARKER" 2>/dev/null || true
        ;;
      quota_auto_resume_stale)
        # NOT resumed work: Claude Code waited too long and is now waiting for
        # the user to press Enter. The agent still cannot run, so the markers
        # stand, no presence is claimed, and the note names what has to happen.
        post_status_all '{"state":"working","note":"blocked — usage limit reset while asleep; needs a human to press Enter to continue","sticky":true}'
        ;;
      quota_auto_resume_disabled)
        # Auto-resume is off, so nothing will continue on its own. Claims nothing
        # about the limit having reset -- only that a human has to act.
        post_status_all '{"state":"working","note":"blocked — usage limit reached; auto-resume is off, needs a human to continue","sticky":true}'
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
      post_note "$(compose_note working)" "$(subagent_summary)"
      mkdir -p "$STATE_DIR" 2>/dev/null || true
      : > "$POST_STAMP" 2>/dev/null || true
      wait 2>/dev/null || true
      exit 0
    fi
    # THE BACKSTOP. If the subagent picture changed without one of its hooks
    # posting -- a hook that failed, an install that predates them, a marker
    # swept for age -- put the truth back. Deliberately NOT throttled: it fires
    # only on a real change, and comparing the stamp costs nothing. It compares
    # the SUBAGENT part only, so it never overwrites somebody else's note (a
    # `blocked — needs your input`, say) just because the wording differs.
    _sum=$(subagent_summary)
    _prev=$(cat "$SUBAGENT_NOTE_STAMP" 2>/dev/null || printf '')
    if [ "$_sum" != "$_prev" ]; then
      refresh_presence
      post_note "$(compose_note working)" "$_sum"
      mkdir -p "$STATE_DIR" 2>/dev/null || true
      : > "$POST_STAMP" 2>/dev/null || true
      wait 2>/dev/null || true
      exit 0
    fi
    # Throttled presence refresh only — never rewrite the status (keeps sinceAt).
    throttled "$POST_STAMP" "$POST_THROTTLE" || exit 0
    refresh_presence
    ;;
  stop-failure)
    # NO PRESENCE HEARTBEAT. The CLI takes this profile off presence when it
    # stands by, and that clear is one-shot -- re-greening it here would undo the
    # only honest signal there is. The sticky note carries the story instead.
    # StopFailure's stdout is discarded by Claude Code, so this writes none.
    [ -n "$blocked_note" ] || exit 0
    post_status_all "{\"state\":\"working\",\"note\":\"$blocked_note\",\"sticky\":true}"
    rm -f "$IDLE_MARKER" 2>/dev/null || true
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
