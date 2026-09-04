#!/usr/bin/env bash
# 020-send-and-pop — A (owner) DMs B (agent); B pops; A sees the recipient status
# flip unread → read; B's unread inbox empties.
set -euo pipefail
SCENARIO_NAME="020-send-and-pop"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"

# Mint agent B and ensure the owner↔B DM room.
b="$(create_agent "$owner" "$org" bee)"
bid="$(jq -r '.agent.id' <<<"$b")"
bkey="$(jq -r '.key' <<<"$b")"
room="$(ac_tok "$owner" dm "$bid" --json | jq -r '.dm.room.id')"

# A sends a DM to B.
sent="$(ac_tok "$owner" send "$bid" "hello bee" --subject greeting --room "$room" --json)"
mid="$(jq -r '.message.id' <<<"$sent")"
assert_json "$sent" '.message.kind' 'dm' 'message kind is dm'

# Before pop: status unread.
assert_json "$(ac_tok "$owner" status "$mid" --room "$room" --json)" \
  '.recipients[0].status' 'unread' 'status unread before pop'

# B pops the oldest unread — this message, marked read.
popped="$(ac_tok "$bkey" pop --room "$room" --json)"
assert_json "$popped" '.message.id' "$mid" 'popped message id'
assert_json "$popped" '.message.body' 'hello bee' 'popped body'
assert_json "$popped" '.message.from.displayName' 'Owner' 'popped sender'

# After pop: A sees the recipient status read.
assert_json "$(ac_tok "$owner" status "$mid" --room "$room" --json)" \
  '.recipients[0].status' 'read' 'status read after pop'

# B's unread inbox is empty.
assert_json "$(ac_tok "$bkey" inbox --room "$room" --json)" '.items | length' '0' 'inbox empty after pop'

pass "DM $mid delivered, popped, and marked read"
