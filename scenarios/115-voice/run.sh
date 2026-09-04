#!/usr/bin/env bash
# 115-voice — the VOICE_PROVIDER=fake stack: capabilities booleans reflect the
# registered providers; principal-scoped transcription returns the deterministic
# transcript (and 401s unauthenticated); a message sent with origin:voice records
# provenance the recipient sees (JSON + human-readable [voice] chip); /speech
# synthesizes byte-stable audio (cached — identical across two fetches) for every
# room member (sender, recipient, or neither) and 403s an org member who is not
# in the room; an invalid origin is a 400. Both stacks also report
# capabilities.email — a medium's on/off lives on /capabilities, never on a 404.
# A second, keyless stack (no VOICE_PROVIDER) reports every capability false and
# 404s every voice route.
set -euo pipefail
SCENARIO_NAME="115-voice"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

# --- fetch /speech to a file, echo the numeric status; capture headers too.
speech_fetch() { # <token> <roomId> <messageId> <bodyfile> <hdrfile>
  curl -sS -o "$4" -D "$5" -w '%{http_code}' \
    "$SERVER/api/v1/rooms/$2/messages/$3/speech" \
    -H "authorization: Bearer $1"
}

# ===========================================================================
# Stack 1 — VOICE_PROVIDER=fake (providers registered).
# ===========================================================================
SCENARIO_EXTRA_ENV=(VOICE_PROVIDER=fake)
scenario_start

# 1) Capabilities (no auth) reflect the registered fake provider.
caps="$(curl -fsS "$SERVER/api/v1/capabilities")" || fail "GET /capabilities failed"
assert_json "$caps" '.voice.stt' 'true' 'fake stack: voice.stt true'
assert_json "$caps" '.voice.tts' 'true' 'fake stack: voice.tts true'
# v4: /capabilities is where a client learns a MEDIUM is on — never a 404 from
# its routes. Voice being on says nothing about email; this stack has no email
# provider, so it reads false.
assert_json "$caps" '.email' 'false' 'fake voice stack: capabilities.email false'

# Bootstrap: owner human + agent B, and their DM room.
owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
b="$(create_agent "$owner" "$org" bee)"
bid="$(jq -r '.agent.id' <<<"$b")"
bkey="$(jq -r '.key' <<<"$b")"
room="$(ac_tok "$owner" dm "$bid" --json | jq -r '.dm.room.id')"

# 2) Principal-scoped transcription of a small audio payload → fixed transcript.
audio_b64="$(printf 'hello' | base64 | tr -d '\n')"
tbody="$(jq -cn --arg a "$audio_b64" '{audioBase64:$a, contentType:"audio/mpeg"}')"
tresp="$(api "$owner" POST /voice/transcriptions "$tbody")" || fail "transcription request failed"
assert_json "$tresp" '.text' 'fake transcript' 'transcription returns the fake transcript'

# 3) Unauthenticated transcription → 401.
assert_eq 401 "$(http_status "" POST /voice/transcriptions "$tbody")" 'unauthenticated transcription → 401'

# 4) Send with origin:voice; recipient sees the provenance (JSON + [voice] chip).
sent="$(ac_tok "$owner" send "$bid" 'spoken words' --subject dictated --origin voice --room "$room" --json)"
mid="$(jq -r '.message.id' <<<"$sent")"
assert_json "$sent" '.message.origin' 'voice' 'sent message records origin:voice'

popped="$(ac_tok "$bkey" pop --room "$room" --json)"
assert_json "$popped" '.message.id' "$mid" 'B pops the dictated message'
assert_json "$popped" '.message.origin' 'voice' 'recipient sees origin:voice'

human="$(ac_tok "$bkey" read "$mid" --peek --room "$room")"
assert_contains "$human" '[voice]' 'human-readable read shows the [voice] chip'

# 5) /speech: byte-stable, cached, audio/mpeg — for recipient and sender.
b1="$SPARROW_TMPROOT/speech-1.mp3"; h1="$SPARROW_TMPROOT/speech-1.hdr"
b2="$SPARROW_TMPROOT/speech-2.mp3"; h2="$SPARROW_TMPROOT/speech-2.hdr"
assert_eq 200 "$(speech_fetch "$bkey" "$room" "$mid" "$b1" "$h1")" 'recipient /speech #1 → 200'
assert_eq 200 "$(speech_fetch "$bkey" "$room" "$mid" "$b2" "$h2")" 'recipient /speech #2 → 200'
grep -qi '^content-type: *audio/mpeg' "$h1" || fail "/speech content-type is not audio/mpeg"
cmp -s "$b1" "$b2" || fail "/speech bytes differ across two fetches (cache not stable)"
[ -s "$b1" ] || fail "/speech returned an empty body"

