#!/usr/bin/env bash
# 085-presence — a member is online while it holds an open events stream; after
# disconnect + grace an offline event fires; principal-level online surfaces on
# /me/agents.
set -euo pipefail
SCENARIO_NAME="085-presence"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

# Short grace so the offline event fires quickly.
PRESENCE_GRACE_SECONDS=2
scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
room="$(ac_tok "$owner" room create presenceroom --json | jq -r '.id')"
b="$(create_agent "$owner" "$org" bee)"; bid="$(jq -r '.agent.id' <<<"$b")"; bkey="$(jq -r '.key' <<<"$b")"
b_mid="$(ac_tok "$owner" room add "$bid" --room "$room" --json | jq -r '.id')"

# Poll a JSONL event file for a presence.changed line naming a specific member id
# with a specific state (the owner is also connected, so filter by B's member id).
wait_presence() { # <file> <memberId> <state> [tries]
  local f="$1" mid="$2" state="$3" tries="${4:-60}" i
  for ((i = 0; i < tries; i++)); do
    grep -F '"type":"presence.changed"' "$f" 2>/dev/null | grep -F "$mid" | grep -qF "\"state\":\"$state\"" && return 0
    sleep 0.25
  done
  return 1
}
# Poll /me/agents until B's principal-level online matches the expected value.
wait_agent_online() { # <expected true|false> [tries]
  local want="$1" tries="${2:-40}" i got
  for ((i = 0; i < tries; i++)); do
    got="$(ac_tok "$owner" agents --json | jq -r ".items[] | select(.agent.id == \"$bid\") | .agent.online")"
    [ "$got" = "$want" ] && return 0
    sleep 0.25
  done
  return 1
}

# Owner watches the room; B then opens its stream → presence.changed online for B.
oev="$SPARROW_TMPROOT/owner-events.jsonl"
opid="$(sse_room_watch "$owner" "$room" "$oev")"
sleep 1
bpid="$(sse_room_watch "$bkey" "$room" "$oev.b")"

wait_presence "$oev" "$b_mid" online || { kill "$opid" "$bpid" 2>/dev/null || true; fail "no online event for B"; }

# Principal-level online exposed on /me/agents while B's stream is open.
wait_agent_online true || { kill "$opid" "$bpid" 2>/dev/null || true; fail "agent not online on /me/agents"; }

# Disconnect B; after the grace window an offline event fires for B.
kill "$bpid" 2>/dev/null || true
wait_presence "$oev" "$b_mid" offline || { kill "$opid" 2>/dev/null || true; fail "no offline event after grace"; }
kill "$opid" 2>/dev/null || true

# And /me/agents now reports offline.
wait_agent_online false || fail "agent still online on /me/agents after disconnect + grace"

pass "presence online on stream open, offline after grace; /me/agents reflects it"
