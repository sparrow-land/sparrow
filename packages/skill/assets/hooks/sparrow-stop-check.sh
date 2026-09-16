#!/bin/sh
# Sparrow loop Stop-hook (Claude Code and Codex).
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
#   4. FRESH HEARTBEAT, DEAD PROCESS -- the listener was SIGKILLed, so it stamped
#      NOTHING on its way out (SIGKILL is uncatchable) and the heartbeat it had
#      already written stays fresh for the whole window. This is what a Codex
#      sandbox does to a listener armed from a model-run command: the PID
#      namespace is torn down the instant the command returns. So a fresh
#      `await`/`await:codex` heartbeat is cross-checked against the owner pid in
#      <state dir>/await-owner.json, and a DEMONSTRABLY absent process blocks.
#      Permission-denied is not absence (the owner may be another unix user), a
#      missing pid is not absence, and neither of those blocks anything.
# If the loop switch is absent or paused, stay silent.
#
# HOW IT TELLS THEM APART: every CLI listener writes its own kind (`await`,
# `watch`, `loop`) as the heartbeat file's content while stamping the mtime, and
# writes `killed:<signal>` / `stopped:<signal>` as it dies.
# `killed`/`stopped` (fresh or stale) -> block, naming the cause. Fresh +
# `await:codex` -> allow. Fresh + `await` under Codex -> block because it is
# passive. Fresh + `await` under Claude -> allow. Fresh + `watch`/`loop` -> block.
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
passive_await=""
dead_word=""
dead_signal=""
gone_pid=""
# BOTH runtimes now re-arm the same way: plain, unbounded `sparrow await`. The
# CLI owns its own liveness (stale-stream detection, periodic re-establish,
# resuming reconnects), so nothing here hands back a bounded command whose only
# effect would be to burn a turn re-arming on a timer. Only the WORDING forks,
# on the runtime resolved just below; when we cannot tell which runtime we are
# in, we name it generically and treat plain `await` as a wake path.
# ONE PRESCRIPTION, TWO LANGUAGES. A machine hosting several agents under one
# unix user shares ONE credentials.json, so a bare `sparrow await` typed into a
# fresh shell acts as whichever neighbour owns defaultProfile. A project-scope
# install stamps SPARROW_PROFILE into this hook's command precisely so the hook
# knows which agent it speaks for -- so when it is set, every command this nudge
# prescribes names it. The rendering must match the CLI's `awaitCommand()`
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
# WHICH RUNTIME IS THIS? Measured 2026-09-16: a Codex hook's environment carries
# NEITHER CODEX_THREAD_ID nor CODEX_SESSION_ID (only CODEX_MANAGED_BY_NPM
# survives), so keying Codex behaviour on CODEX_THREAD_ID alone made this hook
# quietly judge a Codex session by Claude's rules -- passing exactly the passive
# `await` heartbeat it exists to catch. The wrapper every Codex hook runs through
# now exports SPARROW_HOOK_RUNTIME=codex, plus SPARROW_CODEX_THREAD when the hook
# payload named a session; CODEX_THREAD_ID is still honored for any runner that
# does export it.
codex_thread="${CODEX_THREAD_ID:-${SPARROW_CODEX_THREAD:-}}"
if [ -n "$codex_thread" ] || [ "${SPARROW_HOOK_RUNTIME:-}" = codex ]; then
  runtime="Codex"
  is_codex="yes"
else
  runtime="this turn-based session"
  is_codex=""
fi
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