# Sender may also fetch.
bs="$SPARROW_TMPROOT/speech-sender.mp3"; hs="$SPARROW_TMPROOT/speech-sender.hdr"
assert_eq 200 "$(speech_fetch "$owner" "$room" "$mid" "$bs" "$hs")" 'sender /speech → 200'
cmp -s "$b1" "$bs" || fail "sender /speech bytes differ from recipient's (same cached message)"

# 5b) /speech is member-gated, NOT party-gated: "any room member (same authz as
# GetAttachment)" (SPEC → Voice route table), and "any current member reads every
# message in the room (the same rule ReadMessage / GetMessageStatus /
# GetAttachment now enforce)" (SPEC → Room history). Build a 3-member room (owner
# + agents B and C); owner sends a targeted message to B, so C is a member but
# neither party — and still hears it. Recipient rows are delivery state, never
# visibility.
room3="$(ac_tok "$owner" room create crew --json | jq -r '.id')"
ac_tok "$owner" room add "$bid" --room "$room3" >/dev/null
c="$(create_agent "$owner" "$org" cee)"
cid_agent="$(jq -r '.agent.id' <<<"$c")"
ckey="$(jq -r '.key' <<<"$c")"
ac_tok "$owner" room add "$cid_agent" --room "$room3" >/dev/null
sent3="$(ac_tok "$owner" send "$bid" 'targeted at B' --room "$room3" --json)"
mid3="$(jq -r '.message.id' <<<"$sent3")"
assert_eq 200 "$(http_status "$bkey" GET "/rooms/$room3/messages/$mid3/speech")" 'recipient C-room /speech → 200'
assert_eq 200 "$(http_status "$ckey" GET "/rooms/$room3/messages/$mid3/speech")" 'non-party ROOM MEMBER /speech → 200 (member-gated)'
# An ORG member with no member row in that room is refused: "an org member
# without a member row in the room → 403" (SPEC → Addressing).
outsider="$(add_human_to_org "$owner" "$org" outsider@ex.com password123 Outsider)"
assert_eq 403 "$(http_status "$outsider" GET "/rooms/$room3/messages/$mid3/speech")" 'org member, not in the room → 403'

# 7) An invalid origin value via raw curl → 400.
badbody="$(jq -cn --arg to "$bid" '{to:$to, body:"typed", origin:"email"}')"
assert_eq 400 "$(http_status "$owner" POST "/rooms/$room/messages" "$badbody")" "origin:'email' → 400"

# ===========================================================================
# Stack 2 — keyless (no VOICE_PROVIDER): every voice route 404s.
# ===========================================================================
docker rm -fv "$SPARROW_CID" >/dev/null 2>&1 || true
SPARROW_CID=""
SCENARIO_EXTRA_ENV=()
scenario_start

caps2="$(curl -fsS "$SERVER/api/v1/capabilities")" || fail "keyless GET /capabilities failed"
assert_json "$caps2" '.voice.stt' 'false' 'keyless stack: voice.stt false'
assert_json "$caps2" '.voice.tts' 'false' 'keyless stack: voice.tts false'
assert_json "$caps2" '.email' 'false' 'keyless stack: capabilities.email false'

# Fresh DB — bootstrap a principal and a message to reach the provider gate.
owner2="$(signup owner@ex.com password123 Owner)"
org2="$(first_org_id "$owner2")"
b2="$(create_agent "$owner2" "$org2" bee)"
bid2="$(jq -r '.agent.id' <<<"$b2")"
bkey2="$(jq -r '.key' <<<"$b2")"
room2="$(ac_tok "$owner2" dm "$bid2" --json | jq -r '.dm.room.id')"
sent2="$(ac_tok "$owner2" send "$bid2" 'no voice here' --room "$room2" --json)"
mid2="$(jq -r '.message.id' <<<"$sent2")"

# Valid auth, but no STT provider → 404 (not 401/502).
assert_eq 404 "$(http_status "$owner2" POST /voice/transcriptions "$tbody")" 'keyless transcription (authed) → 404'
# Speech route with a real member+message but no TTS provider → 404.
assert_eq 404 "$(http_status "$bkey2" GET "/rooms/$room2/messages/$mid2/speech")" 'keyless /speech → 404'

pass "fake-stack capabilities/transcribe/origin/speech-cache + keyless 404s verified"
