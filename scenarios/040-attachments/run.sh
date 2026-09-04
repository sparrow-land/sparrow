#!/usr/bin/env bash
# 040-attachments — send a file attachment; the recipient downloads it; the bytes
# are identical round-trip.
set -euo pipefail
SCENARIO_NAME="040-attachments"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
b="$(create_agent "$owner" "$org" bee)"
bid="$(jq -r '.agent.id' <<<"$b")"
bkey="$(jq -r '.key' <<<"$b")"
room="$(ac_tok "$owner" dm "$bid" --json | jq -r '.dm.room.id')"

# A 4 KiB random payload.
src="$SPARROW_TMPROOT/payload.bin"
head -c 4096 /dev/urandom >"$src"

sent="$(ac_tok "$owner" send "$bid" "here is a file" --attach "$src" --room "$room" --json)"
mid="$(jq -r '.message.id' <<<"$sent")"
assert_json "$sent" '.message.attachments | length' '1' 'one attachment on the message'
assert_json "$sent" '.message.attachments[0].filename' 'payload.bin' 'attachment filename'

# B pops → sees the attachment id, downloads it.
popped="$(ac_tok "$bkey" pop --room "$room" --json)"
aid="$(jq -r '.message.attachments[0].id' <<<"$popped")"
[ -n "$aid" ] && [ "$aid" != null ] || fail "no attachment id on popped message"

out="$SPARROW_TMPROOT/downloaded.bin"
ac_tok "$bkey" attachment get "$aid" -o "$out" --room "$room" >/dev/null

cmp -s "$src" "$out" || fail "downloaded bytes differ from the source"

pass "attachment round-tripped byte-for-byte ($(wc -c <"$out") bytes)"
