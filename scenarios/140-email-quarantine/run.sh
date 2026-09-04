#!/usr/bin/env bash
# 140-email-quarantine — what `inboundUnrecognized: "approve"` buys an org: a
# stranger's mail is neither delivered nor thrown away, it is PARKED. The
# unknown sender lands `quarantined` with `reason: "unrecognized-sender"`, the
# agent's loop never sees it (no pop, no thread), and the row itself IS the
# queue — it shows up in `/orgs/:id/email/approvals` for whoever can act on it:
# the owning human AND the org's owners/admins, both of whom get a live
# `email.quarantined` on their own `/me/events`.
#
# Then the two verbs, and what each one REMEMBERS. Approve (default
# `trustSender`) delivers the parked mail — it becomes a real work item, its
# thread is `trusted`, and the sender's contact is durably `approved`, so that
# person's NEXT email walks straight in with nobody woken up. Deny `--block`
# refuses this one (`reason: "denied"`) and blocks the contact, so a later
# email from them is `rejected` with `reason: "blocked"` at the block rung —
# never queued, never anybody's decision to make twice.
#
# EMAIL_PROVIDER=fake: inbound arrives through the admin inject route, which
# runs the real `/email/inbound` pipeline and lets the scenario choose the
# verification verdicts. Both senders here authenticate cleanly — the only thing
# wrong with them is that nobody has ever said yes to them.
set -euo pipefail
SCENARIO_NAME="140-email-quarantine"
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
assert_json "$(ac_tok "$fkey" email address --json)" '.address' "$addr" \
  'the agent mailbox is <name>@<slug><EMAIL_ORG_SUFFIX>'

# A SECOND approver who is not the owner: an org admin. The approval events fan
# out to owners/admins as well as the owning human, so the org-wide queue is
# live for everyone who may act on it.
ada="$(add_human_to_org "$owner" "$org" ada@ex.com password123 Ada)"
adaid="$(ac_tok "$ada" whoami --json | jq -r '.id')"
api "$owner" PATCH "/orgs/$org/humans/$adaid" '{"role":"admin"}' >/dev/null

# The policy under test. Everything else (outbound, patterns) stays at defaults.
api "$owner" PATCH "/orgs/$org" \
  '{"settings":{"email":{"inboundUnrecognized":"approve"}}}' >/dev/null
assert_json "$(api "$owner" GET "/orgs/$org")" '.org.settings.email.inboundUnrecognized' \
  'approve' 'the org now reviews unrecognized senders instead of refusing them'

# inject <rfcMessageId> <fromEmail> <fromName> <subject> — one authenticated
# inbound message at the agent, through the real pipeline.
inject() {
  admin_api POST /admin/email/inject "$(jq -cn \
    --arg mid "$1" --arg fe "$2" --arg fn "$3" --arg to "$addr" --arg s "$4" \
    '{rfcMessageId:$mid, from:{email:$fe,name:$fn}, to:[{email:$to}],
      subject:$s, text:"can we talk about the rollout?",
      verification:{spf:"pass",dkim:"pass",dmarc:"pass",domain:($fe|split("@")[1])}}')"
}

# ===========================================================================
# A stranger writes. Both approvers are watching /me/events when it lands.
# ===========================================================================
oev="$SPARROW_TMPROOT/owner-events.jsonl"
aev="$SPARROW_TMPROOT/ada-events.jsonl"
opid="$(sse_me_watch "$owner" "$oev")"
apid="$(sse_me_watch "$ada" "$aev")"
kill_watchers() { kill "$opid" "$apid" 2>/dev/null || true; }
sleep 1

r1="$(inject '<q1@mail.example.net>' dana@partner.example.com 'Dana Lee' 'Q3 rollout')"
assert_json "$r1" '.status' 'quarantined' 'an unknown sender is parked, not delivered'
assert_json "$r1" '.reason' 'unrecognized-sender' 'the reason slug is verbatim'
assert_json "$r1" '.deliveries | length' '1' 'one anchor agent, one delivery row'
assert_json "$r1" '.deliveries[0].agentId' "$fid" 'the anchor is the addressed agent'
assert_json "$r1" '.deliveries[0].status' 'quarantined' 'the per-anchor status agrees'
assert_json "$r1" '.deliveries[0].reason' 'unrecognized-sender' 'the per-anchor reason agrees'
eml1="$(jq -r '.email.id' <<<"$r1")"
thr1="$(jq -r '.email.threadId' <<<"$r1")"

