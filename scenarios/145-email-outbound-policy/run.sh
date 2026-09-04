#!/usr/bin/env bash
# 145-email-outbound-policy — the other direction of the same gate. An agent
# writing to someone the org has never trusted is not a failure and not a free
# pass: under `outboundUnrecognized: "approve"` the mail is HELD. The row exists,
# the agent is told plainly (exit 0 — a held mail is not an error to retry), the
# owner gets `email.held`, the item sits in `/orgs/:id/email/approvals` with
# `direction: "out"` — and the fake provider's outbox is empty, which is the
# whole point: nothing left the building. Approve it and the same row relays,
# `sent`, captured with the To, the subject, and the Message-ID core minted.
#
# Policy is only for strangers. A recipient the trust set already recognizes —
# here an org human's own account email — never touches the approve path; nor
# does a reply inside a thread a human has already trusted, even when the
# contact itself was deliberately left untrusted (`approve --no-trust`), which
# is what proves the THREAD is carrying that reply and not the contact.
#
# Finally the default the medium ships with: `reject`. The send fails loudly
# (403, a clear error, non-zero exit) and yet the refusal is persisted
# `rejected` / `unrecognized-recipient` for the audit trail — an agent can see
# what did not go out — while the outbox stays empty.
set -euo pipefail
SCENARIO_NAME="145-email-outbound-policy"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

SCENARIO_EXTRA_ENV=(EMAIL_PROVIDER=fake EMAIL_ORG_SUFFIX=.example.com EMAIL_INBOUND_TOKEN=scenario-inbound)
scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
slug="$(api "$owner" GET "/orgs/$org" | jq -r '.org.slug')"

f="$(create_agent "$owner" "$org" fable)"
fid="$(jq -r '.agent.id' <<<"$f")"
fkey="$(jq -r '.key' <<<"$f")"
addr="fable@${slug}.example.com"

# outbox — the fake provider's capture buffer. Cleared before each leg so
# "nothing left" is a real assertion and not a stale count.
outbox() { admin_api GET /admin/email/outbox; }
clear_outbox() { admin_api DELETE /admin/email/outbox >/dev/null; }

# The policy under test. Inbound stays at its default.
api "$owner" PATCH "/orgs/$org" \
  '{"settings":{"email":{"outboundUnrecognized":"approve"}}}' >/dev/null
assert_json "$(api "$owner" GET "/orgs/$org")" '.org.settings.email.outboundUnrecognized' \
  'approve' 'the org now reviews mail to strangers'
assert_json "$(api "$owner" GET "/orgs/$org")" '.org.settings.email.inboundUnrecognized' \
  'reject' 'the inbound default is untouched — the two policies are independent'

# The agent never approves its own mail: `sparrow approvals` refuses an agent
# profile locally, naming the rule rather than bouncing off the auth gate.
set +e
agent_appr="$(ac_tok "$fkey" approvals list --org "$org" 2>&1)"; agent_appr_rc=$?
set -e
assert_eq 1 "$agent_appr_rc" 'an agent running `sparrow approvals` exits non-zero'
assert_contains "$agent_appr" 'owning human' 'the refusal names whose command this is'
assert_contains "$agent_appr" 'never approves mail addressed to itself' \
  'and states the rule, not a status code'

# ===========================================================================
# A stranger. Held: nothing leaves, and a human is asked.
# ===========================================================================
clear_outbox
ev="$SPARROW_TMPROOT/owner-events.jsonl"
epid="$(sse_me_watch "$owner" "$ev")"
sleep 1

set +e
held_out="$(ac_tok "$fkey" email send --to dana@partner.example.com \
  --subject 'Q3 rollout' 'can we compare numbers?' --json)"; held_rc=$?
set -e
assert_eq 0 "$held_rc" 'a held send is not a failure — the CLI exits 0'
assert_json "$held_out" '.email.disposition' 'held' 'the send is held for a human'
assert_json "$held_out" '.email.reason' 'unrecognized-recipient' 'the reason slug is verbatim'
assert_json "$held_out" '.email.direction' 'out' 'the row is outbound mail'
assert_json "$held_out" '.email.to[0].email' 'dana@partner.example.com' 'addressed to the stranger'
held="$(jq -r '.email.id' <<<"$held_out")"
heldthr="$(jq -r '.thread.id' <<<"$held_out")"
assert_eq 202 "$(http_status "$fkey" POST /me/email/send \
  '{"to":["eve@elsewhere.example.net"],"subject":"hello","text":"hi"}')" \
  'the wire status for a held send is 202 — accepted, not relayed'

# NOTHING left the building.
assert_json "$(outbox)" '.items | length' '0' 'the fake provider captured nothing'

