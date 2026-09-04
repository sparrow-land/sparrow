#!/usr/bin/env bash
# 025-inbox-preview — a long message shows a truncated 200-char preview; the
# unread-only inbox hides read messages, --all reveals them.
set -euo pipefail
SCENARIO_NAME="025-inbox-preview"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
b="$(create_agent "$owner" "$org" bee)"
bid="$(jq -r '.agent.id' <<<"$b")"
bkey="$(jq -r '.key' <<<"$b")"
room="$(ac_tok "$owner" dm "$bid" --json | jq -r '.dm.room.id')"

# A 300-char body → preview is the first 200 chars, truncated.
long="$(printf 'x%.0s' $(seq 1 300))"
sent="$(ac_tok "$owner" send "$bid" "$long" --room "$room" --json)"
mid="$(jq -r '.message.id' <<<"$sent")"

inbox="$(ac_tok "$bkey" inbox --room "$room" --json)"
assert_json "$inbox" '.items | length' '1' 'one unread item'
assert_json "$inbox" '.items[0].preview | length' '200' 'preview truncated to 200 chars'
assert_json "$inbox" '.items[0].truncated' 'true' 'truncated flag set'
assert_json "$inbox" '.items[0].attachmentCount' '0' 'no attachments'
# Listing the inbox IS delivery (trigger b of the received state), so the
# returned item already reads 'received'.
assert_json "$inbox" '.items[0].status' 'received' 'status received on listing'

# Read it (pop marks read); unread-only inbox empties.
ac_tok "$bkey" pop --room "$room" --json >/dev/null
assert_json "$(ac_tok "$bkey" inbox --room "$room" --json)" '.items | length' '0' 'unread inbox empty'

# --all shows the now-read message.
allbox="$(ac_tok "$bkey" inbox --all --room "$room" --json)"
assert_json "$allbox" "[.items[] | select(.id == \"$mid\")] | length" '1' '--all includes the read message'
assert_json "$allbox" ".items[] | select(.id == \"$mid\") | .status" 'read' 'shown as read'

pass "long message truncated to 200-char preview; --all reveals read messages"
