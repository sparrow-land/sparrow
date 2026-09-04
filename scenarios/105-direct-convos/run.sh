#!/usr/bin/env bash
# 105-direct-convos — ensure a DM (201 then 200); the agent messages via
# /rooms/:id; /me/inbox tags each item with its room (+ counterpart on DMs);
# /me/inbox/pop drains across a DM and a project room in order; /me/events wraps
# room context. Guards: self-DM 400, no-visibility DM 403, member-verbs on a DM 400.
set -euo pipefail
SCENARIO_NAME="105-direct-convos"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
ownid="$(ac_tok "$owner" whoami --json | jq -r '.id')"
b="$(create_agent "$owner" "$org" bee)"; bid="$(jq -r '.agent.id' <<<"$b")"; bkey="$(jq -r '.key' <<<"$b")"

# Ensure DM: 201 create, then 200 idempotent.
assert_json "$(ac_tok "$owner" dm "$bid" --json)" '.dm.created' 'true' 'first ensure creates (201)'
dm="$(ac_tok "$owner" dm "$bid" --json)"
assert_json "$dm" '.dm.created' 'false' 'second ensure is idempotent (200)'
dmroom="$(jq -r '.dm.room.id' <<<"$dm")"

# A project room B also inhabits.
proom="$(ac_tok "$owner" room create projectroom --json | jq -r '.id')"
ac_tok "$owner" room add "$bid" --room "$proom" >/dev/null

# B messages the owner: first in the DM, then in the project room.
ac_tok "$bkey" send "$ownid" "dm hello" --room "$dmroom" --json >/dev/null
ac_tok "$bkey" send "$ownid" "project hello" --room "$proom" --json >/dev/null

# /me/inbox tags items with their room and their medium; the DM item carries a
# counterpart. v4: entries are a type-discriminated union — chat is one variant.
inbox="$(ac_tok "$owner" inbox --json)"
assert_json "$inbox" '.items | length' '2' 'two items across memberships'
assert_json "$inbox" '[.items[] | select(.type == "chat.message")] | length' '2' 'both entries tagged chat.message'
assert_json "$inbox" '[.items[] | select(.room.kind == "dm")] | .[0].room.counterpart.displayName' 'bee' 'DM item names its counterpart'

# /me/inbox/pop drains oldest-first across both rooms, as typed WORK ITEMS
# (`{ item: WorkItem | null }` — v3's top-level `{ message, room }` is gone).
p1="$(ac_tok "$owner" pop --json)"
assert_json "$p1" '.item.type' 'chat.message' 'first pop is a chat work item'
assert_json "$p1" '.item.message.body' 'dm hello' 'first pop = the DM message'
assert_json "$p1" '.item.room.kind' 'dm' 'first pop tagged as a DM room'
assert_json "$p1" 'has("message")' 'false' 'no v3 top-level message on the unified pop'
p2="$(ac_tok "$owner" pop --json)"
assert_json "$p2" '.item.type' 'chat.message' 'second pop is a chat work item'
assert_json "$p2" '.item.message.body' 'project hello' 'second pop = the project message'
assert_json "$p2" '.item.room.id' "$proom" 'second pop tagged with the project room'

# /me/events wraps room context around a new DM message.
ev="$SPARROW_TMPROOT/me-events.jsonl"
mpid="$(sse_me_watch "$owner" "$ev")"
sleep 1
ac_tok "$bkey" send "$ownid" "live dm" --room "$dmroom" --json >/dev/null
wait_for_line "$ev" '"type":"message.new"' || { kill "$mpid" 2>/dev/null || true; fail "no wrapped message.new on /me/events"; }
kill "$mpid" 2>/dev/null || true
grep -F '"type":"message.new"' "$ev" | grep -qF '"kind":"dm"' || fail "message.new not wrapped with DM room context"

# Membership-gain SSE guarantee: a principal holding an OPEN /me/events stream
# receives the wrapped member.joined for a room it gains — without reconnecting.
c="$(create_agent "$owner" "$org" carol)"
cid="$(jq -r '.agent.id' <<<"$c")"; ckey="$(jq -r '.key' <<<"$c")"
cev="$SPARROW_TMPROOT/c-me-events.jsonl"
cpid="$(sse_me_watch "$ckey" "$cev")"
sleep 1
ac_tok "$owner" dm "$cid" --json >/dev/null   # fresh DM → C gains a membership live
wait_for_line "$cev" '"type":"member.joined"' || { kill "$cpid" 2>/dev/null || true; fail "no member.joined on C's open /me/events for the new DM room"; }
kill "$cpid" 2>/dev/null || true
grep -F '"type":"member.joined"' "$cev" | grep -qF '"kind":"dm"' || fail "member.joined not wrapped with the new DM room context"

# Guards.
assert_eq 400 "$(http_status "$owner" POST /me/dms "{\"principal\":\"$ownid\"}")" 'self-DM → 400'
g="$(add_human_to_org "$owner" "$org" g@ex.com password123 Gee)"
assert_eq 403 "$(http_status "$g" POST /me/dms "{\"principal\":\"$bid\"}")" 'no-visibility DM → 403'
assert_eq 400 "$(http_status "$owner" POST "/rooms/$dmroom/members" "{\"principal\":\"$bid\"}")" 'add-member on a DM → 400'
assert_eq 400 "$(http_status "$owner" PATCH "/rooms/$dmroom" '{"name":"nope"}')" 'PATCH on a DM → 400'

pass "DM ensure/idempotency, room-tagged /me inbox + ordered pop, wrapped events, guards"