# IS THE PROCESS THAT WROTE THIS HEARTBEAT STILL THERE?
#
# Prints the pid when the owner record names a numeric one that is DEMONSTRABLY
# GONE; prints nothing in every other case -- no record, no pid, a live process,
# a pid we are not allowed to signal, or a listener that is still STARTING.
#
# Permission matters: several agents share a host under different unix users, and
# `kill -0` on a stranger's process fails with EPERM, which is proof the process
# EXISTS. Treating that as absence would block every one of those turns. Unknown
# always allows.
#
# THE ARMING RACE (review, 2026-09-16) is why this is not just `kill -0`. A
# listener exits on work, the agent re-arms as the last act of its turn, and the
# new listener publishes <state dir>/await-owner.json LATE -- by design, after
# credentials and one HTTP round trip. A Stop hook firing in that window sees the
# OLD owner pid gone and would block a turn that did exactly the right thing. So
# the listener drops <state dir>/await-candidate.json the instant its process
# starts, before any network: not ownership, never a claim, just an honest
# "something is arming".
#
# A CANDIDATE IS NEVER EVIDENCE OF A WAKE PATH -- only a reason to be PATIENT.
# Finding a live, fresh, not-yet-published candidate, this POLLS the owner record
# for up to 2 seconds and allows only when a DIFFERENT generation has published
# and its process exists. No candidate, or the window expires: block.
#
# WHY NOT "WHEN UNSURE, ALLOW" HERE. Everywhere else in this hook an unjudgeable
# state allows, because a wrong block wastes a turn. Not on this path: a false
# BLOCK costs one self-correcting turn, while a false ALLOW ends the turn with no
# proven wake path -- which is precisely the 11-hour silent incident this check
# exists for. The verdict always rests on the same fact, a published owner whose
# process exists, so a recycled pid can only buy a longer wait, never a wrong
# verdict.
#
# WHY THE NONCE GATE: a candidate whose nonce matches the heartbeat's generation
# or the owner record's is BY DEFINITION the generation that already published,
# so it is not arming -- without that check a stale marker plus a recycled pid
# would buy a 2-second wait on every stop forever. The CLI also removes the
# marker on publish and on clean exit, so it normally never outlives the arming
# window. Residual failure mode, accepted: a candidate process that died without
# cleanup, whose pid is recycled inside the freshness window, and whose nonce
# never reached the owner record -- one pointless wait, still ending in a block.
#
# The sandbox case this whole check exists for cannot fake any of it: there the
# listener process is dead, so the candidate names a corpse and we block at once.

# Is <pid> demonstrably absent? Nothing else counts as absence.
pid_absent() {
  _p="$1"
  kill -0 "$_p" 2>/dev/null && return 1
  if [ -d /proc/1 ]; then
    [ -e "/proc/$_p" ] && return 1
    return 0
  fi
  # No procfs (macOS): read the error text, and keep the benefit of the doubt
  # for anything we cannot positively read as "no such process".
  _err=$(kill -0 "$_p" 2>&1 >/dev/null || true)
  case "$_err" in
    *o\ such\ process* | *ESRCH*) return 0 ;;
  esac
  return 1
}

