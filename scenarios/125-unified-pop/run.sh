#!/usr/bin/env bash
# 125-unified-pop — ONE loop, one queue, TWO MEDIUMS. A chat DM, an inbound
# email and a project-room message land for the same agent; successive
# `sparrow pop`s hand them back as typed WORK ITEMS in arrival order —
# `{ type: 'chat.message', message, room }` then `{ type: 'email', email,
# thread }` — each carrying only its own medium's refs, interleaved by
# `createdAt` across mediums rather than concatenated medium by medium. An agent
# runs one loop: it does not poll a chat inbox and an email inbox.
#
# Also here: `sparrow inbox` renders both variants of the union and `--medium`
# narrows to one; the human-readable drain leads with the medium (`[room: …]`
# for chat, `[email: …]` for email); the `{ack,note,ttlSeconds}` body still sets
# a working status on a chat item and is accepted-and-ignored on an email one
# (an email has no room and no member to scope a status to); a drained queue is
# `{ item: null }`, never a 404; and the room-scoped `pop --room` keeps its v3
# `{ message, room }` shape untouched, because room routes are the chat medium's
# own surface.
set -euo pipefail
SCENARIO_NAME="125-unified-pop"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

# The fake email stack, so BOTH mediums exist in one queue.
SCENARIO_EXTRA_ENV=(
  EMAIL_PROVIDER=fake
  EMAIL_ORG_SUFFIX=.example.com
  EMAIL_INBOUND_TOKEN=scenario-inbound
)
scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
slug="$(api "$owner" GET "/orgs/$org" | jq -r '.org.slug')"

b="$(create_agent "$owner" "$org" bee)"
bid="$(jq -r '.agent.id' <<<"$b")"
bkey="$(jq -r '.key' <<<"$b")"
addr="bee@${slug}.example.com"
assert_json "$(ac_tok "$bkey" email address --json)" '.address' "$addr" \
  "the agent has a mailbox as well as rooms"

# Three sources of work for the SAME agent: its owner DM, its mailbox, and a
# project room.
dmroom="$(ac_tok "$owner" dm "$bid" --json | jq -r '.dm.room.id')"
proom="$(ac_tok "$owner" room create deploys --json | jq -r '.id')"
ac_tok "$owner" room add "$bid" --room "$proom" >/dev/null

# Empty queue BEFORE anything arrives: `{ item: null }`, exit 0, and the
# human-readable form says so plainly.
empty0="$(ac_tok "$bkey" pop --json)"
assert_json "$empty0" '.item' 'null' 'fresh queue → item: null'
assert_contains "$(ac_tok "$bkey" pop)" 'Inbox empty.' 'empty queue prints "Inbox empty."'

# --- arrival order, ACROSS mediums: DM chat, then email, then project chat ---
s1="$(ac_tok "$owner" send "$bid" 'dm hello' --subject greeting --room "$dmroom" --json)"
mid1="$(jq -r '.message.id' <<<"$s1")"
sleep 0.2
# The sender is the org's own human, so the trust ladder recognizes it (entry 1)
# and the default `reject` policy is never consulted — this scenario is about the
# QUEUE, not the trust engine (that is 135/140).
inj="$(admin_api POST /admin/email/inject "$(jq -cn --arg to "$addr" \
  '{rfcMessageId:"<q1@mail.example.net>",
    from:{email:"owner@ex.com",name:"Owner"},
    to:[{email:$to}], subject:"Q3 rollout",
    text:"can we get the numbers by friday?",
    verification:{spf:"pass",dkim:"pass",dmarc:"pass",domain:"ex.com"}}')")"
assert_json "$inj" '.status' 'delivered' 'the inbound email delivered'
eml1="$(jq -r '.email.id' <<<"$inj")"
eth1="$(jq -r '.email.threadId' <<<"$inj")"
sleep 0.2
s2="$(ac_tok "$owner" send "$bid" 'project hello' --subject deploy --room "$proom" --json)"
mid2="$(jq -r '.message.id' <<<"$s2")"

