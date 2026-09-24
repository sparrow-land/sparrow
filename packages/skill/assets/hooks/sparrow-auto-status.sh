#!/bin/sh
# Sparrow auto-status hook (Claude Code) — makes working/idle status automatic.
#
# One script, several modes (the mode is the first arg in the settings command;
# if absent it is inferred from the hook event in stdin JSON):
#   prompt        (UserPromptSubmit) → "working" across every room, TTL'd at
#                 600s and NOT sticky (see A BOUNDED `working` below), + a
#                 presence heartbeat. Note is the generic "working" unless
#                 SPARROW_STATUS_NOTES=verbose, which derives a short (privacy-
#                 sensitive, opt-in) note from the prompt's first ~50 chars.
#                 ALSO the one mode that may SPEAK: a UserPromptSubmit hook's
#                 stdout is injected into the agent's context, so when the loop
#                 is engaged and the heartbeat says no listener is running
#                 (absent, stale, or a `killed`/`stopped`/`orphaned` stamp) it prints ONE
#                 plain-text line telling the agent to re-arm `sparrow await`
#                 before anything else. That is the only way a session whose
#                 background listener was killed (a Claude Code interrupt kills
#                 the process tree) ever finds out.
#   post-tool     (PostToolUse) → throttled (~20s) presence refresh, and on the
#                 same throttle -- once the note is half its TTL old (300s),
#                 never more often -- a RE-POST of the note every room was last
#                 told (the stamp's text, unchanged, so its sinceAt keeps
#                 reflecting when the work actually STARTED) with the 600s TTL:
#                 a live turn
#                 keeps its `working` alive this way, and a session with no turn
#                 running loses it within 600s of the last tool call. PLUS the
#                 idle→working resume handshake: if the last event was a stop
#                 (marker file), the first tool call of the new turn restores
#                 "working" — turns started by a monitor event or task
#                 notification have no UserPromptSubmit, and without this they
#                 run entirely under the previous stop's idle. It never
#                 rewrites the note TEXT except to repair a drifted composition
#                 (the backstop below).
#   pre-tool      (PreToolUse) → the SAME resume handshake and throttled
#                 refresh (presence + re-post of the stamp's note with the 600s
#                 TTL) as post-tool, sharing its throttle stamp, at the START of
#                 every tool call. Without it a single call longer than the TTL
#                 let `working` lapse mid-turn until the call returned, and a
#                 monitor-triggered turn whose first call was long read as idle
#                 throughout. Nothing else: no backstop, no repair step, no
#                 stdout. Inside the throttle window it exits before resolving
#                 credentials (see THE CHEAP EXIT), because it sits in front of
#                 every tool call -- unless the note is within a window (plus a
#                 margin) of its TTL (NOTE_REFRESH_AGE), when it refreshes
#                 anyway, so a call that starts inside the window still cannot
#                 outlive the note unless it runs longer than the TTL itself.
#   notification  (Notification) → switches on the event's `notification_type`,
#                 because Claude Code fires ONE Notification event for every
#                 notification it raises:
#                   permission_prompt / elicitation_dialog /
#                   elicitation_url_dialog / agent_needs_input → a human is
#                     being asked something: STICKY "working" noted "blocked —
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
#                 drift) never flickers you idle. It records that idle is OWED
#                 before it tries to publish, so the intent outlives the process:
#                 see IDLE IS OWED, NOT MERELY INTENDED in the mode below.
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
#                 <state dir>/subagents/, named by `agent_id`, and the note
#                 grows a summary of what is running: `working (2 subagents:
#                 code-review, explore)`. Both post that note themselves, so the
#                 summary appears and disappears at the boundary. It carries the
#                 600s TTL like any other `working`: the parent's PreToolUse and
#                 PostToolUse fire for the subagent's own tool calls (observed:
#                 the throttle stamp kept moving while only subagents ran), so
#                 the ordinary refresh keeps it alive, and a marker orphaned by
#                 a missed SubagentStop cannot hold it for 12 hours.
#                 Output is discarded for both, so they write nothing to stdout.
#
# A BOUNDED `working` (2026-09-24). Observed on a real host: the Stop hook
# published idle, three minutes later `working` was re-posted with no turn
# running, and a sticky status has no timer -- it stood for 2.5 hours on an
# idle agent. Whatever the trigger, the defence is independent of it: the
# ordinary `working` (prompt, the resume handshake, a resumed quota) carries
# `"ttlSeconds":600` (the server's STATUS_TTL_MAX) and lives only while the
# tool-call refresh keeps re-posting it -- the subagent summary included. STICKY
# is kept only where a human must see the note: `blocked — needs your input` and
# the usage-limit notes, cleared by the events that end them (the next prompt,
# a stop).
# `post_note` derives the lifetime from the same state the note was composed
# from, so a body and its lifetime always agree. Net effect: outside a turn,
# `working` lasts at most 600s after the last tool call unless a blocked note is
# legitimately outstanding. Inside a turn the refresh runs at
# both ends of every tool call (pre-tool and post-tool), so the status lapses
# only inside ONE call that itself runs longer than 600s. The Bash tool cannot
# (its maximum timeout is 600s); NAMED RESIDUAL: a long Monitor wait or a
# foreground Workflow run can, and `working` then disappears until that call
# returns and the post-tool refresh puts it back.
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
#
# "ALWAYS EXITS 0" IS ENFORCED, NOT HOPED FOR. Under PreToolUse a non-zero exit
# DENIES the tool call (exit 2 is a blocking error whose stderr goes to the
# model), and `set -u` aborts dash with status 2 on any unbound variable. An
# EXIT trap that itself calls `exit 0` overrides whatever status the shell was
# leaving with -- an explicit `exit N`, a `set -u` abort, anything -- in dash
# and bash alike. Only the shell's own abort message still reaches stderr.
# (Not in sparrow-stop-check.sh: its stdout is a decision channel and its paths
# already exit 0 on their own.)
trap 'exit 0' EXIT
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
# The FULL body last posted (not just its subagent part): every "has anything
# changed" test compares against this, so a change in the PARENT's condition
# counts as much as a subagent appearing.
NOTE_STAMP="$STATE_DIR/auto-status-note"
# What the stamp holds after an `idle` publication. A later publisher that finds
# it -- with nothing owed -- knows the turn ENDED and must not resurrect it.
IDLE_STAMP='idle'
# ONE FILE PER MUTATION, never reused, acknowledged only from a snapshot of
# names (see THE PENDING RECORD).
PENDING_DIR="$STATE_DIR/auto-status-pending.d"
# The pre-2026-09-18 single-token path. An install upgrading in place may still
# have a regular file here; `pending_migrate` converts it once per hook run.
PENDING_LEGACY="$STATE_DIR/auto-status-pending"
# Written by `stop` BEFORE it tries to publish, so the INTENT to go idle is
# durable state rather than one process's plan (see IDLE IS OWED, NOT INTENDED).
IDLE_OWED="$STATE_DIR/auto-status-idle-owed"
# --- WHEN THE ROOMS DISAGREE WITH THE STAMP ---------------------------------
#
# $NOTE_STAMP means ONE thing: "this is what EVERY room was last told". A fan-out
# that reached some rooms and not others makes that sentence false of the world,
# and the single stamp cannot express which rooms -- so the fact was kept only
# inside the process that discovered it, and died with it.
#
# The consequence (coordinator, 2026-09-18), with no failure needed after the
# first: a publisher posts body B to rooms 1-3 of 10 and stops (budget gone, or
# their POSTs refused). Correctly, nothing is stamped and nothing acknowledged,
# so the stamp still reads A. The state then REVERTS to A -- a subagent starts
# and stops -- and the next publisher composes A, finds it equal to the stamp,
# posts nothing, and acknowledges everything. Rooms 1-3 show B forever: the
# drift check compares one composed body against one global stamp and they
# agree, so only a later publication of some DIFFERENT body, or a stop's idle,
# ever heals it.
#
# So the divergence is written down. While this marker stands, a publisher posts
# even when its body equals the stamp, because the stamp is not true of every
# room. It is NOT the pending records: those are answered by an idle (idle
# supersedes any composed note), whereas a working note delivered to three rooms
# of ten is answered by nothing except a complete publication.
#
# IT RECORDS WHAT MIGHT HAVE LANDED, NOT WHAT WAS CONFIRMED -- the one point
# where this differs from the delivery COUNT above, and the distinction is the
# whole of it. A non-zero curl exit does not mean the server rejected the write.
# A timeout, a dropped connection and a response lost on the way back are all
# indistinguishable from a refusal at the client, and in every one of them the
# server may already have applied the body. Reviewer, 2026-09-18, against a real
# local server: it APPLIED body B and dropped the connection before replying, so
# a rule that marked divergence only after a confirmed delivery marked nothing,
# the state reverted to A, the next publisher found A equal to the stamp, posted
# nothing and acknowledged everything -- and the room held B forever. Exactly
# the failure this marker exists to prevent, reintroduced by trusting a failure
# response to prove a negative.
#
# Hence the asymmetry, which is deliberate and is the safe direction on both
# sides: ANY DISPATCHED WRITE makes divergence possible, so the flag is set once,
# on the first request of a fan-out, BEFORE its outcome is known; and only
# CONFIRMED DELIVERY to every room in the capped list makes divergence
# impossible, so only that clears it. A fan-out that dispatches nothing at all --
# no rooms, or no budget left before the first request -- sets nothing, because
# no write was ever in flight. The ordinary case costs nothing: a complete
# fan-out sets the flag on its first POST and clears it on the same pass.
#
# SET AND CLEARED IN ONE PLACE, `post_status_all`, so every publication path --
# composed notes, idle, and the literal blocked/quota bodies -- is covered by
# construction.
NOTE_DIVERGED="$STATE_DIR/auto-status-diverged"
# A plain file, NEVER unlinked: `flock` holds it and the kernel releases it.
NOTE_LOCK_FILE="$STATE_DIR/auto-status-note.lock"
# Set while a human is being asked something and NOT cleared by anything a child
# does -- see THE PARENT'S NOTE below.
NEEDS_INPUT_FILE="$STATE_DIR/needs-input"
# Longer than any session plausibly runs: past this a marker is a crash
# leftover, not a subagent. The trade is deliberate -- 12h of a phantom in the
# note is better than dropping a real long-running subagent from it.
SUBAGENT_STALE="${SPARROW_SUBAGENT_STALE:-43200}"
# `STATUS_NOTE_MAX` in @sparrow-land/sdk/types. The API REJECTS a longer note with
# 400 -- it does not truncate -- so the composer trims before it posts.
NOTE_MAX=140
POST_THROTTLE="${SPARROW_STATUS_POST_THROTTLE:-20}"
MAX_ROOMS="${SPARROW_STATUS_MAX_ROOMS:-10}"
PRESENCE_TTL="${SPARROW_PRESENCE_TTL:-300}"
# The ordinary `working` is TTL'd, not sticky: `STATUS_TTL_MAX` on the server
# (apps/api), the longest a status may live without a refresh. See A BOUNDED
# `working` in the header.
WORKING_TTL=600
# The age from which a tool call re-posts the note (presence is refreshed every
# throttle window regardless): half the TTL.
NOTE_REPOST_AGE=$((WORKING_TTL / 2))
# Past this age the note is close enough to lapsing that `pre-tool` refreshes it
# even inside the throttle window: the TTL, less one window, less a margin. A
# call that starts inside the window can run almost a full TTL, and without
# this the note it started under could lapse before it returns.
case "$POST_THROTTLE" in
  '' | *[!0-9]*) NOTE_REFRESH_AGE=560 ;;   # a non-numeric override must not abort the hook
  *) NOTE_REFRESH_AGE=$((WORKING_TTL - POST_THROTTLE - 20)) ;;
