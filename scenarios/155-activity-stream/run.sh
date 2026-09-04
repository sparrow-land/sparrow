#!/usr/bin/env bash
# 155-activity-stream — the unified timeline, ACROSS MEDIUMS. A chat message, an
# inbound email, a chat reply and an outbound email reply append four typed
# entries to the ONE append-only journal, interleaved in `createdAt` order:
# `chat.message` (medium `chat`, refs `{roomId, messageId}`) alongside
# `email.received` / `email.sent` (medium `email`, refs `{emailThreadId,
# emailId}`), each with the actor frozen at append time — the contact who wrote
# in, the agent that answered. The timeline is a TRANSCRIPT: the wire descends
# (`--json` is the raw newest-first page plus `nextBefore`), while the human
# render reverses to oldest-first reading order — exactly as `sparrow log` does
# for a room. The agent sees its own, the owner reads its agent's through the
# per-agent org route, and `--medium` narrows to one half.
#
# Entries are REFS (ids + type + medium, never bodies): the timeline is the
# index, the medium routes are the store — a chat body comes from
# `sparrow read`, an email body from `sparrow email read`. The owner's open
# /me/events carries exactly one `activity.appended` per entry, in both mediums.
# And a timeline is correspondence, not room data: an org member holding only
# `canAccessAgent` visibility gets 404 — never 403 — on the agent's timeline AND
# on its email threads.
set -euo pipefail
SCENARIO_NAME="155-activity-stream"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

# The fake email stack, so the timeline has two mediums to interleave.
SCENARIO_EXTRA_ENV=(
  EMAIL_PROVIDER=fake
  EMAIL_ORG_SUFFIX=.example.com
  EMAIL_INBOUND_TOKEN=scenario-inbound
)
scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
ownid="$(ac_tok "$owner" whoami --json | jq -r '.id')"
slug="$(api "$owner" GET "/orgs/$org" | jq -r '.org.slug')"

b="$(create_agent "$owner" "$org" bee)"
bid="$(jq -r '.agent.id' <<<"$b")"
bkey="$(jq -r '.key' <<<"$b")"
room="$(ac_tok "$owner" dm "$bid" --json | jq -r '.dm.room.id')"
addr="bee@${slug}.example.com"

# One org policy line so the external correspondent is RECOGNIZED and the trust
# engine stays out of the way — this scenario is about the timeline, not the
# ladder (that is 135). A wildcard local part over a concrete domain is the
# canonical valid pattern.
api "$owner" PATCH "/orgs/$org" \
  '{"settings":{"email":{"trustedPatterns":["*@partner.example.com"]}}}' >/dev/null

# Nothing has happened yet — a timeline that has never been written is empty,
# not an error.
assert_json "$(ac_tok "$owner" activity --json)" '.items | length' '0' 'no activity before any send'
assert_contains "$(ac_tok "$owner" activity)" 'No activity.' 'empty timeline prints "No activity."'

# --- four events, alternating medium ----------------------------------------
# 1) a chat message in
s1="$(ac_tok "$owner" send "$bid" 'ship the build' --subject deploy --room "$room" --json)"
mid1="$(jq -r '.message.id' <<<"$s1")"
sleep 0.2
# 2) an email in, from an external contact the org policy recognizes
inj="$(admin_api POST /admin/email/inject "$(jq -cn --arg to "$addr" \
  '{rfcMessageId:"<r1@mail.example.net>",
    from:{email:"dana@partner.example.com",name:"Dana Lee"},
    to:[{email:$to}], subject:"Q3 rollout",
    text:"can we get the numbers by friday?",
    verification:{spf:"pass",dkim:"pass",dmarc:"pass",domain:"partner.example.com"}}')")"