# The agent's loop never sees it: quarantined mail is the human's queue, not the
# agent's work, and the thread stays invisible (last_email_at is bumped only by
# a delivered/sent email).
assert_json "$(ac_tok "$fkey" pop --json)" '.item' 'null' 'quarantined mail is not a work item'
assert_json "$(ac_tok "$fkey" email threads --json)" '.items | length' '0' \
  'a thread whose only email is quarantined is not in the listing'

# --- both approvers are told, live -----------------------------------------
wait_for_line "$oev" '"type":"email.quarantined"' \
  || { kill_watchers; fail "the owner got no email.quarantined"; }
wait_for_line "$aev" '"type":"email.quarantined"' \
  || { kill_watchers; fail "the org admin got no email.quarantined"; }
sleep 0.5
kill_watchers
grep -F '"type":"email.quarantined"' "$oev" | grep -qF "$eml1" \
  || fail "the owner's email.quarantined does not name the parked email"
grep -F '"type":"email.quarantined"' "$aev" | grep -qF "$eml1" \
  || fail "the admin's email.quarantined does not name the parked email"
grep -F '"type":"email.quarantined"' "$oev" | grep -qF '"reason":"unrecognized-sender"' \
  || fail "the event carries no verbatim reason slug"
grep -F '"type":"email.quarantined"' "$oev" | grep -qF "$fid" \
  || fail "email.quarantined does not name the anchor agent"

# --- the row IS the queue ---------------------------------------------------
q="$(api "$owner" GET "/orgs/$org/email/approvals")"
assert_json "$q" '.items | length' '1' 'the parked email is the whole queue'
assert_json "$q" '.items[0].email.id' "$eml1" 'the queue item is that email'
assert_json "$q" '.items[0].email.direction' 'in' 'it is inbound mail'
assert_json "$q" '.items[0].email.disposition' 'quarantined' 'and still pending'
assert_json "$q" '.items[0].email.reason' 'unrecognized-sender' 'carrying the same slug'
assert_json "$q" '.items[0].email.from.email' 'dana@partner.example.com' 'the item names the sender'
assert_json "$q" '.items[0].thread.id' "$thr1" 'the item carries its thread ref'
assert_json "$q" '.items[0].agent.id' "$fid" 'and the anchor agent'
assert_json "$q" '.items[0].agent.name' 'fable' 'by name, for the approval card'
assert_json "$q" '.items[0].verification.dmarc' 'pass' 'the approver sees the evidence'
assert_json "$q" '.items[0].judge' 'null' 'no judge ran under an approve policy'
# The admin reads the same queue, and the CLI shows the human the same one item.
assert_json "$(api "$ada" GET "/orgs/$org/email/approvals")" '.items[0].email.id' "$eml1" \
  'the org admin sees the same pending row'
assert_json "$(ac_tok "$owner" approvals list --org "$org" --json)" '.email | length' '1' \
  '`sparrow approvals` shows the owning human the pending mail'

# ===========================================================================
# Approve — and remember. The default trustSender is the durable half.
# ===========================================================================
appr="$(ac_tok "$owner" approvals approve "$eml1" --org "$org" --json)"
assert_json "$appr" '.disposition' 'delivered' 'approving delivers the parked mail'
assert_json "$appr" '.id' "$eml1" 'the same email, resolved in place'
assert_json "$appr" '.resolvedAt != null' 'true' 'resolution is recorded on the row'

# It is now real work: it pops, as an email work item on the one unified queue.
p="$(ac_tok "$fkey" pop --json)"
assert_json "$p" '.item.type' 'email' 'the approved email became a work item'
assert_json "$p" '.item.email.id' "$eml1" 'the very email that was quarantined'
assert_json "$p" '.item.email.disposition' 'delivered' 'popped as delivered'
assert_json "$p" '.item.email.text' 'can we talk about the rollout?' \
  'the body was kept through quarantine — an approver saw what they approved'