# The agent is told, in prose, that a person now has it.
plain="$(ac_tok "$fkey" email send --to zoe@partner.example.com --subject 'ping' 'hello there')"
assert_contains "$plain" 'was NOT relayed' 'the held send says plainly that nothing went out'
assert_contains "$plain" 'held for Owner to approve' 'and names the human who must decide'
assert_contains "$plain" 'not a failure: do not retry' 'and tells the agent not to retry it'
assert_json "$(outbox)" '.items | length' '0' 'still nothing captured'

# --- the owner is told, live ------------------------------------------------
wait_for_line "$ev" '"type":"email.held"' \
  || { kill "$epid" 2>/dev/null || true; fail "the owner got no email.held"; }
sleep 0.5
kill "$epid" 2>/dev/null || true
grep -F '"type":"email.held"' "$ev" | grep -qF "$held" \
  || fail "email.held does not name the held email"
grep -F '"type":"email.held"' "$ev" | grep -qF '"reason":"unrecognized-recipient"' \
  || fail "email.held does not carry the verbatim reason slug"
grep -F '"type":"email.held"' "$ev" | grep -qF "$fid" \
  || fail "email.held does not name the sending agent"

# --- and it is in the queue, on the outbound side ---------------------------
q="$(api "$owner" GET "/orgs/$org/email/approvals?direction=out")"
assert_json "$q" "[.items[] | select(.email.id == \"$held\")] | length" '1' \
  'the held email is in the outbound approvals queue'
assert_json "$q" "[.items[] | select(.email.id == \"$held\")][0].email.direction" 'out' \
  'the queue item is outbound'
assert_json "$q" "[.items[] | select(.email.id == \"$held\")][0].email.disposition" 'held' \
  'and still pending'
assert_json "$q" "[.items[] | select(.email.id == \"$held\")][0].agent.name" 'fable' \
  'anchored on the sending agent'
assert_json "$(api "$owner" GET "/orgs/$org/email/approvals?direction=in")" '.items | length' '0' \
  'the inbound half of the queue is empty — direction really filters'

# The two probe sends above parked rows of their own. Resolve them now, so every
# later "the queue is empty" assertion means exactly that and nothing subtler.
for extra in $(jq -r ".items[] | select(.email.id != \"$held\") | .email.id" <<<"$q"); do
  api "$owner" POST "/orgs/$org/email/emails/$extra/deny" '{}' >/dev/null
done
assert_json "$(api "$owner" GET "/orgs/$org/email/approvals")" '.items | length' '1' \
  'only the email under test is still pending'

# ===========================================================================
# Approve → the provider finally sees it.
# ===========================================================================
appr="$(ac_tok "$owner" approvals approve "$held" --org "$org" --json)"
assert_json "$appr" '.disposition' 'sent' 'approving a held email relays it'
assert_json "$appr" '.id' "$held" 'the same row, resolved in place'
box="$(outbox)"
assert_json "$box" "[.items[] | select(.email.id == \"$held\")] | length" '1' \
  'the fake provider captured exactly that email'
cap='[.items[] | select(.email.id == "'"$held"'")][0]'
assert_json "$box" "$cap.to | length" '1' 'captured with exactly one recipient'
assert_json "$box" "$cap.to[0]" 'dana@partner.example.com' 'and it is the stranger it was addressed to'
assert_json "$box" "$cap.raw.subject" 'Q3 rollout' 'and its subject'
assert_json "$box" "$cap.headers.messageId" "<${held}@${slug}.example.com>" \
  'and the Message-ID core minted before the relay call'
assert_json "$appr" '.rfcMessageId' "<${held}@${slug}.example.com>" \
  'which is the same identity stored on the row'

# ===========================================================================
# A RECOGNIZED recipient is never held — an org human's own account email.
# ===========================================================================
clear_outbox
known="$(ac_tok "$fkey" email send --to owner@ex.com --subject 'status' 'build is green' --json)"
assert_json "$known" '.email.disposition' 'sent' 'a recognized recipient goes straight out'
assert_json "$known" '.email.reason' 'null' 'a clean send carries no reason'
assert_eq 201 "$(http_status "$fkey" POST /me/email/send \
  '{"to":["owner@ex.com"],"subject":"again","text":"still green"}')" \
  'a recognized send is a plain 201 create'
assert_json "$(api "$owner" GET "/orgs/$org/email/approvals")" '.items | length' '0' \
  'nothing was queued for a recognized recipient'
assert_json "$(outbox)" '.items | length' '2' 'both recognized sends were relayed'

# ===========================================================================
# A reply inside an already-trusted thread never re-triggers policy.
# The sender is approved with --no-trust, so the CONTACT stays untrusted and
# only the thread's own trust can be carrying the reply.
# ===========================================================================
api "$owner" PATCH "/orgs/$org" \
  '{"settings":{"email":{"inboundUnrecognized":"approve","outboundUnrecognized":"approve"}}}' >/dev/null
inb="$(admin_api POST /admin/email/inject "$(jq -cn --arg to "$addr" \
  '{rfcMessageId:"<t1@mail.example.net>", from:{email:"pat@stranger.example.net",name:"Pat"},
    to:[{email:$to}], subject:"about the rollout", text:"a question for you",
    verification:{spf:"pass",dkim:"pass",dmarc:"pass",domain:"stranger.example.net"}}')")"