esac
# A huge throttle override (>= 580) would make that zero or negative, and then
# EVERY note, however fresh, would count as near expiry. Clamp to a floor.
[ "$NOTE_REFRESH_AGE" -ge 60 ] 2>/dev/null || NOTE_REFRESH_AGE=60

# Read stdin once (best-effort). Needed for verbose notes and event inference.
input=$(cat 2>/dev/null || true)

# Infer the mode from the hook event when no arg was passed.
if [ -z "$MODE" ]; then
  case "$input" in
    *'"hook_event_name":"UserPromptSubmit"'* | *'"hook_event_name": "UserPromptSubmit"'*) MODE=prompt ;;
    *'"hook_event_name":"PreToolUse"'* | *'"hook_event_name": "PreToolUse"'*) MODE=pre-tool ;;
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

# A TOP-LEVEL STRING field, read STRUCTURALLY. `payload_value` above takes the
# first quoted string after a key, which is the NEXT KEY'S VALUE when the field
# is null: `{"agent_id":null,"agent_type":"Explore"}` yielded `Explore` as the
# id, and the hook named a marker file after a subagent that never existed. So
# anything that NAMES A FILE comes through here instead: node parses the payload
# and returns the value only when it is a top-level string.
#
# NO FALLBACK, deliberately. On a host without node this returns nothing and the
# caller writes no marker — the indicator degrades to "no subagents shown", which
# is honest and harmless. An anchored-sed fallback could still mistake a nested
# field for a top-level one, which is the exact bug being fixed; a wrong marker
# is worse than a missing one.
payload_string() {
  command -v node >/dev/null 2>&1 || return 0
  printf '%s' "$input" | SPARROW_PAYLOAD_KEY="$1" node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const j = JSON.parse(s);
        if (!j || typeof j !== "object" || Array.isArray(j)) return;
        const v = j[process.env.SPARROW_PAYLOAD_KEY];
        if (typeof v === "string") process.stdout.write(v);
      } catch (e) {}
    });' 2>/dev/null || true
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

# --- THE PENDING RECORD -----------------------------------------------------
#
# A bounded publisher can drop the LAST mutation: with three rounds, a fourth
# marker arriving during round three is seen, the loop exits, and if every other
# hook has already given up, nobody publishes it. The round cap must bound one
# hook's WORK, never correctness. So every mutation leaves an on-disk record
# that the note owes it a publication, and any later hook that finds one
# publishes -- whatever its own mode was.
#
# ONE FILE PER MUTATION, AND NAMES ARE NEVER REUSED. `mark_pending` creates a
# NEW, uniquely named empty file (time-pid-sequence, sanitised to a safe
# filename) under $PENDING_DIR. It never overwrites a previous marker, so no
# record can be clobbered by a later one.
#
# THE DOUBLE STAMP STAYS, and now means something stronger: every mutation site
# calls `mark_pending` BEFORE it mutates and AGAIN AFTER, producing two
# DIFFERENT names. The "after" name is created only once the mutation is
# complete on disk.
#
# ACKNOWLEDGEMENT IS BY SNAPSHOT, BY NAME, WITH NO COMPARISON ANYWHERE. A
# publisher lists the directory BEFORE it composes, and after it has posted it
# unlinks exactly the names in that list. The argument:
#   * A name in the snapshot existed before the publisher read the state, so for
#     an "after" stamp the mutation it records had already completed and the
#     body just posted covers it. (Its "before" twin is covered a fortiori.)
#   * A mutation that completes later stamps a name that was never in the
#     snapshot, so it survives the unlink and a later hook repairs it.
#   * Unlinking a snapshotted name can never destroy a record the publisher did
#     not cover, because names are never reused -- there is no value to compare
#     and therefore no compare-and-delete to lose a race in. THIS IS THE FIX for
#     the reviewer's 2026-09-18 sequence: a publisher paused between its old
#     equality check and its `rm` deleted a token that a `permission_prompt`
#     notification had re-stamped in the gap, and the ask went unpublished with
#     nothing left on disk to say so. That gap no longer exists.
#   * Acknowledgement is unconditional on whether a post was actually needed: a
#     body identical to the stamp still means "every room already has this",
#     which is exactly what the snapshotted mutations were owed.
#
# WHAT THIS BUYS, EXACTLY: eventual repair, not immediate correctness. A
# publisher that runs out of rounds, or loses the lock, leaves markers behind --
# the honest on-disk record that the note is stale. RESIDUAL, stated plainly: a
# `SubagentStop` can be delayed for the length of a task, or never arrive at all
# after an interrupt or a crash, so "a later hook" is not a promise about when.
# Until one runs, the note may be stale and the markers are the record of it.
_pending_seq=0
mark_pending() {
  _pending_seq=$((_pending_seq + 1))
  mkdir -p "$PENDING_DIR" 2>/dev/null || true
  _mp_name=$(printf '%s-%s-%s' "$(now_iso_ms)" "$$" "$_pending_seq" | tr -cd 'A-Za-z0-9._-')
  [ -n "$_mp_name" ] || _mp_name="$$-$_pending_seq"
  : > "$PENDING_DIR/$_mp_name" 2>/dev/null || true
}

# The NAMES of every marker on disk, one per line (the publisher's snapshot).
pending_names() {
  [ -d "$PENDING_DIR" ] || return 0
  for _pn in "$PENDING_DIR"/*; do
    [ -f "$_pn" ] || continue
    printf '%s\n' "${_pn##*/}"
  done
}

# Is anything owed? (The repair step's whole question.)
pending_any() { [ -n "$(pending_names | head -n 1)" ]; }

# Unlink exactly the snapshotted names, by name. Anything created since is
# untouched, because a name is only ever used once.
pending_ack() {
  [ -n "${1:-}" ] || return 0
  printf '%s\n' "$1" | while IFS= read -r _pa; do
    [ -n "$_pa" ] || continue
    rm -f "$PENDING_DIR/$_pa" 2>/dev/null || true
  done
  return 0
}

# Does anything on disk say the note is not yet true of the world? Either a
# mutation nobody published, or a publication that reached only some rooms. The
# repair step's whole question, and the two answers are not interchangeable:
# markers are answered by any publication that covers them, divergence only by a
# complete fan-out.
repair_owed() { pending_any || [ -f "$NOTE_DIVERGED" ]; }