# --- /me/inbox: one list, two variants of the union ------------------------
inbox="$(ac_tok "$bkey" inbox --json)"
assert_json "$inbox" '.items | length' '3' 'the unified inbox lists both mediums'
assert_json "$inbox" '[.items[] | select(.type == "chat.message")] | length' '2' 'two chat previews'
assert_json "$inbox" '[.items[] | select(.type == "email")] | length' '1' 'one email preview'
assert_json "$inbox" '.items[1].type' 'email' 'previews interleave in arrival order too'
assert_json "$inbox" '.items[1].id' "$eml1" 'the email preview is that email'
assert_json "$inbox" '.items[1].thread.id' "$eth1" 'the email preview carries its thread'
assert_json "$inbox" '.items[1].from.email' 'owner@ex.com' 'an email preview names the sender by address'
assert_json "$inbox" '.items[1].disposition' 'delivered' 'an email preview carries its disposition'
assert_json "$inbox" '.items[1] | has("room")' 'false' 'an email preview has no room'
assert_json "$inbox" '.items[0] | has("thread")' 'false' 'a chat preview has no thread'
# --medium narrows to one half of the union.
assert_json "$(ac_tok "$bkey" inbox --medium email --json)" '.items | length' '1' '--medium email narrows'
assert_json "$(ac_tok "$bkey" inbox --medium email --json)" '.items[0].id' "$eml1" \
  '--medium email is the email item'
assert_json "$(ac_tok "$bkey" inbox --medium chat --json)" '.items | length' '2' '--medium chat narrows'
# Listing marks nothing on the email half — read state is popping, not listing.
assert_json "$(ac_tok "$bkey" inbox --medium email --json)" '.items[0].status' 'unread' \
  'listing never marks an email read'
# The human-readable table leads with the medium for both rows.
inbox_human="$(ac_tok "$bkey" inbox)"
assert_contains "$inbox_human" 'MEDIUM' 'the unified inbox table leads with the medium column'
assert_contains "$inbox_human" "$eth1" 'the email row names the thread it lives in'

# --- pop #1: the DM, as a typed work item -----------------------------------
p1="$(ac_tok "$bkey" pop --json)"
assert_json "$p1" 'has("item")' 'true' 'the envelope is { item }'
assert_json "$p1" 'has("message")' 'false' "v3's top-level message is gone"
assert_json "$p1" 'has("room")' 'false' "v3's top-level room is gone"
assert_json "$p1" '.item.type' 'chat.message' 'pop #1 type is chat.message'
assert_json "$p1" '.item.message.id' "$mid1" 'pop #1 is the DM message (oldest)'
assert_json "$p1" '.item.message.body' 'dm hello' 'pop #1 body'
assert_json "$p1" '.item.message.from.displayName' 'Owner' 'pop #1 names the sender'
assert_json "$p1" '.item.room.id' "$dmroom" 'pop #1 carries the chat medium ref: its room'
assert_json "$p1" '.item.room.kind' 'dm' 'pop #1 room is the DM'
assert_json "$p1" '.item.room.counterpart.displayName' 'Owner' 'DM room ref names the counterpart'
# The chat variant carries message+room and nothing from another medium.
assert_json "$p1" '.item | has("email")' 'false' 'a chat item carries no email ref'
assert_json "$p1" '.item | has("thread")' 'false' 'a chat item carries no thread ref'

# --- pop #2: the EMAIL, same one queue, ahead of the later chat message -----
p2="$(ac_tok "$bkey" pop --json)"
assert_json "$p2" '.item.type' 'email' 'pop #2 type is email — the queue spans mediums'
assert_json "$p2" '.item.email.id' "$eml1" 'pop #2 is the inbound email (next by createdAt)'
assert_json "$p2" '.item.email.subject' 'Q3 rollout' 'pop #2 carries the email itself'
assert_json "$p2" '.item.email.direction' 'in' 'only inbound email is work'
assert_json "$p2" '.item.thread.id' "$eth1" 'pop #2 carries the email medium ref: its thread'
assert_json "$p2" '.item.thread.subject' 'Q3 rollout' 'the thread ref names the conversation'
# The email variant carries email+thread and nothing from another medium.
assert_json "$p2" '.item | has("message")' 'false' 'an email item carries no message ref'
assert_json "$p2" '.item | has("room")' 'false' 'an email item carries no room ref'
# Popping an email is reading it: read_at is set, atomically, once.
assert_json "$(ac_tok "$bkey" email read "$eml1" --json)" '.status' 'read' 'popping the email read it'

# --- pop #3: the project room, still one queue ------------------------------
p3="$(ac_tok "$bkey" pop --json)"
assert_json "$p3" '.item.type' 'chat.message' 'pop #3 is back on the chat medium'
assert_json "$p3" '.item.message.id' "$mid2" 'pop #3 is the project message (newest)'
assert_json "$p3" '.item.room.id' "$proom" 'pop #3 carries the project room'
assert_json "$p3" '.item.room.kind' 'project' 'pop #3 room kind is project'

