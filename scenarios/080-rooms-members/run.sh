#!/usr/bin/env bash
# 080-rooms-members — create a room (creator = owner) → attach a visible agent →
# invite a human who accepts → role management: grant admin, agent-role 400,
# sole-owner leave/demote 409, kick emits member.removed.
set -euo pipefail
SCENARIO_NAME="080-rooms-members"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
room="$(ac_tok "$owner" room create crewroom --json | jq -r '.id')"

# Creator is the room owner.
members="$(ac_tok "$owner" members --room "$room" --json)"
assert_json "$members" '[.items[] | select(.roomRole == "owner")] | length' '1' 'one owner'
owner_mid="$(jq -r '.items[0].id' <<<"$members")"

# Attach a visible (owned) agent.
b="$(create_agent "$owner" "$org" bee)"; bid="$(jq -r '.agent.id' <<<"$b")"; bkey="$(jq -r '.key' <<<"$b")"
b_mid="$(ac_tok "$owner" room add "$bid" --room "$room" --json | jq -r '.id')"

# Invite a human (org member) who accepts.
h2="$(add_human_to_org "$owner" "$org" h2@ex.com password123 Human2)"
h2id="$(ac_tok "$h2" whoami --json | jq -r '.id')"
ac_tok "$owner" room invite h2@ex.com --room "$room" >/dev/null
rin="$(ac_tok "$h2" invitations --json | jq -r '.items[0].id')"
ac_tok "$h2" invitations accept "$rin" >/dev/null
h2_mid="$(ac_tok "$owner" members --room "$room" --json | jq -r ".items[] | select(.principalId == \"$h2id\") | .id")"
[ -n "$h2_mid" ] || fail "H2 did not join the room"

# Live displayName: H2 renames its account (PATCH /me); the room member list
# reflects it for other members immediately (no re-add).
assert_json "$(api "$h2" PATCH /me '{"displayName":"Renamed Human"}')" '.principal.displayName' 'Renamed Human' 'PATCH /me returns the new name'
assert_json "$(ac_tok "$owner" members --room "$room" --json)" \
  ".items[] | select(.id == \"$h2_mid\") | .displayName" 'Renamed Human' 'rename propagates to the member list'

# Grant H2 admin (no CLI verb → raw PATCH).
assert_json "$(api "$owner" PATCH "/rooms/$room/members/$h2_mid" '{"roomRole":"admin"}')" \
  '.member.roomRole' 'admin' 'H2 promoted to admin'

# An agent cannot be promoted above member.
assert_eq 400 "$(http_status "$owner" PATCH "/rooms/$room/members/$b_mid" '{"roomRole":"admin"}')" 'agent role change → 400'

# The sole owner cannot leave or be demoted.
assert_eq 409 "$(http_status "$owner" DELETE "/me/rooms/$room")" 'sole-owner leave → 409'
assert_eq 409 "$(http_status "$owner" PATCH "/rooms/$room/members/$owner_mid" '{"roomRole":"member"}')" 'sole-owner demote → 409'

# Kick H2 → member.removed to remaining members (agent B watches).
ev="$SPARROW_TMPROOT/kick-events.jsonl"
wpid="$(sse_room_watch "$bkey" "$room" "$ev")"
sleep 1
api "$owner" DELETE "/rooms/$room/members/$h2_mid" >/dev/null
wait_for_line "$ev" '"type":"member.removed"' || { kill "$wpid" 2>/dev/null || true; fail "no member.removed event"; }
kill "$wpid" 2>/dev/null || true
assert_json "$(ac_tok "$owner" members --room "$room" --json)" \
  "[.items[] | select(.principalId == \"$h2id\")] | length" '0' 'H2 removed from the room'

pass "room roles, agent-role guard, sole-owner 409s, and kick/member.removed verified"