# MIGRATION, once per hook run. An install upgrading in place can have a legacy
# single-token regular file at the old path. It records a real mutation, so it is
# CONVERTED (one fresh marker) rather than dropped.
pending_migrate() {
  [ -f "$PENDING_LEGACY" ] || return 0
  mark_pending
  rm -f "$PENDING_LEGACY" 2>/dev/null || true
}

# BOUND THE STORAGE, NOT THE DEBT. Names are never reused, so nothing overwrites
# anything and a host whose publications never succeed -- no network, a wrong
# token, a permanently held lock -- would accumulate one marker per mutation
# forever. That is a STORAGE problem, and it is the only problem here.
#
# AGE IS NOT STALENESS, and the first version of this comment claimed it was:
# "a marker this old will never be usefully repaired -- the note it was owed
# describes a turn that ended hours ago". That is simply false. A marker carries
# no note. It carries one fact -- "a publication is owed" -- and the body is
# composed from CURRENT state at publish time, so an hour-old marker sitting
# next to a live subagent is exactly as valid as a fresh one. Deleting markers
# on age therefore destroyed the only repair signal there was: after an outage,
# the sweep cleared the debt, the absent-stamp rule made the post-tool backstop
# stand down, the repair step found nothing owed, and a running subagent was
# never shown at all.
#
# SO THE DEBT IS COALESCED, NEVER DISCARDED: every marker past the threshold is
# replaced by ONE fresh marker. An arbitrarily long outage collapses to a single
# outstanding marker plus whatever arrived recently, which is the bound; the
# fact that something is owed survives, which is the meaning. The replacement is
# stamped NOW, so it cannot be swept on this run or the next, and if it ever is
# old enough to be swept it is coalesced again -- the debt has no way to reach
# zero except by being published.
PENDING_STALE="${SPARROW_PENDING_STALE:-3600}"
pending_sweep() {
  [ -d "$PENDING_DIR" ] || return 0
  _psw_found=0
  for _ps in "$PENDING_DIR"/*; do
    [ -f "$_ps" ] || continue
    _pg=$(file_age "$_ps")
    [ -n "$_pg" ] || continue
    if [ "$_pg" -ge "$PENDING_STALE" ] 2>/dev/null; then
      rm -f "$_ps" 2>/dev/null
      _psw_found=1
    fi
  done
  [ "$_psw_found" = 1 ] && mark_pending
  return 0
}

# --- THE PARENT'S NOTE ------------------------------------------------------
#
# `blocked — needs your input` is the one status that asks a HUMAN to act, and a
# child's boundaries must never erase it. Reviewer's sequence (2026-09-17):
# SubagentStart → Notification(permission_prompt) → SubagentStop posted
# `working (1 subagent: …)`, `blocked — needs your input`, then plain `working`
# — while the parent was still sitting on an unanswered dialog.
#
# So the condition is recorded in the state dir and every later note is composed
# ONTO it (`blocked — needs your input (2 subagents: …)`) rather than replacing
# it. Composing beats staying silent: the human still sees the ask, and the
# subagent list still answers "what is it doing while it waits" — and the 140
# cap degrades it gracefully when both are long.
#
# WHAT CLEARS IT is deliberately narrow: the next UserPromptSubmit, and the
# stop/idle path -- exactly where this hook already treats the condition as over.
# NOT a tool call, and not a subagent start or stop: a child running tools while
# the parent waits on a dialog is precisely the case that must not clear it.
status_base() {
  [ -f "$NEEDS_INPUT_FILE" ] && { printf 'blocked — needs your input'; return 0; }
  printf 'working'
}

# Delete markers too old to be real (hooks only; `sparrow skill status` is a
# read-only command and merely ignores them).
subagent_sweep() {
  [ -d "$SUBAGENT_DIR" ] || return 0
  for _sf in "$SUBAGENT_DIR"/*.json; do
    [ -f "$_sf" ] || continue
    _sa=$(file_age "$_sf")
    [ -n "$_sa" ] || continue
    if [ "$_sa" -ge "$SUBAGENT_STALE" ] 2>/dev/null; then
      mark_pending
      rm -f "$_sf" 2>/dev/null
      mark_pending
    fi
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

# THE CHEAP EXIT FOR A TOOL CALL THAT HAS NOTHING TO DO. Only the loop switch
# precedes it -- not even the pending-record bookkeeping below, which costs a
# `date` + `stat` per marker and has nothing to do on a call that posts nothing.
# `pre-tool` runs in front
# of EVERY tool call and `post-tool` after it, and inside the throttle window
# their usual answer is "nothing". Everything below -- the credential ladder (a
# `node` spawn over credentials.json), the blocked-marker listing, the lock --
# costs real time on that path. So the window is checked FIRST, with nothing but
# `stat`, and a call that will do nothing leaves here. It never stamps the
# throttle (only `throttled` does, once a refresh is really going to happen).
#
# It stands aside whenever the mode has more to do than the refresh:
#   * the idle marker stands -> the resume handshake (both modes);
#   * post-tool only: a usage-limit marker stands (its clearing reads the
#     transcript, before the credential gate); the note the backstop would
#     compose differs from the stamp (the backstop is deliberately unthrottled);
#     or a REPAIR is owed (pending markers, a divergent fan-out). The repair is
#     debt, not a refresh: pre-tool restamps the same throttle in front of every
#     call, so a repair gated on the window would wait for the Stop in a turn of
#     quick calls. Pre-tool never repairs; the post-tool that follows does.
# THE ONE THROTTLE PREDICATE: is <stamp> due, i.e. absent, unreadable, dated in
# the future, or at least <window> seconds old? `throttled`, `within_throttle`
# and the near-expiry rate limit all ask exactly this; only `throttle_stamp`
# writes.
throttle_due() {
  _td=$(file_age "$1")
  if [ -n "$_td" ] && [ "$_td" -lt "$2" ] 2>/dev/null; then return 1; fi
  return 0
}
throttle_stamp() {
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  : > "$1" 2>/dev/null || true
}
within_throttle() { ! throttle_due "$POST_STAMP" "$POST_THROTTLE"; }
# Is the last note publication close to its TTL? (One more `stat`.) Pre-tool
# refreshes such a note even inside the window -- see NOTE_REFRESH_AGE.
#
# THE BYPASS IS ITSELF RATE-LIMITED. The note stamp only moves on a SUCCESSFUL
# post, so during a server outage it stays past this age -- and an unlimited
# bypass would then run the whole credential/lock/fan-out path (seconds) in front
# of EVERY tool call. So each bypass stamps $NEAR_EXPIRY_STAMP whatever its
# outcome, and another may fire only a full throttle window later. And an `idle`
# stamp is never "near expiry": idle carries no TTL, and a refresh would only
# stand down (publish_refresh) after paying for the whole path.
NEAR_EXPIRY_STAMP="$STATE_DIR/auto-status-near-expiry"
note_near_expiry() {
  _ne=$(file_age "$NOTE_STAMP")
  [ -n "$_ne" ] && [ "$_ne" -ge "$NOTE_REFRESH_AGE" ] 2>/dev/null || return 1
  [ "$(cat "$NOTE_STAMP" 2>/dev/null || printf '')" != "$IDLE_STAMP" ] || return 1
  throttle_due "$NEAR_EXPIRY_STAMP" "$POST_THROTTLE"
}
# THE DRIFT TEST, one copy for its two callers (this cheap exit and post-tool's
# backstop): does the status we WOULD post differ from the one every room was
# last told? An ABSENT stamp is not a drift (nothing has ever been posted here,
# and a tool call must not start rewriting the status); an `idle` stamp means
# the turn ended and the resume handshake owns the comeback. It compares the
# FULL body, so a change in the parent's condition counts as much as a subagent
# appearing.
note_drifted() {
  _nd_body=$(compose_note "$(status_base)")
  _nd_prev=$(cat "$NOTE_STAMP" 2>/dev/null || printf '')
  [ -n "$_nd_prev" ] && [ "$_nd_prev" != "$IDLE_STAMP" ] && [ "$_nd_body" != "$_nd_prev" ]
}
# The answer, computed at most ONCE per post-tool run: each drift test composes
# the note, which stats every subagent marker. The cheap exit records what it
# found (and has already swept); the backstop reuses it, and asks afresh only
# when the cheap exit never looked. Nothing between the two can change the
# composition: the only intervening steps are the pending bookkeeping and the
# usage-limit clearing, neither of which the note is composed from.
DRIFT_KNOWN=""
SUBAGENTS_SWEPT=""
drifted_once() {
  case "$DRIFT_KNOWN" in
    yes) return 0 ;;
    no) return 1 ;;
  esac
  if note_drifted; then DRIFT_KNOWN=yes; return 0; fi
  DRIFT_KNOWN=no
  return 1
}
case "$MODE" in
  pre-tool)
    if [ ! -f "$IDLE_MARKER" ] && within_throttle && ! note_near_expiry; then exit 0; fi
    ;;
  post-tool)
    if [ ! -f "$IDLE_MARKER" ] && within_throttle && [ -z "$(blocked_markers | head -n 1)" ]; then
      subagent_sweep
      SUBAGENTS_SWEPT=1
      if ! drifted_once && ! repair_owed && [ ! -f "$PENDING_LEGACY" ]; then exit 0; fi
    fi
    ;;
esac

# Once per run, before anything reads the pending record: carry a legacy token
# across, and drop markers too old to be worth repairing. Both are local
# bookkeeping, so they run ahead of the credential and blocked gates -- a hook
# that cannot post must still not lose or hoard records. (A call that took the
# cheap exit above reads no pending record, so it skips this too.)
pending_migrate
pending_sweep

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
      # `sparrow await` stood down: the Claude Code session that armed it is
      # gone, or it was armed as a disowned `( ... & )` inside a foreground Bash
      # call -- online, but it could never have woken this session.
      orphaned | orphaned:*)
        cause="was orphaned (the Claude Code session that armed it is gone, or it was armed from a shell this session does not own)"
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
    _ag=$(payload_string agent_id | tr -cd 'A-Za-z0-9_-' | cut -c1-80)
    _ty=$(payload_string agent_type | tr -cd 'A-Za-z0-9_-' | cut -c1-60)
    if [ -n "$_ag" ]; then
      mark_pending
      mkdir -p "$SUBAGENT_DIR" 2>/dev/null || true
      printf '{"version":1,"agent":"%s","type":"%s","at":"%s"}\n' \
        "$_ag" "${_ty:-unknown}" "$(now_iso_ms)" > "$SUBAGENT_DIR/$_ag.json" 2>/dev/null || true
      mark_pending   # again: the mutation is COMPLETE, and this value proves it
    fi
    ;;
  subagent-stop)
    # Delete exactly THIS agent's marker, by name. An id with no marker is a
    # silent no-op (an older install, a swept phantom, a stop we never saw start).
    subagent_sweep
    _ag=$(payload_string agent_id | tr -cd 'A-Za-z0-9_-' | cut -c1-80)
    if [ -n "$_ag" ] && [ -f "$SUBAGENT_DIR/$_ag.json" ]; then
      mark_pending
      rm -f "$SUBAGENT_DIR/$_ag.json" 2>/dev/null
      mark_pending
    fi
    ;;
  post-tool)
    [ -n "$SUBAGENTS_SWEPT" ] || subagent_sweep
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

# WHOLE SECONDS LEFT IN THE PUBLICATION BUDGET, floored at 0. Every network step
# on the publication path sizes its own `--max-time` from this and refuses to
# start when it is 0, so the budget bounds the WORK IN FLIGHT and not merely the
# decision to begin a round (see THE PUBLICATION BUDGET below).
#
# A BROKEN CLOCK DEGRADES TO THE OLD BEHAVIOUR, NOT TO SILENCE: with no usable
# `date` the deadline cannot be evaluated at all, and reporting 0 would mean
# never posting anything again. So it reports the whole budget -- every call
# still gets a bounded `--max-time`, and the round cap is what stops the hook.
budget_left() {
  _bl_now=$(date +%s 2>/dev/null || printf 0)
  case "$_bl_now" in
    '' | *[!0-9]*) _bl_now=0 ;;
  esac
  if [ "$_bl_now" -eq 0 ]; then printf '%s' "${NOTE_BUDGET:-8}"; return 0; fi
  _bl=$(( ${NOTE_DEADLINE:-0} - _bl_now ))
  [ "$_bl" -lt 0 ] && _bl=0
  printf '%s' "$_bl"
}

# Fire a presence heartbeat (best-effort, tight timeout). Backgrounded so a turn
# is never delayed by the network.
#
# DELIBERATELY OUTSIDE THE BUDGET: it is backgrounded with its own tight 3s
# timeout and nothing waits on it mid-path, so it cannot push the publication
# past the deadline.
refresh_presence() {
  curl -fsS --max-time 3 -X POST "$server/api/v1/me/presence" \
    -H "authorization: Bearer $token" -H 'content-type: application/json' \
    -d "{\"ttlSeconds\":$PRESENCE_TTL}" >/dev/null 2>&1 &
}

# List my non-archived room ids (one per line, capped). Requires node to parse
# the JSON; without it we simply skip the status fan-out (best-effort).
#
# BUDGETED. With nothing left this makes NO REQUEST AT ALL rather than starting a
# 5s call the hook has no time for; otherwise it waits at most whatever is left.
#
# "NO ROOMS" AND "I COULD NOT FIND OUT" ARE DIFFERENT ANSWERS, and the exit
# status is what separates them. Empty output used to mean both, and once
# `post_status_all` started reporting completeness that ambiguity became a bug of
# exactly the kind the pending record exists to prevent: a failed listing looked
# like a fan-out with nothing to do, so the note was stamped as "every room has
# this" and every snapshotted marker was acknowledged -- on a publication that
# told nobody anything, with no record left that it had not.
#
# So: NON-ZERO whenever the listing could not be made -- no node, no budget, an
# empty body (a failed, refused or timed-out GET), or a body node could not
# parse. ZERO with empty output means one thing only: the listing succeeded and
# this profile genuinely has no non-archived rooms, which is vacuously complete.
room_ids() {
  command -v node >/dev/null 2>&1 || return 1
  _ri_left=$(budget_left)
  [ "$_ri_left" -gt 0 ] 2>/dev/null || return 1
  _ri_max=5
  [ "$_ri_left" -lt "$_ri_max" ] 2>/dev/null && _ri_max="$_ri_left"
  body=$(curl -fsS --max-time "$_ri_max" "$server/api/v1/me/rooms" \
    -H "authorization: Bearer $token" 2>/dev/null || true)
  [ -n "$body" ] || return 1
  # The assignment carries the substitution's exit status, so a parse failure
  # (node sets a non-zero exitCode) propagates instead of reading as "no rooms".
  _ri_out=$(printf '%s' "$body" | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      try {
        const j = JSON.parse(s);
        const items = Array.isArray(j.items) ? j.items : [];
        for (const it of items) {
          const r = it && it.room;
          if (r && r.id && !r.archivedAt) process.stdout.write(r.id + "\n");
        }
      } catch { process.exitCode = 1; }
    });' 2>/dev/null) || return 1
  [ -n "$_ri_out" ] && printf '%s\n' "$_ri_out"
  return 0
}

# Emit a JSON string for a note, hand-escaped so our hand-rolled body stays
# valid: strip double-quotes / backslashes / control chars, truncate to 50.
safe_note() {
  printf '%s' "$1" | tr -d '"\\' | tr '\r\n\t' '   ' | cut -c1-50
}

# Fan a body out to /rooms/<id>/status for each non-archived room (cap
# MAX_ROOMS), RE-CHECKING THE BUDGET BEFORE EVERY SINGLE POST.
#
# WHY IT REPORTS COMPLETENESS. One round used to be able to run a 5s room GET
# plus MAX_ROOMS sequential 4s POSTs -- 45s against Codex's binding 20s for the
# whole hook. Now the fan-out stops the moment the budget is gone, and a
# TRUNCATED fan-out is a different fact from a finished one: some rooms were
# never told, so nothing downstream may claim they were. That is what the exit
# status carries -- 0 COMPLETE (every room in the capped list was DELIVERED TO),
# 1 PARTIAL -- and it is why `post_note` will not stamp and `publish_rounds`
# will not acknowledge on a 1.
#
# DELIVERED, NOT ATTEMPTED. The count used to increment under a `curl ... ||
# true`, so a fan-out whose every write was refused reported COMPLETE and the
# stamp claimed rooms had been told that never heard anything (reviewer,
# 2026-09-18: a valid one-room listing whose status POST exits 22). `-f` already
# makes an HTTP error status a curl failure, so the test is simply whether curl
# exited 0; a transport error, a timeout and a 500 are all "this room was not
# told". NOTHING IS RETRIED HERE -- the pending record is the retry mechanism,
# and retrying inside the loop would spend the budget the other rooms need.
#
# AND A DIVERGENT FAN-OUT IS RECORDED ON DISK ($NOTE_DIVERGED), because it is a
# fact that outlives this process -- see WHEN THE ROOMS DISAGREE below.
#
# THE LOOP RUNS IN THIS SHELL, NOT A SUBSHELL. It used to be `room_ids | while`,
# and a pipeline's loop body is a subshell that cannot report anything back --
# which is precisely why the old truncation was invisible. So the list is
# captured first and the loop is driven from a heredoc redirect instead. (A temp
# file to smuggle the count back out would be the same bug wearing a hat.)
post_status_all() {
  _ps_body="$1"
  [ "$(budget_left)" -gt 0 ] 2>/dev/null || return 1   # no budget: nothing was told
  # A LISTING THAT FAILED IS A PARTIAL FAN-OUT, not an empty one. Without the
  # rooms there is no way to tell anybody anything, so nothing may be stamped and
  # nothing may be acknowledged. (One call site, and a plain assignment with a
  # command substitution carries that substitution's status -- so this is the
  # whole of the plumbing.)
  _ps_rooms=$(room_ids) || return 1
  # How many rooms this fan-out is RESPONSIBLE for: the list, capped. Counted
  # here so "was every one of them attempted" has an answer at the end.
  _ps_total=0
  while IFS= read -r rid; do
    [ -n "$rid" ] || continue
    _ps_total=$((_ps_total + 1))
    if [ "$_ps_total" -ge "$MAX_ROOMS" ]; then break; fi
  done <<EOF
$_ps_rooms
EOF
  _ps_n=0
  _ps_sent=0
  _ps_any=0
  while IFS= read -r rid; do
    [ -n "$rid" ] || continue
    _ps_n=$((_ps_n + 1))
    [ "$_ps_n" -le "$MAX_ROOMS" ] || break
    _ps_left=$(budget_left)
    [ "$_ps_left" -gt 0 ] 2>/dev/null || break
    _ps_max=4
    [ "$_ps_left" -lt "$_ps_max" ] 2>/dev/null && _ps_max="$_ps_left"
    # DIVERGENCE IS MARKED BEFORE THE FIRST OUTCOME IS KNOWN, not after a
    # confirmed delivery -- see WHEN THE ROOMS DISAGREE. From this line on, a
    # write is in flight and the rooms MAY disagree; only a fan-out that
    # confirms delivery everywhere can say they do not.
    if [ "$_ps_any" = 0 ]; then
      _ps_any=1
      mkdir -p "$STATE_DIR" 2>/dev/null || true
      : > "$NOTE_DIVERGED" 2>/dev/null || true
    fi
    # Counted only on a 0 exit: with `-f`, that means the room actually took it.
    if curl -fsS --max-time "$_ps_max" -X POST "$server/api/v1/rooms/$rid/status" \
      -H "authorization: Bearer $token" -H 'content-type: application/json' \
      -d "$_ps_body" >/dev/null 2>&1; then
      _ps_sent=$((_ps_sent + 1))
    fi
  done <<EOF
$_ps_rooms
EOF
  if [ "$_ps_sent" -eq "$_ps_total" ] 2>/dev/null; then
    # Every room in the capped list took this body, so no room disagrees with
    # the stamp that is about to be written. That holds VACUOUSLY when the list
    # was empty: a successful listing that found no rooms means there is no room
    # to disagree, and it would be incoherent to stamp "every room was told
    # this" (which `post_note` does for the same reason) while still claiming
    # some room was not. RESIDUAL, named: a room that diverged and was then
    # archived or left, and later returns, is not tracked -- per-room truth
    # would need per-room state, which this design deliberately does not keep.
    rm -f "$NOTE_DIVERGED" 2>/dev/null || true
    return 0
  fi
  # NOT EVERY ROOM CONFIRMED IT. The divergence flag was already set above, the
  # moment the first write went out, and it stays set: see WHEN THE ROOMS
  # DISAGREE for why a failed response is not evidence that nothing landed.
  return 1
}

# Post a composed note to every room AND remember the subagent part of it, so
# the post-tool backstop can tell "the composition changed" from "somebody else
# wrote a different note". (A same-note repost is free server-side: `sinceAt` is
# preserved when the text is identical, so this stamp is a network optimisation,
# not a correctness dependency.)
#
# A PARTIAL FAN-OUT DOES NOT STAMP. The stamp means "this is what EVERY room was
# last told", and the post-tool backstop trusts it to decide whether anything
# drifted; writing it after a truncated fan-out would tell the backstop that
# rooms which never heard the note are up to date, and nothing would ever repair
# them. So a truncated publication returns 1, leaves the stamp alone, and (via
# `publish_rounds`) leaves the pending markers standing for a later hook.
#
# STICKY ONLY WHERE A HUMAN MUST SEE IT (see A BOUNDED `working` in the header):
# an unanswered ask. (The usage-limit notes are posted sticky directly.) A
# running subagent is NOT a reason: the parent's PreToolUse/PostToolUse fire for
# the subagent's own tool calls (observed: the throttle stamp kept moving while
# only subagents ran), so the refresh keeps its note alive -- and a marker
# orphaned by a missed SubagentStop (a session killed mid-subagent) would
# otherwise hold a sticky `working (1 subagent: ...)` for SUBAGENT_STALE, 12h.
note_is_held() {
  [ -f "$NEEDS_INPUT_FILE" ]
}
post_note() {
  if note_is_held; then
    _pn_life='"sticky":true'
  else
    _pn_life="\"ttlSeconds\":$WORKING_TTL"
  fi
  post_status_all "{\"state\":\"working\",\"note\":\"$(safe_json "$1")\",$_pn_life}" || return 1
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  printf '%s' "$1" > "$NOTE_STAMP" 2>/dev/null || true
}

# THE POST-TOOL REFRESH: re-post exactly what every room was last told, so a
# TTL'd `working` outlives a long turn and lapses on its own within
# $WORKING_TTL of the last tool call when no Stop ever comes. The TEXT is the
# stamp's, never recomposed: an unchanged note keeps its `sinceAt` server-side,
# and a drifted composition is the backstop's business, not this function's.
#
# Under the lock like every publication, and it stands down whenever the
# turn's end is owed or already published: a refresh must never resurrect an
# idle, and an absent stamp means nothing was ever posted from here.
publish_refresh() {
  [ -f "$IDLE_OWED" ] && return 0
  _rf_prev=$(cat "$NOTE_STAMP" 2>/dev/null || printf '')
  [ -n "$_rf_prev" ] && [ "$_rf_prev" != "$IDLE_STAMP" ] || return 0
  post_note "$_rf_prev" || return 0
}

# Strip anything that would break the hand-rolled JSON body (the composed note
# is the only note here that is not a literal).
safe_json() { printf '%s' "$1" | tr -d '"\\' | tr '\r\n\t' '   '; }

# COMPOSE AND POST AS ONE STEP, AND LEAVE THE DIRECTORY'S TRUTH BEHIND.
#
# THE RACE (reviewer, 2026-09-17): `subagent-start(A)` composed "1 agent", then
# stalled inside its `GET /me/rooms`; `subagent-start(B)` completed and posted "2
# agents"; A was released and posted -- and STAMPED -- "1 agent" last, while both
# markers existed. Nothing ordered mutation, composition and post, and the
# post-tool backstop cannot save it: a foreground parent runs no tool call until
# the child finishes, which is exactly when this indicator is meant to be
# working.
#
# TWO MECHANISMS, because either alone loses:
#   1. A LOCK (`mkdir`, the POSIX atomic-create primitive available to sh) so two
#      hooks cannot interleave compose-and-post. Bounded wait: a hook that cannot
#      get in posts NOTHING and stamps NOTHING rather than posting a body it
#      composed long ago -- a loser must never leave the stamp claiming a stale
#      note.
#
#      A LOCK IS BROKEN ON DEATH, NEVER ON AGE -- the same rule the arming lock
#      settled on, and rejected an age rule for, for the same reason: age is a
#      guess about a process, and it guesses wrong exactly when it matters. A
#      legitimate fan-out across many rooms can outlast any timer, and a timer
#      would then hand the lock to a waiter while the holder is still posting --
#      two concurrent posts, older one possibly last, which is the race the lock
#      exists to stop. So the holder writes its pid into the lock, and a waiter
#      breaks it only on PROOF the holder is gone. A live pid, an EPERM, a
#      missing or unreadable pid file: no proof, no break, and the waiter gives
#      up its attempt like any other loser.
#   2. RE-COMPOSE AFTER POSTING, and post again while the picture keeps changing
#      (bounded). That is what makes a stale snapshot unable to win even when the
#      other hook gave up waiting: whoever holds the lock last is responsible for
#      the final state, and it checks the directory AFTER its write rather than
#      trusting what it read before the network.
# The combination cannot be defeated by the same interleaving: every mutation
# happens before its own hook tries the lock, so the final holder either sees it
# while composing, or sees it in the re-check and posts again.
# THE LOCK IS THE KERNEL'S.
#
# A reclamation protocol cannot be made atomic in shell: "read the holder's pid,
# prove it dead, remove the lock" is not a compare-and-delete, so two reclaimers
# can both prove the same holder dead and both take it -- and re-reading a token
# just before the unlink narrows that window without closing it. (Age-based
# breaking is worse still: a legitimate fan-out across many rooms outlasts any
# timer, and then a LIVE holder loses its lock.) So the lock file is a stable
# inode that is never unlinked, `flock` holds it, and the kernel releases it
# however the holder ends -- exit, SIGKILL, container stop. Nothing to reclaim,
# nothing to go stale.
#
# WAITING IS THEREFORE SAFE, so a loser QUEUES instead of abandoning: on
# acquiring it composes fresh and posts only if the body differs from the stamp,
# so a queue of waiters collapses to at most one extra post. The wait is still
# bounded, per mode -- a UserPromptSubmit sits in the human's critical path and
# waits briefly; a subagent boundary or a tool call can afford longer.
#
# WITHOUT `flock` (probed, never assumed) THERE IS NO LOCK AT ALL. A lock with no
# safe reclamation is worse than none. Two concurrent hooks can then interleave,
# and it is CONVERGENCE -- compose immediately before posting, re-check after,
# repeat -- plus the pending records that correct the note; a stale note can
# persist until the next hook runs. That is honest, and it cannot wedge anything.
post_composed() { post_composed_with publish_rounds "${1:-}"; }

post_composed_with() {
  _pc_publish="$1"
  _pc_override="${2:-}"
  if command -v flock >/dev/null 2>&1; then
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    if : >> "$NOTE_LOCK_FILE" 2>/dev/null; then
      exec 9>> "$NOTE_LOCK_FILE"
      # Never wait past the deadline: the wait is a sub-limit, not an extra.
      _pc_wait="${NOTE_LOCK_WAIT:-5}"
      _pc_left=$(( NOTE_DEADLINE - $(date +%s 2>/dev/null || echo 0) ))
      [ "$_pc_left" -lt 0 ] 2>/dev/null && _pc_left=0
      [ "$_pc_wait" -gt "$_pc_left" ] 2>/dev/null && _pc_wait="$_pc_left"
      flock -w "$_pc_wait" 9 2>/dev/null
      _pc_rc=$?
      if [ "$_pc_rc" -eq 0 ]; then
        "$_pc_publish" "$_pc_override"
        exec 9>&- 2>/dev/null || true
        return 0
      fi
      exec 9>&- 2>/dev/null || true
      # CONTENTION (flock's exit 1) means somebody else is publishing: post
      # nothing, stamp nothing, leave the markers for them. ANY OTHER failure means
      # the lock is unusable here -- a read-only state dir, an fd problem, NFS
      # without locking -- and that must degrade to the unlocked path, exactly
      # like a host with no flock at all. Failing every publication because the
      # lock is broken would be worse than publishing unordered.
      [ "$_pc_rc" -eq 1 ] && return 1
    fi
  fi
  "$_pc_publish" "$_pc_override"
}

# (IDLE_STAMP, what the stamp holds after an `idle` publication, is defined with
# the other state paths near the top: the cheap tool-call exit reads it too.)

# `idle` goes through the same ordered path as every other publication. It is
# trivially composed (idle supersedes any note), but ORDERING IS NOT OPTIONAL:
# posting it outside the lock let an older `working (1 subagent: ...)`, held in a
# slow fan-out, land after the turn had ended and resurrect it.
#
# IT USES THE SAME BOUNDED FAN-OUT as every other publication, and treats a
# truncated one the same way: no stamp, nothing acknowledged, and `IDLE_OWED`
# left standing so the next hook finishes the job. THAT IS DELIBERATE on the
# flag as well as the markers: if some rooms never heard idle, the turn's end is
# still owed to them, so the intent has to outlive this attempt too.
#
# IT ACKNOWLEDGES BY SNAPSHOT, like everything else in this file. It used to
# clear the WHOLE directory, and that was the original compare-and-delete
# mistake surviving in the one place a bulk clear was left (reviewer,
# 2026-09-18): a `permission_prompt` arriving while a held `stop` was inside its
# room GET wrote its own markers and cleared the idle intent correctly, and then
# the stop's bulk clear deleted markers it had never covered -- leaving `idle`
# standing while a human was being asked to act, with nothing on disk owed.
# Idle genuinely answers every mutation that existed BEFORE it was composed,
# because idle supersedes any composed note; it answers nothing that arrived
# afterwards, and the snapshot is exactly that distinction.
#
# THE INTENT IS READ AS LATE AS IT CAN BE, immediately before dispatch, when
# this publication exists only because the flag said so ($1 = owed). An ask that
# has already cancelled the intent therefore wins outright rather than being
# published over and corrected afterwards. Once the fan-out IS in flight that is
# no longer possible, and the honest outcome is a visible idle-then-blocked
# transition that the next round corrects -- a race resolving in the open. There
# is no retroactive cancellation here and none is implied anywhere.
#
# THE FLAG IS CLEARED ONLY WHEN NOTHING IS OUTSTANDING. Another `stop` can write
# its own intent (and its own markers) while this fan-out runs, and removing the
# flag unconditionally would drop that one exactly the way the bulk clear
# dropped markers. If anything is still owed, the flag stands and the next round
# decides afresh.
#
# Returns: 0 published, 1 incomplete (flag and markers stand), 2 stood down
# because the intent was cancelled before dispatch.
publish_idle() {
  _pi_why="${1:-}"
  _pi_names=$(pending_names)
  [ "$_pi_why" = owed ] && [ ! -f "$IDLE_OWED" ] && return 2
  post_status_all '{"state":"idle"}' || return 1
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  printf '%s' "$IDLE_STAMP" > "$NOTE_STAMP" 2>/dev/null || true
  pending_ack "$_pi_names"
  pending_any || rm -f "$IDLE_OWED" 2>/dev/null || true
  return 0
}

# The direct idle path, now used by ONE caller: the `idle_prompt` notification.
# It never sets $IDLE_OWED -- the turn ended long before (a stop already ran),
# nothing is racing it, and there is no intent for a later round to reconsider --
# so it publishes idle once, ordered by the lock like everything else. The `stop`
# mode deliberately does NOT come through here: it records the intent and goes
# through `publish_rounds`, which can reconcile what lands mid-fan-out.
post_idle() { post_composed_with publish_idle; }

# The critical section: compose the WHOLE desired status from current state --
# the parent's condition, the subagent set, the usage-limit gate -- post it if it
# differs from what was last posted, and go round again while anything changed
# underneath. Watching only the subagent list could not see the parent become
# blocked, which left an unanswered permission prompt invisible.
publish_rounds() {
  _pr_override="$1"
  _pr_round=0
  while [ "$_pr_round" -lt 3 ]; do
    # Out of budget: stop here and leave the markers standing. The round cap
    # bounds the work; this bounds the TIME, against the 20s Codex allows the
    # whole hook. (Each network step re-checks it too -- see `budget_left`.)
    [ "$(budget_left)" -gt 0 ] 2>/dev/null || return 0
    # A usage limit landing mid-flight outranks everything here.
    [ -n "$(blocked_markers | head -n 1)" ] && return 0
    # IDLE IS OWED, NOT INTENDED (see the `stop` mode). The flag is durable state
    # written before the stop even tries to publish, so whoever gets here next is
    # the one that owes idle: a holder that was mid-fan-out when the turn ended
    # sees it on its next round, and a queued publisher honours a stop whose own
    # lock wait expired. Composing a `working` note now would resurrect a
    # finished turn.
    #
    # IT IS AN ORDINARY ROUND OUTCOME, NOT AN EXIT. Publishing idle and returning
    # made this loop unable to reconcile anything that arrived during the idle
    # fan-out -- and for the `stop` mode, which the repair step deliberately
    # skips, "unable" meant "never". So idle publishes, acknowledges its own
    # snapshot, and the loop GOES ROUND AGAIN: the next round re-reads the flag
    # (an ask may have cancelled it), composes against a stamp that now reads
    # `idle`, and publishes the truth. The round cap bounds the whole thing.
    #
    # The "never post a body composed before the last publication" guard below is
    # stable across that hand-off: the only thing that moved the stamp is our own
    # `publish_idle`, in this process, before this round composed anything --
    # checked, not assumed.
    if [ -f "$IDLE_OWED" ]; then
      publish_idle owed
      _pr_rc=$?
      # Incomplete: rooms are still owed the end of the turn, and so is the note.
      [ "$_pr_rc" -eq 1 ] && return 0
      # Published, and nothing arrived while it ran: done.
      [ "$_pr_rc" -eq 0 ] && { pending_any || return 0; }
      # rc 2 means the intent was cancelled before dispatch; either way, go round
      # and decide again from what is on disk now.
      _pr_round=$((_pr_round + 1))
      continue
    fi
    # THE SNAPSHOT: the names on disk BEFORE anything is read or composed. What
    # this body publishes is exactly what these names were owed.
    _pr_names=$(pending_names)
    # THE BASE IS READ FRESH EVERY ROUND. An override only supplies the note TEXT
    # that nothing but the payload knows (the verbose prompt note); it must never
    # outrank a parent condition that arrived since. So it is used only while the
    # current base is the ordinary `working` one -- if the parent became blocked
    # while we were posting, the ask wins and the override is dropped.
    _pr_base=$(status_base)
    if [ -n "$_pr_override" ] && [ "$_pr_base" = working ]; then _pr_base="$_pr_override"; fi
    _pr_body=$(compose_note "$_pr_base")
    _pr_prev=$(cat "$NOTE_STAMP" 2>/dev/null || printf '')
    # NEVER POST A BODY THAT WAS COMPOSED BEFORE THE LAST PUBLICATION. If the
    # stamp moved while we were composing -- the case that matters being an
    # `idle` published by a turn that ended under us -- this body describes a
    # world that no longer exists, and posting it would resurrect a finished
    # turn. Re-read and go round again instead. (Inside the lock this is
    # belt-and-braces; on the unlocked degraded path it is the only guard there
    # is. Neither can help a fan-out already in flight: that is what the lock is
    # for, and why the degraded path is documented as best-effort.)
    if [ "$(cat "$NOTE_STAMP" 2>/dev/null || printf '')" != "$_pr_prev" ]; then
      _pr_round=$((_pr_round + 1))
      continue
    fi
    # POST WHEN THE BODY CHANGED, OR WHEN THE STAMP IS NOT TRUE OF EVERY ROOM.
    # The second case is the one a single global stamp cannot see: after a
    # divergent fan-out the stamp describes neither group of rooms, so "body
    # equals stamp" is not evidence that anybody already has it (see WHEN THE
    # ROOMS DISAGREE). Posting is what heals the rooms that were left behind.
    if [ "$_pr_body" != "$_pr_prev" ] || [ -f "$NOTE_DIVERGED" ]; then
      # A TRUNCATED PUBLICATION ACKNOWLEDGES NOTHING: some rooms never heard it,
      # so every snapshotted mutation is still owed and stays on disk.
      post_note "$_pr_body" || return 0
    fi
    # Acknowledge from the SNAPSHOT, by name, whether or not a post was needed:
    # a body identical to the stamp still means every room already has it.
    # Anything stamped since has a name that was never in the list, so it
    # survives and a later hook repairs it.
    pending_ack "$_pr_names"
    pending_any || return 0
    _pr_round=$((_pr_round + 1))
  done
  # Out of rounds with markers still on disk: left standing on purpose.
  return 0
}

# THE `stop` MODE'S PUBLISHER: the ordinary rounds, behind one guard.
#
# Going through `publish_rounds` is what lets a stop reconcile whatever landed
# during its own idle fan-out (see the `stop` mode). But the rounds decide what
# to publish from the FLAG, and by the time this hook finally holds the lock the
# flag may be gone -- either another publisher honoured the intent on our behalf
# (it publishes idle when it sees the flag, exactly as designed), or a prompt or
# an ask cancelled it because the turn came back to life.
#
# In both cases this invocation has nothing left to say, and saying something
# would be actively wrong: `publish_rounds` with no flag composes a `working`
# note, which would resurrect a turn that has ended or contradict the prompt
# that revived it. So a stop that arrives to find the intent already resolved
# stands down, and posts nothing.
#
# The guard reads the flag AFTER the lock is held, which is the latest point at
# which standing down is still free.
publish_stop() {
  [ -f "$IDLE_OWED" ] || return 0
  publish_rounds "$@"
}

# THE IDLE→WORKING RESUME HANDSHAKE, shared by `pre-tool` and `post-tool`: a
# turn started by a monitor event or task notification has NO UserPromptSubmit,
# so without this the whole autonomous turn runs under the last stop's `idle`
# and the agent reads as doing nothing while it works. The stop mode leaves a
# marker; the FIRST hook of the next turn's first tool call restores `working`,
# consumes it, and exits. Without the marker it returns and the caller goes on.
resume_handshake() {
  [ -f "$IDLE_MARKER" ] || return 0
  # Same reasoning as the prompt mode: the turn has resumed, so idle is no
  # longer owed, and that has to be true BEFORE `publish_rounds` looks.
  rm -f "$IDLE_MARKER" "$IDLE_OWED" 2>/dev/null || true
  refresh_presence
  # NOT a clearing point: a tool call is not evidence the parent's ask was
  # answered (a child doing tool calls while the parent waits is the case).
  post_composed
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  : > "$POST_STAMP" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}

# THE TOOL-CALL REFRESH, shared by `pre-tool` and `post-tool` (and one throttle
# stamp, so the pair costs one refresh per window, not two). Presence, plus the
# TTL refresh of the note: the SAME text re-posted (so `sinceAt` is kept), and
# only once the last publication is itself at least a throttle window old -- a
# note the prompt posted a second ago needs no help yet. `publish_refresh` stands
# down when the stamp is absent or idle, or idle is owed.
tool_refresh() {
  # Pre-tool does not wait out the window for a note close to its TTL.
  if [ "$MODE" = pre-tool ] && note_near_expiry; then
    throttle_stamp "$POST_STAMP"
    throttle_stamp "$NEAR_EXPIRY_STAMP"   # one bypass per window, whatever happens next
  else
    throttled "$POST_STAMP" "$POST_THROTTLE" || exit 0
  fi
  refresh_presence
  # PRESENCE KEEPS THE 20s CADENCE; THE NOTE DOES NOT NEED IT. A 600s note
  # re-posted every window cost a room listing plus one POST per room (ten
  # rooms: eleven requests per 20s). It is re-posted from half its TTL, and the
  # near-expiry rule above is the backstop for a call that starts just short
  # of that.
  _nage=$(file_age "$NOTE_STAMP")
  if [ -n "$_nage" ] && [ "$_nage" -ge "$NOTE_REPOST_AGE" ] 2>/dev/null; then
    post_composed_with publish_refresh
  fi
}

# Throttle a mode via a state-dir stamp file: succeed (and re-stamp) at most once
# per $2 seconds. Returns 0 to proceed, 1 to skip.
throttled() {
  throttle_due "$1" "$2" || return 1
  throttle_stamp "$1"
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

# THE PUBLICATION BUDGET, measured against the TIGHTEST harness that runs this
# script, not the loosest:
#   * CODEX registers these same modes with EXPLICIT per-hook timeouts
#     (packages/skill/src/provider-codex.ts): UserPromptSubmit 20s, PreToolUse
#     20s, PostToolUse 20s, Stop 30s. 20 SECONDS IS THE BINDING LIMIT, and
#     PreToolUse is the tightest path under it: it blocks the tool from even
#     starting, which is why it also waits at most 2s for the lock and why its
#     throttled case exits before any of this (see THE CHEAP EXIT).
#   * Claude Code sets none, and its default for a command hook is 600s
#     (`e.timeout ? e.timeout*1000 : 600000`, read out of the 2.1.272 bundle).
# So the whole publication path -- waiting for the lock, the room fan-out, and
# every round -- lives inside ONE deadline of 8s, leaving ~12s of the Codex
# budget for the rest of the hook (credential lookup, presence, sweeps). The lock
# wait is a sub-limit of it, never an extra: a `UserPromptSubmit` sits in the
# critical path between a human typing and an answer, so it waits at most 2s; any
# other mode waits at most 5s. A hook that reaches the deadline stops and leaves
# the pending markers standing, exactly like any other budget exhaustion.
#
# THE DEADLINE BOUNDS EVERY STEP, NOT JUST THE DECISION TO START A ROUND. It used
# to be consulted only at round entry, so a round that began with one second left
# could still run a 5s room GET followed by up to MAX_ROOMS sequential 4s POSTs --
# 45s of work inside an "8s" budget, and more than twice Codex's whole-hook
# limit. Now `budget_left` is re-read before the room GET and before EVERY room
# POST: each sizes its own `--max-time` from what is left, and a step with
# nothing left is not started at all. The fan-out that stops early says so (see
# `post_status_all`), so nothing downstream claims rooms were told when they
# were not. Presence is the one deliberate exception -- backgrounded, its own 3s
# timeout, nothing waits on it.
NOTE_BUDGET="${SPARROW_NOTE_BUDGET:-8}"
# ONE deadline for the whole hook, not one per call: the mode's own post and the
# repair step at the end SHARE it, so a slow hook cannot spend the budget twice.
NOTE_DEADLINE=$(( $(date +%s 2>/dev/null || echo 0) + NOTE_BUDGET ))
case "$MODE" in
  # Both sit in a critical path: a human waiting for an answer, a tool call
  # waiting to start.
  prompt | pre-tool) NOTE_LOCK_WAIT=2 ;;
  *) NOTE_LOCK_WAIT=5 ;;
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
    # A prompt is the parent moving on: whatever it was waiting for is over.
    if [ -f "$NEEDS_INPUT_FILE" ]; then
      mark_pending
      rm -f "$NEEDS_INPUT_FILE" 2>/dev/null || true
      mark_pending
    fi
    # THE TURN HAS RESUMED, SO NEITHER IDLE FILE MAY OUTLIVE THIS POINT -- and
    # both are cleared BEFORE the publication, not after it. `IDLE_OWED` is read
    # by `publish_rounds` at the top of every round: a stop that failed to
    # publish would otherwise make this prompt post `idle` and return, leaving a
    # working turn advertised as idle until the next tool call.
    rm -f "$IDLE_MARKER" "$IDLE_OWED" 2>/dev/null || true
    # Whoever is running under this turn goes in the note too (capped at 140).
    refresh_presence
    post_composed "$note"
    ;;
  subagent-start | subagent-stop)
    # POST THE NOTE HERE, not only at turn boundaries, so the summary changes at
    # the boundary rather than at the next refresh. The cost is the `sinceAt`
    # reset named above.
    refresh_presence
    post_composed
    rm -f "$IDLE_MARKER" 2>/dev/null || true
    ;;
  notification)
    case "$ntype" in
      permission_prompt | elicitation_dialog | elicitation_url_dialog | agent_needs_input)
        # A human is being asked something — we are stuck until they answer. The
        # condition outlives this hook (see THE PARENT'S NOTE), so it is recorded
        # rather than only posted.
        #
        # AND IT CANCELS WHAT IDLE WAS OWED, for the same reason a prompt does: a
        # dialog cannot be open on a turn that has ended, so being asked is proof
        # the turn is live. Without this, a stop whose publication failed left
        # `IDLE_OWED` standing and the next publisher posted `idle` instead of
        # the ask -- and nothing could put it right afterwards: the post-tool
        # backstop cannot run, because the tool call is blocked on the very
        # dialog nobody has answered. The status would then read `idle` for
        # exactly as long as a human is being asked to act. That is the failure
        # THE PARENT'S NOTE exists to prevent, reached by another road, and it is
        # reachable: an autonomous turn resumes with no UserPromptSubmit and its
        # first tool call needs permission, so the Notification is the turn's
        # FIRST hook.
        #
        # WHAT THIS DOES AND DOES NOT PROMISE. Clearing the flag wins outright
        # whenever it happens before an idle fan-out dispatches -- `publish_idle`
        # re-reads the intent immediately before it posts for exactly that
        # reason. Once idle IS in flight, this does not reach back and stop it:
        # the room shows idle and the following round posts the ask over it. A
        # brief idle-then-blocked transition is the honest outcome of a race that
        # resolved the other way, and no cancellation of an in-flight publication
        # is implied here or anywhere else.
        #
        # The unlink sits INSIDE the double stamp with the mutation it belongs
        # to, so the record of it survives a publication that cannot complete --
        # and since `publish_idle` acknowledges by snapshot, an idle already in
        # flight can no longer delete these markers either.
        #
        # NOT WIDENED TO THE SUBAGENT BOUNDARIES, deliberately: a subagent
        # boundary racing a stop is exactly the holder that finding 2's fix
        # relies on to honour the flag.
        mark_pending
        mkdir -p "$STATE_DIR" 2>/dev/null || true
        printf '%s\n' "$(now_iso_ms)" > "$NEEDS_INPUT_FILE" 2>/dev/null || true
        rm -f "$IDLE_OWED" 2>/dev/null || true
        mark_pending
        refresh_presence
        post_composed
        rm -f "$IDLE_MARKER" 2>/dev/null || true
        ;;
      quota_auto_resume_fired)
        # Back to work. The markers are already gone (above); the resume
        # handshake in post-tool takes it from here.
        qt=$(payload_value quota_type)
        note="working"
        [ -n "$qt" ] && note="working (quota $(safe_field "$qt" 30) resumed)"
        refresh_presence
        # Ordinary work again, so the ordinary bounded lifetime: the resumed
        # turn's own hooks keep it alive, and it lapses if none follows.
        post_status_all "{\"state\":\"working\",\"note\":\"$note\",\"ttlSeconds\":$WORKING_TTL}"
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
        rm -f "$NEEDS_INPUT_FILE" 2>/dev/null || true
        post_idle
        mkdir -p "$STATE_DIR" 2>/dev/null || true
        [ -f "$IDLE_MARKER" ] || : > "$IDLE_MARKER" 2>/dev/null || true
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  post-tool)
    resume_handshake
    # THE BACKSTOP. If the status we WOULD post differs from the one last
    # posted -- a subagent hook that failed, an install predating them, a marker
    # swept for age, or the parent becoming blocked -- put the truth back.
    # Deliberately NOT throttled: it fires only on a real change, and the
    # comparison is local and free. `note_drifted` is the one drift test, shared
    # with the cheap exit so the two can never disagree about what drifted, and
    # `drifted_once` reuses the cheap exit's answer rather than paying twice.
    if drifted_once; then
      refresh_presence
      post_composed
      mkdir -p "$STATE_DIR" 2>/dev/null || true
      : > "$POST_STAMP" 2>/dev/null || true
      wait 2>/dev/null || true
      exit 0
    fi
    # THE REPAIR, BEFORE THE THROTTLE. Owed debt is not a refresh: pre-tool
    # restamps the throttle in front of every call, so a repair left behind
    # `throttled || exit 0` would wait for the Stop in a turn of quick calls.
    # (The repair step at the bottom still runs when the refresh did; it finds
    # nothing owed by then.)
    repair_owed && post_composed
    tool_refresh
    ;;
  pre-tool)
    # THE SAME HANDSHAKE AND REFRESH AT THE START OF THE CALL. With only the
    # post-tool ones, a single tool call longer than the TTL (a 600s Bash call, a
    # Monitor wait, a long build) let `working` lapse mid-turn until the call
    # returned -- and a monitor-triggered turn whose FIRST call is long read as
    # idle for the whole of it. The handshake is idempotent across the pair:
    # whichever runs first consumes the marker. Nothing else here: no backstop,
    # no marker clearing, no repair step, and never any stdout.
    resume_handshake
    tool_refresh
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
    # The turn is over, so a pending ask is over with it — and the composed
    # working note is superseded by `idle`, so there is nothing left to repair.
    rm -f "$NEEDS_INPUT_FILE" 2>/dev/null || true
    # IDLE IS OWED, NOT MERELY INTENDED.
    #
    # Reviewer, 2026-09-18: a `subagent-start` held inside its locked room GET
    # for longer than this mode's lock wait made the stop return WITHOUT posting
    # idle; the holder was then released and published `working (1 subagent: …)`,
    # and no idle publisher remained. The intent to go idle existed only as this
    # one process's plan, so when the process gave up, the intent vanished with
    # it and nothing could recover it.
    #
    # So the intent is written to disk FIRST, and it is a mutation like any
    # other: stamped before and after, so a publisher that never gets to act on
    # the flag still leaves a record that somebody must.
    #
    # THE ORDERING ARGUMENT. The flag lands at T0; only then does this mode wait
    # up to NOTE_LOCK_WAIT for the lock. A holder that checks the flag after T0
    # sees it and publishes idle itself. A holder that checks BEFORE T0 must
    # release the lock before T0 + wait, or it would still be holding it when the
    # wait began -- so either this stop acquires the lock itself, or some later
    # hook finds the flag and publishes. Either way the intent survives the
    # process that formed it.
    #
    # RESIDUAL, named rather than hidden: on the degraded no-flock path there is
    # no lock to serialise anything, so a stop racing a holder can still have its
    # `idle` overtaken by the holder's `working`, which then stands until the
    # next turn's first hook. That is the same honest limitation the unlocked
    # path carries everywhere else.
    #
    # AND IT PUBLISHES THROUGH THE ORDINARY LOOP, not a private idle path. The
    # flag is what tells `publish_rounds` that idle is the right publication, so
    # this mode has nothing special left to say -- and going through the loop is
    # what lets a mutation that lands DURING the idle fan-out be reconciled in
    # the following round. On the private path it could not be: the repair step
    # at the bottom is skipped for this mode, so there was nothing after the
    # fan-out at all. `publish_stop` is that loop plus the one guard the change
    # needs -- stand down if the intent is already resolved by the time we hold
    # the lock.
    mark_pending
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    : > "$IDLE_OWED" 2>/dev/null || true
    mark_pending
    post_composed_with publish_stop
    : > "$IDLE_MARKER" 2>/dev/null || true
    ;;
  *)
    exit 0
    ;;
esac

# THE REPAIR STEP. Anything still owed on disk means the note is not yet true of
# the world, so this hook publishes it — whatever its own mode was, and even if
# that mode would not otherwise post. TWO KINDS OF DEBT, both durable: a marker
# (somebody's mutation never reached the note) and the divergence flag (a
# publication reached only some rooms, so the stamp is true of none of them).
# The second needs its own answer because a later publisher can compose a body
# that equals the stamp and would otherwise stand down. (And if `IDLE_OWED` is
# what is outstanding, `publish_rounds` turns this into the idle publication a
# stop could not make.)
#
# Skipped where the intended state is `idle` (a stop, or the idle notification):
# both publish through the loop themselves, and for `stop` that loop now also
# reconciles whatever landed during its fan-out. Skipped for `pre-tool` too: it
# runs in front of every tool call, so it stays a cheap refresh, and the
# post-tool that follows the same call does the repair.
case "$MODE" in
  stop | pre-tool) ;;
  notification)
    case "$ntype" in
      idle_prompt) ;;
      *) repair_owed && post_composed ;;
    esac
    ;;
  *) repair_owed && post_composed ;;
esac

# Let backgrounded presence finish without holding the session (bounded by its
# own --max-time); then always succeed.
wait 2>/dev/null || true
exit 0