assert_json "$p" '.item.thread.id' "$thr1" 'the item carries its thread ref'

# The thread is durably trusted, and the contact durably approved.
th="$(ac_tok "$fkey" email threads --json)"
assert_json "$th" '.items | length' '1' 'the thread is visible now that an email delivered'
assert_json "$th" '.items[0].id' "$thr1" 'the same thread'
assert_json "$th" '.items[0].trusted' 'true' 'approval trusted the conversation'
contacts="$(api "$owner" GET "/orgs/$org/email/contacts")"
assert_json "$contacts" \
  '[.items[] | select(.email == "dana@partner.example.com")] | length' '1' \
  'the sender is on the org contact list'
assert_json "$contacts" \
  '[.items[] | select(.email == "dana@partner.example.com")][0].trust' 'approved' \
  'and durably approved'
assert_json "$contacts" \
  '[.items[] | select(.email == "dana@partner.example.com")][0].resolvedBy.displayName' \
  'Owner' 'with the human who said yes recorded on the contact'

# …so the SAME sender's next email needs nobody: straight through, no queue.
r2="$(inject '<q2@mail.example.net>' dana@partner.example.com 'Dana Lee' 'Re: Q3 rollout')"
assert_json "$r2" '.status' 'delivered' "the approved sender's next email delivers outright"
assert_json "$r2" '.reason' 'null' 'a clean delivery carries no reason'
assert_json "$(api "$owner" GET "/orgs/$org/email/approvals")" '.items | length' '0' \
  'nothing was queued for it'
assert_json "$(ac_tok "$fkey" pop --json)" '.item.email.id' "$(jq -r '.email.id' <<<"$r2")" \
  'and it is immediately the agent’s work'

# ===========================================================================
# Deny with --block — a DIFFERENT stranger, so the two halves cannot interfere.
# ===========================================================================
r3="$(inject '<d1@mail.example.net>' rex@spam.example.org 'Rex Loud' 'amazing offer')"
assert_json "$r3" '.status' 'quarantined' 'the second stranger is parked too'
assert_json "$r3" '.reason' 'unrecognized-sender' 'same slug, same rung'
eml3="$(jq -r '.email.id' <<<"$r3")"

deny="$(ac_tok "$owner" approvals deny "$eml3" --block --org "$org" --json)"
assert_json "$deny" '.disposition' 'rejected' 'a denied email is rejected'
assert_json "$deny" '.reason' 'denied' 'with the human-decision slug, verbatim'
assert_json "$deny" '.text' '' 'a rejected inbound email keeps metadata, never the body'
assert_json "$(api "$owner" GET "/orgs/$org/email/approvals")" '.items | length' '0' \
  'the queue is empty again — the decision was made once'
assert_json "$(ac_tok "$fkey" pop --json)" '.item' 'null' 'a denied email is never work'
assert_json "$(api "$owner" GET "/orgs/$org/email/contacts?trust=blocked")" \
  '.items[0].email' 'rex@spam.example.org' '--block wrote the durable block'

# A later email from that contact dies at the block rung — no policy, no queue.
r4="$(inject '<d2@mail.example.net>' rex@spam.example.org 'Rex Loud' 'even better offer')"
assert_json "$r4" '.status' 'rejected' 'a blocked contact is rejected, not reviewed'
assert_json "$r4" '.reason' 'blocked' 'the block rung outranks the approve policy'
assert_json "$r4" '.deliveries[0].reason' 'blocked' 'per-anchor, the same slug'
assert_json "$(api "$owner" GET "/orgs/$org/email/approvals")" '.items | length' '0' \
  'it never entered the queue'
assert_json "$(ac_tok "$owner" approvals list --org "$org" --json)" '.email | length' '0' \
  'and nothing is waiting on the human'

pass "unrecognized senders park for a human; approve delivers + trusts durably; deny --block refuses forever"