# The numeric `pid` / string `nonce` out of one of our JSON state records.
json_pid() { sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$1" 2>/dev/null | head -n 1; }
json_nonce() {
  sed -n 's/.*"nonce"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9][A-Za-z0-9]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}

owner_pid() { [ -r "$STATE_DIR/await-owner.json" ] && json_pid "$STATE_DIR/await-owner.json"; }

# Is a listener currently ARMING? (live + fresh + a generation that has not
# published yet). Answers with an exit status; prints nothing.
listener_arming() {
  _cand="$STATE_DIR/await-candidate.json"
  [ -r "$_cand" ] || return 1
  _cpid=$(json_pid "$_cand")
  [ -n "$_cpid" ] || return 1
  [ "$_cpid" -gt 0 ] 2>/dev/null || return 1
  pid_absent "$_cpid" && return 1

  # Freshness by the marker's mtime: portable, and enough. (`startedAt` is in the
  # record for humans; parsing ISO dates in POSIX sh is not worth the edge cases.)
  _cm=$(mtime "$_cand")
  [ -n "${_cm:-}" ] || return 1
  [ "$now" -gt 0 ] 2>/dev/null || return 1
  _cage=$((now - _cm))
  [ "$_cage" -ge 0 ] && [ "$_cage" -lt "$FRESH_SECONDS" ] || return 1

  # The nonce gate: a candidate that names the generation already in the
  # heartbeat or the owner record is that generation, not a new one arming.
  _cnonce=$(json_nonce "$_cand")
  _ononce=""
  [ -r "$STATE_DIR/await-owner.json" ] && _ononce=$(json_nonce "$STATE_DIR/await-owner.json")
  _hbnonce=$(head -c 96 "$HEARTBEAT_FILE" 2>/dev/null | tr '\t\r\n' '   ' \
    | sed -n 's/^ *[^ ][^ ]*  *\([A-Za-z0-9][A-Za-z0-9]*\).*/\1/p')
  [ "$_cnonce" = "$_ononce" ] && return 1
  [ "$_cnonce" = "$_hbnonce" ] && return 1
  return 0
}

# Poll for a REPLACEMENT owner record: a different generation whose process
# exists. Returns 0 the moment one appears, 1 when the window expires. Prints
# nothing. (A shell whose `sleep` rejects fractions waits in 1s steps instead.)
wait_for_new_owner() {
  _start_nonce="$1"
  _waited=0
  while [ "$_waited" -lt 2000 ]; do
    if sleep 0.1 2>/dev/null; then _waited=$((_waited + 100)); else sleep 1; _waited=$((_waited + 1000)); fi
    _n=$(json_nonce "$STATE_DIR/await-owner.json")
    _p=$(owner_pid)
    if [ -n "$_n" ] && [ "$_n" != "$_start_nonce" ] && [ -n "${_p:-}" ] && [ "$_p" -gt 0 ] 2>/dev/null; then
      pid_absent "$_p" || return 0
    fi
  done
  return 1
}

mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }

# ONE JUDGEMENT, RUN AGAINST WHICHEVER LISTENER IS CURRENT.
#
# classify() reads the heartbeat and the owner record and sets `cls` to exactly
# one verdict; everything below only turns that into words. It is a FUNCTION
# because the arming path RE-RUNS it. When the listener that owned this state dir
# has died and a replacement is coming up, the question "may this turn end?" has
# to be answered about the REPLACEMENT -- its kind, its freshness, its generation,
# its own liveness -- never inherited from the corpse. (Reviewer case,
# 2026-09-16: an `await:codex` heartbeat left by the dead listener would
# otherwise wave through a replacement that comes up as a PASSIVE plain `await`.)
#
#   alive        fresh wake path whose process exists (or nobody claims one)
#   unjudgeable  fresh heartbeat we cannot read (legacy, third-party, superseded)
#   dead         a killed:/stopped: stamp from the live generation
#   passive      fresh plain `await` under Codex: no verified queue bridge
#   hold         fresh `watch`/`loop`: online, but it can never wake a turn
#   gone         fresh wake-path heartbeat whose listener process is absent
#   arming       ...and a candidate listener is starting right now
#   drift        no heartbeat, or a stale one
cls=""
arming_pid=""
classify() {
  cls=""; dead_word=""; dead_signal=""; hold_kind=""; passive_await=""; gone_pid=""; arming_pid=""
  now=$(date +%s 2>/dev/null || echo 0)

  [ -f "$HEARTBEAT_FILE" ] || { cls="drift"; return 0; }
  content=$(sparrow_heartbeat_read)

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
    cls="dead"
    return 0
  fi

  hb=$(mtime "$HEARTBEAT_FILE")
  [ -n "${hb:-}" ] || { cls="drift"; return 0; }
  [ "$now" -gt 0 ] 2>/dev/null || { cls="drift"; return 0; }
  age=$((now - hb))
  { [ "$age" -ge 0 ] && [ "$age" -lt "$FRESH_SECONDS" ]; } || { cls="drift"; return 0; }

  # Fresh -> a listener is alive. WHICH one decides: `await` can wake this
  # session, `watch`/`loop` can only hold it online, anything else is unjudgeable.
  case "$content" in
    watch | loop) hold_kind="$content"; cls="hold"; return 0 ;;
    await)
      if [ -n "$is_codex" ]; then passive_await="yes"; cls="passive"; return 0; fi
      ;;
    await:codex) ;;
    *) cls="unjudgeable"; return 0 ;;
  esac

  # A wake path -- IF the process behind it still exists.
  _opid=$(owner_pid)
  cls="alive"
  [ -n "${_opid:-}" ] || return 0
  [ "$_opid" -gt 0 ] 2>/dev/null || return 0
  pid_absent "$_opid" || return 0
  if listener_arming; then
    cls="arming"; arming_pid="$_opid"
  else
    cls="gone"; gone_pid="$_opid"
  fi
  return 0
}

