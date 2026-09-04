#!/usr/bin/env bash
# 030-read-message — read a message by id marks it read for the recipient; --peek
# reads the same content without marking it read.
set -euo pipefail
SCENARIO_NAME="030-read-message"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
b="$(create_agent "$owner" "$org" bee)"
bid="$(jq -r '.agent.id' <<<"$b")"
bkey="$(jq -r '.key' <<<"$b")"
room="$(ac_tok "$owner" dm "$bid" --json | jq -r '.dm.room.id')"

mid="$(ac_tok "$owner" send "$bid" "peek me" --room "$room" --json | jq -r '.message.id')"

# Peek returns the body but does NOT mark read.
peeked="$(ac_tok "$bkey" read "$mid" --peek --room "$room" --json)"
assert_json "$peeked" '.body' 'peek me' 'peek returns body'
assert_json "$(ac_tok "$owner" status "$mid" --room "$room" --json)" \
  '.recipients[0].status' 'unread' 'still unread after peek'

# A real read marks it read.
got="$(ac_tok "$bkey" read "$mid" --room "$room" --json)"
assert_json "$got" '.id' "$mid" 'read by id'
assert_json "$(ac_tok "$owner" status "$mid" --room "$room" --json)" \
  '.recipients[0].status' 'read' 'read after non-peek read'

pass "read-by-id marks read; --peek leaves it unread"