assert_json "$inb" '.status' 'quarantined' 'the inbound stranger parks, as 140 shows'
inbeml="$(jq -r '.email.id' <<<"$inb")"
inbthr="$(jq -r '.email.threadId' <<<"$inb")"
ac_tok "$owner" approvals approve "$inbeml" --no-trust --org "$org" --json >/dev/null
assert_json "$(ac_tok "$fkey" email threads --json)" \
  "[.items[] | select(.id == \"$inbthr\")][0].trusted" 'true' 'the thread is trusted'
assert_json "$(api "$owner" GET "/orgs/$org/email/contacts?trust=approved")" \
  '[.items[] | select(.email == "pat@stranger.example.net")] | length' '0' \
  '--no-trust left the CONTACT untrusted: only the thread carries trust'

clear_outbox
rep="$(ac_tok "$fkey" email reply 'here are the numbers' --to "$inbeml" --json)"
assert_json "$rep" '.disposition' 'sent' 'a reply in a trusted thread is never held'
assert_json "$rep" '.reason' 'null' 'the approve policy never ran for it'
assert_json "$rep" '.to[0].email' 'pat@stranger.example.net' 'and it went back to the sender'
assert_json "$(outbox)" '.items | length' '1' 'the reply really left'
assert_json "$(outbox)" '.items[0].raw.subject' 'Re: about the rollout' \
  'a reply carries the thread subject with one Re: prefix'
assert_json "$(outbox)" '.items[0].headers.inReplyTo' '<t1@mail.example.net>' \
  'threaded onto the message it answers'
assert_json "$(api "$owner" GET "/orgs/$org/email/approvals")" '.items | length' '0' \
  'and no human was asked'

# ===========================================================================
# Back to the DEFAULT: reject. Loud failure, empty outbox, audit trail kept.
# ===========================================================================
api "$owner" PATCH "/orgs/$org" \
  '{"settings":{"email":{"outboundUnrecognized":"reject"}}}' >/dev/null
clear_outbox

set +e
rej_out="$(ac_tok "$fkey" email send --to nobody@unknown.example.org \
  --subject 'cold open' 'hello?' --json 2>&1)"; rej_rc=$?
set -e
assert_eq 1 "$rej_rc" 'under the reject policy the send FAILS — non-zero exit'
assert_contains "$rej_out" 'forbidden' 'and says what refused it'
assert_contains "$rej_out" 'refused by your org' 'in words an agent can act on'
assert_json "$(outbox)" '.items | length' '0' 'nothing was relayed'

# The wire shape of that refusal, and the audit trail it leaves behind.
err="$(api_raw "$fkey" POST /me/email/send \
  '{"to":["nobody@unknown.example.org"],"subject":"cold open 2","text":"hello?"}')"
assert_json "$err" '.error.code' 'forbidden' 'the refusal is a plain forbidden envelope'
assert_eq 403 "$(http_status "$fkey" POST /me/email/send \
  '{"to":["nobody@unknown.example.org"],"subject":"cold open 3","text":"hello?"}')" \
  'a rejected send is 403'
assert_json "$(outbox)" '.items | length' '0' 'still nothing relayed'

# A rejection is not an approval request — nobody is asked about it.
assert_json "$(api "$owner" GET "/orgs/$org/email/approvals")" '.items | length' '0' \
  'a rejection never enters the queue'

# …but it IS kept. The refusal appended an `email.rejected` timeline entry whose
# ref leads straight to the persisted row: disposition `rejected`, the same
# slug, body intact (outbound keeps its body in every disposition, so an agent
# can see what did not go out).
tl="$(ac_tok "$owner" activity --medium email --json)"
assert_json "$tl" '([.items[] | select(.type == "email.rejected")] | length) >= 3' 'true' \
  'each refused send left a timeline entry'
# The timeline descends: row zero is the newest refusal ('cold open 3').
rejid="$(jq -r '[.items[] | select(.type == "email.rejected")][0].refs.emailId' <<<"$tl")"
row="$(api "$owner" GET "/orgs/$org/email/emails/$rejid")"
assert_json "$row" '.email.subject' 'cold open 3' 'the newest entry refs the last refused send'
assert_json "$row" '.email.direction' 'out' 'the audited row is the outbound attempt'
assert_json "$row" '.email.disposition' 'rejected' 'persisted as rejected'
assert_json "$row" '.email.reason' 'unrecognized-recipient' 'with the outbound slug, verbatim'
assert_json "$row" '.email.to[0].email' 'nobody@unknown.example.org' 'naming who it was for'
assert_json "$row" '.email.text' 'hello?' 'and keeping the body the agent wrote'

pass "held sends leave nothing behind until a human approves; recognized recipients and trusted threads bypass policy; reject fails loudly but audits"
