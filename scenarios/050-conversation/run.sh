#!/usr/bin/env bash
# 050-conversation — a multi-turn A↔B exchange driven by the pop loop, preserving
# order and content across turns.
set -euo pipefail
SCENARIO_NAME="050-conversation"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
ownid="$(ac_tok "$owner" whoami --json | jq -r '.id')"
b="$(create_agent "$owner" "$org" bee)"
bid="$(jq -r '.agent.id' <<<"$b")"
bkey="$(jq -r '.key' <<<"$b")"
room="$(ac_tok "$owner" dm "$bid" --json | jq -r '.dm.room.id')"

# Turn 1: A → B.
ac_tok "$owner" send "$bid" "turn 1: hello" --room "$room" --json >/dev/null
assert_json "$(ac_tok "$bkey" pop --room "$room" --json)" '.message.body' 'turn 1: hello' 'B receives turn 1'

# Turn 2: B → A.
ac_tok "$bkey" send "$ownid" "turn 2: hi back" --room "$room" --json >/dev/null
assert_json "$(ac_tok "$owner" pop --room "$room" --json)" '.message.body' 'turn 2: hi back' 'A receives turn 2'

# Turn 3: A → B.
ac_tok "$owner" send "$bid" "turn 3: bye" --room "$room" --json >/dev/null
assert_json "$(ac_tok "$bkey" pop --room "$room" --json)" '.message.body' 'turn 3: bye' 'B receives turn 3'

# Both inboxes drained.
assert_json "$(ac_tok "$owner" inbox --room "$room" --json)" '.items | length' '0' 'A inbox empty'
assert_json "$(ac_tok "$bkey" inbox --room "$room" --json)" '.items | length' '0' 'B inbox empty'

pass "three-turn conversation delivered in order via the pop loop"