assert_json "$inj" '.status' 'delivered' 'the inbound email delivered'
eml1="$(jq -r '.email.id' <<<"$inj")"
eth1="$(jq -r '.email.threadId' <<<"$inj")"
sleep 0.2
# 3) a chat message out
s2="$(ac_tok "$bkey" send "$ownid" 'build is green' --subject status --room "$room" --json)"
mid2="$(jq -r '.message.id' <<<"$s2")"
sleep 0.2
# 4) an email out, in that thread
rep="$(ac_tok "$bkey" email reply 'the numbers are attached' --to "$eml1" --json)"
assert_json "$rep" '.disposition' 'sent' 'the reply relayed (the recipient is recognized)'
eml2="$(jq -r '.id' <<<"$rep")"

# --- GET /me/activity: the caller's own timeline, NEWEST first --------------
act="$(ac_tok "$owner" activity --json)"
assert_json "$act" '.items | length' '4' 'all four events appended an entry'
assert_json "$act" '[.items[] | select(.medium == "chat")] | length' '2' 'two entries on the chat medium'
assert_json "$act" '[.items[] | select(.medium == "email")] | length' '2' 'two entries on the email medium'

# Interleaved chronological order ACROSS mediums — read backward from now, so
# the reply pair comes first: email, chat, email, chat. Not two medium blocks.
assert_json "$act" '[.items[].type] | join(",")' \
  'email.sent,chat.message,email.received,chat.message' \
  'the two mediums interleave in one descending stream'
assert_json "$act" '[.items[].medium] | join(",")' 'email,chat,email,chat' \
  'and the medium alternates with them'
assert_json "$act" '.nextBefore' 'null' 'a complete page names no older cursor'

# The chat half: refs, actors, summary. The OLDEST entry is now the last row.
assert_json "$act" '.items[3].refs.messageId' "$mid1" 'the oldest entry refs the first message'
assert_json "$act" '.items[3].refs.roomId' "$room" 'a chat entry refs its room'
assert_json "$act" '.items[3].agent.id' "$bid" 'entries are anchored on the involved agent'
assert_json "$act" '.items[3].actor.kind' 'human' 'the human send has a human actor'
assert_json "$act" '.items[3].actor.displayName' 'Owner' 'the actor label is frozen on the entry'
assert_json "$act" '.items[3].summary' 'deploy' 'the subject becomes the entry summary'
assert_json "$act" '.items[1].refs.messageId' "$mid2" 'the second-newest entry refs the second message'
assert_json "$act" '.items[1].actor.kind' 'agent' "the agent's reply has an agent actor"
assert_json "$act" '.items[1].actor.id' "$bid" 'the agent actor is the agent itself'

# The email half: `email.received` is actored by the SENDER, `email.sent` by the
# agent — the sender rides on `actor`, never on `refs`.
assert_json "$act" '.items[2].type' 'email.received' 'an inbound email appends email.received'
assert_json "$act" '.items[2].medium' 'email' 'on the email medium'
assert_json "$act" '.items[2].agent.id' "$bid" 'anchored on the agent whose mailbox it reached'
assert_json "$act" '.items[2].refs.emailId' "$eml1" 'refs carry the email id'
assert_json "$act" '.items[2].refs.emailThreadId' "$eth1" 'and the thread id'
assert_json "$act" '.items[2].actor.kind' 'contact' 'the actor is the external sender'
assert_json "$act" '.items[2].actor.displayName' 'Dana Lee' 'named as they wrote in'
assert_json "$act" '.items[2].summary' 'Q3 rollout' 'the subject becomes the summary here too'
assert_json "$act" '.items[0].type' 'email.sent' "the agent's reply appends email.sent"
assert_json "$act" '.items[0].refs.emailId' "$eml2" 'refs carry the reply'
assert_json "$act" '.items[0].refs.emailThreadId' "$eth1" 'in the same thread'
assert_json "$act" '.items[0].actor.kind' 'agent' 'an outbound email is actored by the agent'
assert_json "$act" '.items[0].actor.id' "$bid" 'that agent'

