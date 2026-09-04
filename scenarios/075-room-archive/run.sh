#!/usr/bin/env bash
# 075-room-archive — description settings persist; archiving freezes the room
# (sends and member changes → 410) but history stays readable (force-peek);
# restoring returns it to normal.
set -euo pipefail
SCENARIO_NAME="075-room-archive"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
b="$(create_agent "$owner" "$org" bee)"; bid="$(jq -r '.agent.id' <<<"$b")"; bkey="$(jq -r '.key' <<<"$b")"
room="$(ac_tok "$owner" room create archiveroom --json | jq -r '.id')"
ac_tok "$owner" room add "$bid" --room "$room" >/dev/null

# Description setting round-trips.
api "$owner" PATCH "/rooms/$room" '{"settings":{"description":"the archive room"}}' >/dev/null
assert_json "$(api "$owner" GET "/rooms/$room")" '.settings.description' 'the archive room' 'description setting saved'

# Seed a message (history), then archive.
mid="$(ac_tok "$owner" send all "before the freeze" --room "$room" --json | jq -r '.message.id')"
archived="$(api "$owner" PATCH "/rooms/$room" '{"archived":true}')"
assert_json "$archived" '(.room.archivedAt != null)' 'true' 'room archived'

# Mutations → 410 gone.
assert_eq 410 "$(http_status "$owner" POST "/rooms/$room/messages" '{"to":"all","body":"nope"}')" 'send → 410'
assert_eq 410 "$(http_status "$owner" POST "/rooms/$room/members" "{\"principal\":\"$bid\"}")" 'add member → 410'

# History readable (force-peek: reading does not write read state).
assert_json "$(api "$bkey" GET "/rooms/$room/messages/$mid")" '.message.body' 'before the freeze' 'history still readable'

# Restore, then a send works again.
restored="$(api "$owner" PATCH "/rooms/$room" '{"archived":false}')"
assert_json "$restored" '(.room.archivedAt == null)' 'true' 'room restored'
assert_eq 201 "$(http_status "$owner" POST "/rooms/$room/messages" '{"to":"all","body":"back online"}')" 'send works after restore'

pass "archive froze the room (410s) with readable history; restore reopened it"
