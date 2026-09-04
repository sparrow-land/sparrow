#!/usr/bin/env bash
# 090-suggested-replies — a message carries 1–4 reply chips; a reply echoes the
# structured inReplyTo/replyValue; validation rejects >4, replyValue without
# inReplyTo, and an unreadable inReplyTo.
set -euo pipefail
SCENARIO_NAME="090-suggested-replies"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
ownid="$(ac_tok "$owner" whoami --json | jq -r '.id')"
b="$(create_agent "$owner" "$org" bee)"; bid="$(jq -r '.agent.id' <<<"$b")"; bkey="$(jq -r '.key' <<<"$b")"
room="$(ac_tok "$owner" dm "$bid" --json | jq -r '.dm.room.id')"

# Owner asks a closable question with two chips.
sent="$(ac_tok "$owner" send "$bid" "Ship it?" --suggest "Ship it=ship" --suggest "Hold=hold" --room "$room" --json)"
mid="$(jq -r '.message.id' <<<"$sent")"
assert_json "$sent" '.message.suggestedReplies | length' '2' 'two suggestions attached'
assert_json "$sent" '.message.suggestedReplies[0].value' 'ship' 'first suggestion value'

# B pops and answers with the structured echo.
ac_tok "$bkey" pop --room "$room" --json >/dev/null
reply="$(ac_tok "$bkey" send "$ownid" "shipping now" --in-reply-to "$mid" --reply-value ship --room "$room" --json)"
assert_json "$reply" '.message.inReplyTo' "$mid" 'reply references the question'
assert_json "$reply" '.message.replyValue' 'ship' 'reply carries the chosen value'

# Validation (raw API for exact status codes).
five='{"to":"all","body":"x","suggestedReplies":[{"label":"a"},{"label":"b"},{"label":"c"},{"label":"d"},{"label":"e"}]}'
assert_eq 400 "$(http_status "$owner" POST "/rooms/$room/messages" "$five")" '>4 suggestions → 400'
assert_eq 400 "$(http_status "$owner" POST "/rooms/$room/messages" '{"to":"all","body":"x","replyValue":"ship"}')" 'replyValue without inReplyTo → 400'
assert_eq 404 "$(http_status "$owner" POST "/rooms/$room/messages" '{"to":"all","body":"x","inReplyTo":"msg_doesnotexist"}')" 'unreadable inReplyTo → 404'

pass "suggested-reply chips, structured echo, and all three validations verified"