# Entries are REFS, never payloads: no body rides along, and no other medium's
# refs are set on an entry. Bodies come from the medium's own routes.
assert_json "$act" '.items[3] | has("body")' 'false' 'an entry carries no message body'
assert_json "$act" '.items[3] | has("message")' 'false' 'an entry carries no message payload'
assert_json "$act" '.items[3].refs | has("emailId")' 'false' 'a chat entry sets no email refs'
assert_json "$act" '.items[2] | has("body")' 'false' 'an email entry carries no body either'
assert_json "$act" '.items[2] | has("text")' 'false' 'and no text'
assert_json "$act" '.items[2] | has("email")' 'false' 'and no email payload'
assert_json "$act" '.items[2].refs | has("messageId")' 'false' 'an email entry sets no chat refs'
assert_json "$act" '.items[2].refs | has("roomId")' 'false' 'not even a room id'
# Each ref fetches its body from its own medium's route.
assert_json "$(ac_tok "$owner" read "$mid1" --peek --room "$room" --json)" '.body' \
  'ship the build' 'the chat body fetches from the chat route the ref points at'
assert_json "$(ac_tok "$bkey" email read "$eml1" --json)" '.text' \
  'can we get the numbers by friday?' 'the email body fetches from `sparrow email read <emlId>`'

# Reading a timeline WRITES nothing: the agent's chat inbox is still unread.
assert_json "$(ac_tok "$bkey" inbox --room "$room" --json)" '.items | length' '1' \
  'reading the timeline consumed nothing'

# Human-readable rendering names the medium, the parties and the summary.
human="$(ac_tok "$owner" activity)"
assert_contains "$human" '[chat]' 'human timeline tags the chat medium'
assert_contains "$human" '[email]' 'human timeline tags the email medium'
assert_contains "$human" 'Owner → bee' 'human timeline reads actor → agent'
assert_contains "$human" 'Dana Lee → bee' 'an email entry reads the same way'
assert_contains "$human" 'deploy' 'human timeline shows the summary'
assert_contains "$human" "$mid1" 'human timeline shows the chat ref to fetch'
assert_contains "$human" "$eml1" 'human timeline shows the email ref to fetch'

# --medium narrows to one half of one journal.
assert_json "$(ac_tok "$owner" activity --medium chat --json)" '.items | length' '2' '--medium chat matches both chat entries'
memail="$(ac_tok "$owner" activity --medium email --json)"
assert_json "$memail" '.items | length' '2' '--medium email matches both email entries'
assert_json "$memail" '[.items[].type] | join(",")' 'email.sent,email.received' \
  '--medium email keeps the journal order (still newest-first)'

# The agent's own /me/activity is its timeline (agent_id = me).
assert_json "$(ac_tok "$bkey" activity --json)" '.items | length' '4' 'the agent sees its own timeline'

# --- the per-agent route: the owner watches its agent ----------------------
agent_act="$(ac_tok "$owner" activity --agent bee --json)"
assert_json "$agent_act" '.items | length' '4' "owner reads the agent's timeline by name"
assert_json "$agent_act" '.items[3].refs.messageId' "$mid1" 'per-agent timeline is the same journal, same order'
assert_json "$agent_act" '.items[2].refs.emailId' "$eml1" 'email entries included, in place'
assert_eq 200 "$(http_status "$owner" GET "/orgs/$org/agents/$bid/activity")" 'owner → 200 on the raw per-agent route'

# --- a non-owner org member with only canAccessAgent visibility → 404 ------
g="$(add_human_to_org "$owner" "$org" grantee@ex.com password123 Grantee)"
api "$owner" POST "/me/agents/$bid/share" '{"human":"grantee@ex.com"}' >/dev/null
assert_json "$(api "$g" GET /me/agents)" "[.items[] | select(.agent.id == \"$bid\")] | length" '1' \
  'the grantee really does have canAccessAgent visibility'
# Visibility is not readership: the timeline is correspondence, and so is the
# mail it indexes. 404, never 403 — the agent's existence must not leak through
# the status code, and the same rule governs BOTH surfaces.
assert_eq 404 "$(http_status "$g" GET "/orgs/$org/agents/$bid/activity")" \
  'a member with only canAccessAgent gets 404 on the agent timeline'