classify
if [ "$cls" = arming ]; then
  # Something is starting. Wait for it to publish ownership, then JUDGE IT --
  # once. No second poll: if the replacement is itself already gone, that is the
  # answer.
  _dead_owner="$arming_pid"
  if wait_for_new_owner "$(json_nonce "$STATE_DIR/await-owner.json")"; then
    classify
    case "$cls" in
      # Another candidate queued behind the first is not a third chance.
      arming) cls="gone"; gone_pid="$arming_pid" ;;
      # The benefit of the doubt is spent: we are on this path precisely because
      # the previous owner died, so a heartbeat we cannot read is not good enough
      # to end the turn on. Fall back to the drift nudge, which says exactly that.
      unjudgeable) cls="drift" ;;
    esac
  else
    cls="gone"; gone_pid="$_dead_owner"
  fi
fi
case "$cls" in
  alive | unjudgeable) allow_stop ;;
esac

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
if [ -n "$gone_pid" ]; then
  reason="Sparrow loop is engaged and the heartbeat is fresh, but the listener process (pid $gone_pid) is gone${suffix} -- a killed listener cannot stamp anything, so a fresh heartbeat outlives it by up to $FRESH_SECONDS seconds and nothing can wake $runtime. Re-arm it: run $await_command as a tracked background task, then drain with $pop_command when work wakes you. If it keeps dying instantly, whatever started it is being torn down with the command (a sandboxed shell) -- start it somewhere that outlives the turn. To step away on purpose run 'sparrow skill pause' (or 'sparrow-skill pause')."
elif [ -n "$dead_word" ]; then
  if [ "$dead_word" = killed ]; then
    if [ -n "$dead_signal" ]; then
      cause="was killed ($dead_signal -- usually a session interrupt)"
    else
      cause="was killed (usually a session interrupt)"
    fi
  else
    cause="was stopped (Ctrl-C)"
  fi
  reason="Sparrow loop is engaged but your listener $cause${suffix} -- nothing is listening now, so nothing can wake $runtime. Re-arm it: run $await_command as a tracked background task, then drain with $pop_command when work wakes you. To step away on purpose run 'sparrow skill pause' (or 'sparrow-skill pause')."
elif [ -n "$passive_await" ]; then
  reason="Sparrow loop is engaged and a passive await listener is alive${suffix}, but it has no verified queue bridge back into this Codex thread. Re-arm with the current CLI: run $await_command as a tracked background task; a bridged listener stamps await:codex. Then drain with $pop_command when work wakes you. To step away on purpose run 'sparrow skill pause' (or 'sparrow-skill pause')."
elif [ -n "$hold_kind" ]; then
  reason="Sparrow loop is engaged and a listener IS alive, but it is sparrow $hold_kind${suffix} -- that holds you online (green presence) and can never wake $runtime, which is the online-but-deaf state, worse than being offline. Run $await_command as a tracked background task instead, then drain with $pop_command when work wakes you. Keep sparrow $hold_kind only if you are genuinely always-running (a process that keeps thinking between messages). To step away on purpose run 'sparrow skill pause' (or 'sparrow-skill pause')."
else
  reason="Sparrow loop is engaged but no listener is running${suffix}. Turn-based (you think only when invoked)? Re-arm your wake command: $await_command as a background task, then drain with $pop_command when work wakes you. Always-running? Re-start sparrow watch/loop. Note this hook checks the heartbeat a listener leaves behind -- a heartbeat with no listener kind (an older CLI, or your own curl loop) it cannot judge, so a re-armed await is on you. To step away on purpose run 'sparrow skill pause' (or 'sparrow-skill pause')."
fi

# Emit the block decision. Keep the reason free of double-quotes/newlines so this
# hand-rolled JSON stays valid without an escaper.
printf '{"decision":"block","reason":"%s"}\n' "$reason"
exit 0
