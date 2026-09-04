#!/usr/bin/env bash
# 120-received — delivery receipts (three-valued read state unread→received→read).
#
# `received` is server-observed delivery, set once: either (a) a recipient holds
# an open room stream when the sender sends (message.new is written to it), or
# (b) the recipient lists an inbox. Marking it emits `message.received` to the
# sender exactly once; reading (pop) without ever being received emits only
# `message.read`. This scenario drives all six transitions against a live stack
# and asserts both the JSON status and the CLI's human-readable RECEIVED AT
# column, watching the sender's own SSE stream to prove event emission/gating.
set -euo pipefail
SCENARIO_NAME="120-received"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

# Low presence grace so a closed agent stream flips the agent offline promptly
# for the read-without-received leg (step 6). While a stream is open the member
# stays online regardless of grace; grace only delays the offline transition.
PRESENCE_GRACE_SECONDS=1
export PRESENCE_GRACE_SECONDS

# --- helpers ---------------------------------------------------------------

# wait_presence <token> <room> <memberId> <want:1|0> — poll room presence until
# the member is online (want=1) or offline (want=0). 0 on match, 1 on timeout.
wait_presence() {
  local tok="$1" room="$2" mid="$3" want="$4" i online
  for i in $(seq 1 40); do
    online="$(api "$tok" GET "/rooms/$room/status" \
      | jq -r --arg m "$mid" '(.presence.online | index($m)) != null')"
    { [ "$want" = 1 ] && [ "$online" = true ]; } && return 0
    { [ "$want" = 0 ] && [ "$online" = false ]; } && return 0
    sleep 0.25
  done
  return 1
}

# received_count <watchfile> <messageId> — number of `message.received` lines in
# the sender's captured watch output that reference this message id.
received_count() {
  grep -F "$2" "$1" 2>/dev/null | grep -c '"type":"message.received"' || true
}

# msg_status <token> <room> <msgId> <jq-suffix> — read a recipient[0] field.
recip_field() { # <token> <room> <msgId> <field>
  ac_tok "$1" status "$3" --room "$2" --json | jq -r ".recipients[0].$4"
}

# ===========================================================================
scenario_start

# Bootstrap: owner human + agent B and their DM room (standard fixture).
owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
b="$(create_agent "$owner" "$org" bee)"
bid="$(jq -r '.agent.id' <<<"$b")"
bkey="$(jq -r '.key' <<<"$b")"
room="$(ac_tok "$owner" dm "$bid" --json | jq -r '.dm.room.id')"

owner_mem="$(api "$owner" GET "/rooms/$room/whoami" | jq -r '.id')"
agent_mem="$(api "$bkey"  GET "/rooms/$room/whoami" | jq -r '.id')"

# Sender watches its OWN room events for the whole scenario (raw SSE via the
# built CLI in the background, unbuffered node stdout — never awk/grep pipes).
swatch="$SPARROW_TMPROOT/owner-watch.jsonl"
: >"$swatch"
swatch_pid="$(sse_room_watch "$owner" "$room" "$swatch")"
wait_presence "$owner" "$room" "$owner_mem" 1 || fail "owner's own watch stream never went online"

# ---------------------------------------------------------------------------
# 1) Send while the recipient is OFFLINE (no open stream) → status unread.
# ---------------------------------------------------------------------------
wait_presence "$owner" "$room" "$agent_mem" 0 || fail "agent should be offline before msg1"
s1="$(ac_tok "$owner" send "$bid" 'offline delivery' --subject one --room "$room" --json)"
mid1="$(jq -r '.message.id' <<<"$s1")"
assert_eq unread "$(recip_field "$owner" "$room" "$mid1" status)"     'msg1 status unread (offline send)'
assert_eq null   "$(recip_field "$owner" "$room" "$mid1" receivedAt)" 'msg1 receivedAt null (offline send)'
assert_eq 0 "$(received_count "$swatch" "$mid1")" 'no message.received for msg1 yet'

# ---------------------------------------------------------------------------
# 2) Recipient lists its inbox (trigger b) → sender sees received + receivedAt.
# ---------------------------------------------------------------------------
inbox1="$(ac_tok "$bkey" inbox --room "$room" --json)"
assert_contains "$inbox1" "$mid1" 'msg1 present in agent inbox'
assert_eq received "$(recip_field "$owner" "$room" "$mid1" status)" 'msg1 status received after inbox list'
recv1="$(recip_field "$owner" "$room" "$mid1" receivedAt)"
[ -n "$recv1" ] && [ "$recv1" != null ] || fail "msg1 receivedAt should be set after inbox list (got [$recv1])"
wait_for_line "$swatch" '"type":"message.received"' || fail "sender never saw a message.received event for msg1"
assert_eq 1 "$(received_count "$swatch" "$mid1")" 'exactly one message.received emitted for msg1'