assert_json "$(api_raw "$g" GET "/orgs/$org/agents/$bid/activity")" '.error.code' 'not_found' \
  'the refusal is a plain not_found envelope'
assert_eq 404 "$(http_status "$g" GET "/orgs/$org/agents/$bid/email/threads")" \
  'and 404 on the agent’s email threads — a colleague may DM it, never read its mail'
assert_json "$(api_raw "$g" GET "/orgs/$org/agents/$bid/email/threads")" '.error.code' 'not_found' \
  'same plain not_found envelope on the mail surface'
assert_eq 404 "$(http_status "$g" GET "/orgs/$org/email/emails/$eml1")" \
  'nor may they open one of its emails by id'
# The grantee's OWN timeline is unaffected — and empty, since nothing involves them.
assert_json "$(ac_tok "$g" activity --json)" '.items | length' '0' "the grantee's own timeline is empty"

# --- /me/events carries one activity.appended per entry, live, both mediums -
ev="$SPARROW_TMPROOT/owner-events.jsonl"
epid="$(sse_me_watch "$owner" "$ev")"
sleep 1
s3="$(ac_tok "$bkey" send "$ownid" 'one more' --subject third --room "$room" --json)"
mid3="$(jq -r '.message.id' <<<"$s3")"
wait_for_line "$ev" '"type":"activity.appended"' \
  || { kill "$epid" 2>/dev/null || true; fail "no activity.appended on the owner's /me/events"; }
# A second inbound email while the same stream is open: the email medium's
# entries are live on /me/events too, not fetch-only.
inj2="$(admin_api POST /admin/email/inject "$(jq -cn --arg to "$addr" \
  '{rfcMessageId:"<r2@mail.example.net>",
    from:{email:"dana@partner.example.com",name:"Dana Lee"},
    to:[{email:$to}], subject:"one last thing",
    text:"and the headcount plan too",
    verification:{spf:"pass",dkim:"pass",dmarc:"pass",domain:"partner.example.com"}}')")"
eml3="$(jq -r '.email.id' <<<"$inj2")"
wait_for_line "$ev" "$eml3" \
  || { kill "$epid" 2>/dev/null || true; fail "no live activity.appended for the email entry"; }
sleep 0.5
kill "$epid" 2>/dev/null || true

appended="$(grep -F '"type":"activity.appended"' "$ev" | grep -cF "$mid3" || true)"
assert_eq 1 "$appended" 'exactly one activity.appended for the new chat entry'
grep -F '"type":"activity.appended"' "$ev" | grep -qF '"medium":"chat"' \
  || fail "activity.appended does not carry the typed chat entry"
email_appended="$(grep -F '"type":"activity.appended"' "$ev" | grep -cF "$eml3" || true)"
assert_eq 1 "$email_appended" 'exactly one activity.appended for the new email entry'
grep -F '"type":"activity.appended"' "$ev" | grep -F "$eml3" | grep -qF '"medium":"email"' \
  || fail "the email activity.appended does not carry medium:email"
grep -F '"type":"activity.appended"' "$ev" | grep -F "$eml3" | grep -qF '"type":"email.received"' \
  || fail "the email activity.appended does not carry type:email.received"

# The live events and the fetched timeline agree.
final="$(ac_tok "$owner" activity --json)"
assert_json "$final" '.items | length' '6' 'both new entries are on the timeline too'
assert_json "$final" '.items[0].refs.emailId' "$eml3" 'the newest entry — the email — is row one'
assert_json "$final" '.items[0].type' 'email.received' 'still typed by its medium'
assert_json "$final" '.items[1].refs.messageId' "$mid3" 'the chat entry sits just behind it'

pass "chat and email append typed refs into one interleaved journal; me + per-agent timelines agree; live activity.appended in both mediums; non-owner 404 on timeline AND mail"
