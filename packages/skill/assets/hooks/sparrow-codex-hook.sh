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
# THE STAMP RECORDS WHICH KIND OF RUN WROTE IT. `verify`'s diagnostics print the
# hook command line so an agent can run it BY HAND and read the error — a script
# check, not evidence that Codex invoked anything. That hand-run writes a stamp
# just the same, which would otherwise turn `verify` green on the strength of the
# agent's own typing. So the printed line carries `SPARROW_HOOK_SELFTEST=1` and
# this writes `manual` instead of `runtime`; `verify` keeps a `manual`-stamped
# event UNVERIFIED. Codex never sets that variable, and an EMPTY stamp (any
# older CLI) still reads as `runtime`, exactly as it did before.
#
# THE STAMP ALSO RECORDS WHICH CODEX THREAD FIRED IT. `sparrow await` needs a
# stronger answer than "hooks have fired here at some point": a stamp from last
# week's session does not prove that THIS thread's hooks are trusted, and a
# listener armed for an untrusted thread is deaf with nobody to notice. Measured
# on 2026-09-16: a Codex hook's environment does NOT carry CODEX_THREAD_ID or
# CODEX_SESSION_ID (only CODEX_MANAGED_BY_NPM survives), so the identity has to
# come out of the hook PAYLOAD on stdin — snake_case keys, `session_id` among
# them. We lift the TOP-LEVEL one (node when available, an anchored sed when
# not — see below), sanitise it, write `<kind> <thread>`, and export it as
# SPARROW_CODEX_THREAD for the inner hook, which is how the Stop hook knows it
# is running under Codex at all.
# No session_id in the payload -> a bare `<kind>`, exactly as before.
#
# Usage: sparrow-codex-hook.sh <Event> <script> [args...]
# Contract: stdin, stdout and the exit status all belong to <script>. We must
# READ stdin to find the thread, so the payload is re-fed to <script> on a pipe
# instead of `exec`-ing into it; stdout is untouched (it is the Stop hook's
# decision channel) and the child's exit status is propagated verbatim. Every
# failure path here exits 0 with no output — a broken wrapper must never wedge a
# session.
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

# The payload, read WHOLE and best-effort: nothing below may fail if stdin is
# closed, empty, or not JSON.
input=$(cat 2>/dev/null || true)

# THE THREAD IS THE TOP-LEVEL `session_id`, AND ONLY THAT. Codex payloads nest:
# a PostToolUse `tool_response` can carry a `session_id` of its own, and a regex
# swept over the whole payload happily returns it. Stamping another session's id
# is worse than stamping none — `hooksVerifiedForThread` would then answer
# confidently about the wrong thread. So parse structurally with node when node
# is there (the Stop hook already shells out to it for the unread count, so the
# cost is accepted), and when it is not, fall back to an ANCHORED sed that can
# only see a `session_id` while it is still at the top level, i.e. the first
# top-level key BEFORE any nested object. Anything else yields no thread at all:
# unverified is the safe answer.
if command -v node >/dev/null 2>&1; then
  thread=$(SPARROW_HOOK_PAYLOAD="$input" node -e 'try{const j=JSON.parse(process.env.SPARROW_HOOK_PAYLOAD||"");if(j&&typeof j==="object"&&typeof j.session_id==="string")process.stdout.write(j.session_id)}catch(e){}' 2>/dev/null || true)
else
  thread=$(printf '%s' "$input" \
    | tr '\n' ' ' \
    | sed -n 's/^[[:space:]]*{[^{}]*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)
fi
# Sanitise whatever came back: a stamp filename's neighbour is still a file we
# write, and a thread id is compared, printed and logged downstream.
thread=$(printf '%s' "$thread" | tr -cd 'A-Za-z0-9_-' | cut -c1-128)

if [ -n "$event" ]; then
  if [ -n "${SPARROW_HOOK_SELFTEST:-}" ]; then kind=manual; else kind=runtime; fi
  mkdir -p "$FIRED_DIR" 2>/dev/null || true
  if [ -n "$thread" ]; then
    printf '%s %s\n' "$kind" "$thread" > "$FIRED_DIR/$event" 2>/dev/null || true
  else
    printf '%s\n' "$kind" > "$FIRED_DIR/$event" 2>/dev/null || true
  fi
fi

# Tell the inner hook who it is running for. SPARROW_HOOK_RUNTIME is set even
# when the payload named no thread: the Stop hook keys its Codex-specific
# judgements on it, and Codex is the only runtime that goes through this wrapper.
SPARROW_HOOK_RUNTIME=codex
export SPARROW_HOOK_RUNTIME
if [ -n "$thread" ]; then
  SPARROW_CODEX_THREAD="$thread"
  export SPARROW_CODEX_THREAD
fi

[ -x "$script" ] || exit 0
# Re-feed the payload and adopt the child's exit status. `exec` is impossible
# here (stdin has already been consumed), so the pipeline's status is the one
# that matters — and in POSIX sh that is the LAST command's, which is the child.
printf '%s' "$input" | "$script" "$@"
exit $?
