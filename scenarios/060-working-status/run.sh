#!/usr/bin/env bash
# 060-working-status — advertise/clear working; scoped statuses are visible only
# to their target; pop --ack sets working scoped to the sender; short TTL expires.
set -euo pipefail
SCENARIO_NAME="060-working-status"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
ownid="$(ac_tok "$owner" whoami --json | jq -r '.id')"
room="$(ac_tok "$owner" room create workroom --json | jq -r '.id')"
x="$(create_agent "$owner" "$org" xavier)"; xid="$(jq -r '.agent.id' <<<"$x")"; xkey="$(jq -r '.key' <<<"$x")"
y="$(create_agent "$owner" "$org" yolanda)"; yid="$(jq -r '.agent.id' <<<"$y")"; ykey="$(jq -r '.key' <<<"$y")"
ac_tok "$owner" room add "$xid" --room "$room" >/dev/null
ac_tok "$owner" room add "$yid" --room "$room" >/dev/null

# Owner advertises room-wide working; both agents see it.
ac_tok "$owner" status working --note "deploying" --ttl 120 --room "$room" >/dev/null
assert_json "$(ac_tok "$xkey" status list --room "$room" --json)" \
  '[.items[] | select(.note == "deploying")] | length' '1' 'X sees room-wide status'
ac_tok "$owner" status idle --room "$room" >/dev/null
assert_json "$(ac_tok "$xkey" status list --room "$room" --json)" \
  '[.items[] | select(.note == "deploying")] | length' '0' 'idle cleared it'

# Scoped status: owner → X only. X sees it; Y does not.
ac_tok "$owner" status working --note "for X" --to "$xid" --ttl 120 --room "$room" >/dev/null
assert_json "$(ac_tok "$xkey" status list --room "$room" --json)" \
  '[.items[] | select(.note == "for X")] | length' '1' 'X sees the scoped status'
assert_json "$(ac_tok "$ykey" status list --room "$room" --json)" \
  '[.items[] | select(.note == "for X")] | length' '0' 'Y does not see the scoped status'
ac_tok "$owner" status idle --to "$xid" --room "$room" >/dev/null

# pop --ack: owner DMs X in-room; X pops with --ack; X's working status is scoped
# to the owner (the sender), visible to the owner.
ac_tok "$owner" send "$xid" "please handle" --room "$room" --json >/dev/null
ac_tok "$xkey" pop --room "$room" --ack --note "on it" >/dev/null
ackst="$(ac_tok "$owner" status list --room "$room" --json)"
assert_json "$ackst" '[.items[] | select(.note == "on it")] | length' '1' 'ack set X working, scoped to owner'

# Short TTL expiry: a 1s status is gone after a couple seconds.
ac_tok "$owner" status working --note "blink" --ttl 1 --room "$room" >/dev/null
sleep 2
assert_json "$(ac_tok "$xkey" status list --room "$room" --json)" \
  '[.items[] | select(.note == "blink")] | length' '0' 'short-TTL status expired'

pass "working/idle, scoped visibility, pop --ack, and TTL expiry all behave"
