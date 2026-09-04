#!/usr/bin/env bash
# 035-broadcast — send --to all in a multi-member room; every other member gets a
# copy; per-recipient read status is independent.
set -euo pipefail
SCENARIO_NAME="035-broadcast"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"

# A project room with the owner + two agents.
room="$(ac_tok "$owner" room create teamroom --json | jq -r '.id')"
x="$(create_agent "$owner" "$org" xavier)"; xid="$(jq -r '.agent.id' <<<"$x")"; xkey="$(jq -r '.key' <<<"$x")"
y="$(create_agent "$owner" "$org" yolanda)"; yid="$(jq -r '.agent.id' <<<"$y")"; ykey="$(jq -r '.key' <<<"$y")"
ac_tok "$owner" room add "$xid" --room "$room" >/dev/null
ac_tok "$owner" room add "$yid" --room "$room" >/dev/null

# Broadcast to all: kind broadcast, two recipients (X and Y, not the sender).
sent="$(ac_tok "$owner" send all "team update" --room "$room" --json)"
mid="$(jq -r '.message.id' <<<"$sent")"
assert_json "$sent" '.message.kind' 'broadcast' 'broadcast kind'
assert_json "$sent" '.message.to | length' '2' 'two recipients'

# Both agents receive it.
assert_json "$(ac_tok "$xkey" pop --room "$room" --json)" '.message.body' 'team update' 'X got it'

# X has read; Y has not yet.
st="$(ac_tok "$owner" status "$mid" --room "$room" --json)"
assert_json "$st" '.recipients | length' '2' 'status has two recipients'
assert_json "$st" '[.recipients[] | select(.status == "read")] | length' '1' 'exactly one read (X)'
assert_json "$st" '[.recipients[] | select(.status == "unread")] | length' '1' 'exactly one unread (Y)'

# Y pops → both read.
assert_json "$(ac_tok "$ykey" pop --room "$room" --json)" '.message.body' 'team update' 'Y got it'
st2="$(ac_tok "$owner" status "$mid" --room "$room" --json)"
assert_json "$st2" '[.recipients[] | select(.status == "read")] | length' '2' 'both read'

pass "broadcast fanned out to every member; per-recipient status independent"