# CLI human-readable `status` shows the RECEIVED AT column populated.
human1="$(ac_tok "$owner" status "$mid1" --room "$room")"
assert_contains "$human1" 'RECEIVED AT'  'human status has a RECEIVED AT column'
assert_contains "$human1" "$recv1"       'human status RECEIVED AT column shows the timestamp'

# ---------------------------------------------------------------------------
# 5) Set-once: re-listing the inbox does NOT emit a second message.received.
# ---------------------------------------------------------------------------
ac_tok "$bkey" inbox --room "$room" --all --json >/dev/null
ac_tok "$bkey" inbox --room "$room" --json >/dev/null
sleep 0.5
assert_eq 1 "$(received_count "$swatch" "$mid1")" 'message.received for msg1 stays set-once after re-list'

# ---------------------------------------------------------------------------
# 3) Recipient holds an open stream at send time (trigger a) → near-real-time
#    message.received to the sender.
# ---------------------------------------------------------------------------
awatch="$SPARROW_TMPROOT/agent-watch.jsonl"
: >"$awatch"
awatch_pid="$(sse_room_watch "$bkey" "$room" "$awatch")"
wait_presence "$owner" "$room" "$agent_mem" 1 || fail "agent watch stream never went online"

s2="$(ac_tok "$owner" send "$bid" 'live delivery' --subject two --room "$room" --json)"
mid2="$(jq -r '.message.id' <<<"$s2")"
wait_for_line "$swatch" "$mid2" || fail "sender never saw an event for msg2"
[ "$(received_count "$swatch" "$mid2")" -ge 1 ] || fail "no message.received for msg2 (online send should mark received)"
assert_eq received "$(recip_field "$owner" "$room" "$mid2" status)" 'msg2 status received (online send)'

# ---------------------------------------------------------------------------
# 4) Recipient pops → read, readAt set, receivedAt preserved.
# ---------------------------------------------------------------------------
pop1="$(ac_tok "$bkey" pop --room "$room" --json)"
pid1="$(jq -r '.message.id' <<<"$pop1")"
[ -n "$pid1" ] && [ "$pid1" != null ] || fail "pop returned no message"
assert_eq read "$(recip_field "$owner" "$room" "$pid1" status)" "popped $pid1 status read"
read1="$(recip_field "$owner" "$room" "$pid1" readAt)"
[ -n "$read1" ] && [ "$read1" != null ] || fail "popped $pid1 readAt should be set"
precv="$(recip_field "$owner" "$room" "$pid1" receivedAt)"
[ -n "$precv" ] && [ "$precv" != null ] || fail "popped $pid1 receivedAt should be PRESERVED (got [$precv])"

# Drain the remaining received-but-unread message so only a fresh, never-received
# message is oldest for the read-without-received leg below.
ac_tok "$bkey" pop --room "$room" --json >/dev/null

# ---------------------------------------------------------------------------
# 6) Read-without-received: send while offline, pop directly (no inbox list) →
#    only message.read, never message.received; status read, receivedAt null.
# ---------------------------------------------------------------------------
kill "$awatch_pid" 2>/dev/null || true
wait_presence "$owner" "$room" "$agent_mem" 0 || fail "agent should be offline again after closing its stream"

s3="$(ac_tok "$owner" send "$bid" 'read without received' --subject three --room "$room" --json)"
mid3="$(jq -r '.message.id' <<<"$s3")"
assert_eq unread "$(recip_field "$owner" "$room" "$mid3" status)"     'msg3 status unread (offline send)'
assert_eq null   "$(recip_field "$owner" "$room" "$mid3" receivedAt)" 'msg3 receivedAt null (offline send)'

pop3="$(ac_tok "$bkey" pop --room "$room" --json)"
assert_json "$pop3" '.message.id' "$mid3" 'agent pops msg3 directly (oldest unread)'
assert_eq read "$(recip_field "$owner" "$room" "$mid3" status)" 'msg3 status read after direct pop'
r3="$(recip_field "$owner" "$room" "$mid3" readAt)"
[ -n "$r3" ] && [ "$r3" != null ] || fail "msg3 readAt should be set"
assert_eq null "$(recip_field "$owner" "$room" "$mid3" receivedAt)" 'msg3 receivedAt stays null (read without received)'

wait_for_line "$swatch" "$mid3" || fail "sender never saw an event for msg3"
grep -F "$mid3" "$swatch" | grep -q '"type":"message.read"' || fail "sender should have seen message.read for msg3"
assert_eq 0 "$(received_count "$swatch" "$mid3")" 'NO message.received ever emitted for msg3'

# --- teardown watchers -----------------------------------------------------
kill "$swatch_pid" 2>/dev/null || true

pass "unread→received→read receipts, set-once emission, and read-without-received verified"