# --- drained ---------------------------------------------------------------
p4="$(ac_tok "$bkey" pop --json)"
assert_json "$p4" '.item' 'null' 'drained queue → item: null'
assert_json "$p4" 'has("item")' 'true' 'the empty envelope still carries the item key'

# --- the human-readable drain leads with the medium, in BOTH mediums -------
ac_tok "$owner" send "$bid" 'third one' --room "$proom" --json >/dev/null
human="$(ac_tok "$bkey" pop)"
assert_contains "$human" '[room: #deploys]' 'the popped chat item leads with its room'
assert_contains "$human" 'third one' 'the popped chat item prints the body'

admin_api POST /admin/email/inject "$(jq -cn --arg to "$addr" \
  '{rfcMessageId:"<q2@mail.example.net>",
    from:{email:"owner@ex.com",name:"Owner"},
    to:[{email:$to}], subject:"one more thing",
    text:"and the headcount plan too",
    verification:{spf:"pass",dkim:"pass",dmarc:"pass",domain:"ex.com"}}')" >/dev/null
human_email="$(ac_tok "$bkey" pop)"
assert_contains "$human_email" '[email: ' 'the popped email item leads with its thread'
assert_contains "$human_email" 'from: owner@ex.com' 'the popped email prints the envelope'
assert_contains "$human_email" 'subj: one more thing' 'the popped email prints the subject'
assert_contains "$human_email" 'and the headcount plan too' 'the popped email prints the body'
assert_not_contains "$human_email" '[room:' 'an email item never renders as a room item'

# --- { ack, note, ttlSeconds } survives on the unified pop ------------------
# The ack advertises "working", scoped to the SENDER of the popped message.
ac_tok "$owner" send "$bid" 'please handle' --room "$proom" --json >/dev/null
ac_tok "$bkey" pop --ack --note "on it" --json >/dev/null
assert_json "$(ac_tok "$owner" status list --room "$proom" --json)" \
  '[.items[] | select(.note == "on it")] | length' '1' 'pop --ack set the agent working, scoped to the sender'

# --- --ack on an EMAIL item is accepted and IGNORED ------------------------
# Working status is a room-scoped, member-scoped concept and an email has no
# room; the loop passes `ack` blindly, so this must not be an error either.
admin_api POST /admin/email/inject "$(jq -cn --arg to "$addr" \
  '{rfcMessageId:"<q3@mail.example.net>",
    from:{email:"owner@ex.com",name:"Owner"},
    to:[{email:$to}], subject:"ack me",
    text:"nothing to scope a status to",
    verification:{spf:"pass",dkim:"pass",dmarc:"pass",domain:"ex.com"}}')" >/dev/null
before_acks="$(ac_tok "$owner" status list --room "$proom" --json | jq -r '.items | length')"
acked="$(ac_tok "$bkey" pop --ack --note "should vanish" --json)"
assert_json "$acked" '.item.type' 'email' 'the acked pop really returned an email item'
assert_json "$acked" '.item.email.subject' 'ack me' 'and it is that email'
assert_json "$(ac_tok "$owner" status list --room "$proom" --json)" \
  '[.items[] | select(.note == "should vanish")] | length' '0' \
  '--ack on an email item set NO status — accepted and ignored, never an error'
assert_json "$(ac_tok "$owner" status list --room "$proom" --json)" \
  '.items | length' "$before_acks" 'and it disturbed no other status'
assert_json "$(ac_tok "$bkey" pop --json)" '.item' 'null' 'the queue is drained again'

# --- the room-scoped pop is UNCHANGED (v3 { message, room }) ---------------
# Rooms have no email, so `pop --room` never became a work-item route.
s5="$(ac_tok "$owner" send "$bid" 'room scoped' --room "$proom" --json)"
mid5="$(jq -r '.message.id' <<<"$s5")"
rp="$(ac_tok "$bkey" pop --room "$proom" --json)"
assert_json "$rp" '.message.id' "$mid5" 'room-scoped pop keeps its top-level message'
assert_json "$rp" '.room.id' "$proom" 'room-scoped pop keeps its top-level room'
assert_json "$rp" 'has("item")' 'false' 'room-scoped pop is NOT a work-item envelope'
assert_json "$(ac_tok "$bkey" pop --room "$proom" --json)" '.message' 'null' \
  'drained room-scoped pop → message: null'

pass "one queue across chat and email, typed items in arrival order, ack semantics per medium, room pop unchanged"
