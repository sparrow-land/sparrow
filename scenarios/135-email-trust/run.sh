#!/usr/bin/env bash
# 135-email-trust — the trust engine, one rung at a time. Every email crosses the
# org boundary exactly once, and this is the crossing: a deterministic ladder
# where an address is recognized because a human already said so, in one of four
# ways — org membership (the grant is the membership), a sibling agent's own
# derived address, an external contact a human marked `approved`, and an
# `email.trustedPatterns` glob the org set as policy. Each rung delivers with no
# approval and no quarantine.
#
# The rest of the scenario is what trust does NOT buy. A stranger under the
# default `reject` policy is refused outright: no work item, and nothing parked
# for a human to look at. A forgery — a From that WOULD match a rung, arriving
# with SPF/DKIM/DMARC all failing — is rejected as a `spoof` and is proven to
# stay rejected even while the org's policy says "let me review strangers": an
# org can choose to review strangers, never to review forgeries. A virus verdict
# outranks trust itself, so it is fired from the org's most trusted sender. And a
# spam verdict does not accuse anyone of being an impostor — it merely denies the
# fast path, dropping even a recognized sender onto the org's policy, which is
# shown twice: `quarantined` under `approve`, `rejected` under `reject`.
#
# Reason slugs are asserted VERBATIM throughout — `emails.reason` is the single
# reason vocabulary in the system, and a test that paraphrases it tests nothing.
set -euo pipefail
SCENARIO_NAME="135-email-trust"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

# --- verification blocks the edge would compute. `verified` authenticates the
# sender (dmarc pass); `forged` is the edge saying it could authenticate nobody.
verified() { jq -cn --arg d "$1" '{spf:"pass",dkim:"pass",dmarc:"pass",domain:$d}'; }
forged()   { jq -cn --arg d "$1" '{spf:"fail",dkim:"fail",dmarc:"fail",domain:$d}'; }

# --- one normalized inbound payload. jq --arg keeps the generated org slug from
# ever being pasted into a string.
mail() { # <rfcMessageId> <fromEmail> <toAddress> <subject> <verification>
  jq -cn --arg id "$1" --arg f "$2" --arg to "$3" --arg s "$4" --argjson v "$5" \
    '{rfcMessageId:$id, from:{email:$f,name:"Sender"}, to:[{email:$to}],
      subject:$s, text:"the body", verification:$v}'
}

SCENARIO_EXTRA_ENV=(EMAIL_PROVIDER=fake EMAIL_ORG_SUFFIX=.example.com EMAIL_INBOUND_TOKEN=scenario-inbound)
scenario_start

# --- push one payload through the exact /email/inbound pipeline, echo the 202.
inject() { admin_api POST /admin/email/inject "$1"; }

# --- how many emails are waiting on a human right now.
queued() { api "$owner" GET "/orgs/$org/email/approvals" | jq -r '.items | length'; }

# --- set the org's WHOLE email policy: PATCH /orgs/:id validates settings as a
# unit, so every write restates the trusted patterns rather than assuming a merge.
set_policy() { # <inboundUnrecognized> <trustedPatterns-json>
  api "$owner" PATCH "/orgs/$org" \
    "$(jq -cn --arg i "$1" --argjson p "$2" \
       '{settings:{email:{inboundUnrecognized:$i, trustedPatterns:$p}}}')" >/dev/null \
    || fail "PATCH /orgs/:id email policy failed ($1)"
}

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
slug="$(api "$owner" GET "/orgs/$org" | jq -r '.org.slug')"
[ -n "$slug" ] && [ "$slug" != null ] || fail "could not read the org slug"

f="$(create_agent "$owner" "$org" fable)"
fid="$(jq -r '.agent.id' <<<"$f")"
fkey="$(jq -r '.key' <<<"$f")"
addr="fable@${slug}.example.com"

# A sibling agent in the same org — rung 2 is its own derived address.
r="$(create_agent "$owner" "$org" robin)"
robin_addr="robin@${slug}.example.com"
assert_json "$r" '.agent.emailAddress' "$robin_addr" 'the sibling agent has its own derived address'

# The org starts on the DEFAULT policy: strangers are rejected outright.
assert_json "$(api "$owner" GET "/orgs/$org")" '.org.settings.email.inboundUnrecognized' 'reject' \
  'the default inbound policy is reject'
assert_json "$(api "$owner" GET "/orgs/$org")" '.org.settings.email.trustedPatterns | length' '0' \
  'the default trustedPatterns list is empty'

# ===========================================================================
# The ladder — four rungs, four ways a human has already said yes.
# ===========================================================================

# Rung 1 — an org human's ACCOUNT EMAIL. Membership is the grant; nobody had to
# approve anything for a colleague to be able to write to the org's agent.
res="$(inject "$(mail '<t1@mail.example.net>' owner@ex.com "$addr" 'rung 1: a colleague' "$(verified ex.com)")")"
assert_json "$res" '.status' 'delivered' 'rung 1: an org human’s account email delivers'
assert_json "$res" '.reason' 'null' 'rung 1: a clean delivery carries no reason'
eml1="$(jq -r '.email.id' <<<"$res")"
assert_eq 0 "$(queued)" 'rung 1: nothing was parked for a human'

# Rung 2 — ANOTHER ORG AGENT's own address. Siblings recognize each other. (Mail
# between agents is not short-circuited: it leaves through the relay and comes
# back through the seam, which under the fake provider means the scenario injects
# the inbound leg itself.)
res="$(inject "$(mail '<t2@mail.example.net>' "$robin_addr" "$addr" 'rung 2: a sibling agent' \
  "$(verified "${slug}.example.com")")")"
assert_json "$res" '.status' 'delivered' 'rung 2: a sibling agent’s own address delivers'
assert_json "$res" '.reason' 'null' 'rung 2: no reason on a recognized sender'
eml2="$(jq -r '.email.id' <<<"$res")"
assert_eq 0 "$(queued)" 'rung 2: nothing was parked for a human'

# Rung 3 — a previously APPROVED CONTACT. Casey is nobody at first, so her first
# note is refused under the default policy — but a refusal is still a persisted
# record, and the From address is remembered as an external contact. A human then
# marks that contact `approved` (the durable memory behind "you already said yes
# to this person") and her NEXT note walks straight in.
res="$(inject "$(mail '<t3a@mail.example.net>' casey@vendor.example.net "$addr" 'rung 3: hello' \
  "$(verified vendor.example.net)")")"
assert_json "$res" '.status' 'rejected' 'rung 3: an unknown contact is refused before approval'
assert_json "$res" '.reason' 'unrecognized-sender' 'rung 3: the pre-approval reason is unrecognized-sender'

contacts="$(api "$owner" GET "/orgs/$org/email/contacts?q=casey")"
assert_json "$contacts" '.items | length' '1' 'the refused sender is remembered as a contact'
assert_json "$contacts" '.items[0].email' 'casey@vendor.example.net' 'the contact is the From address'
assert_json "$contacts" '.items[0].trust' 'null' 'a merely-seen contact carries no trust'
cid="$(jq -r '.items[0].id' <<<"$contacts")"

patched="$(api "$owner" PATCH "/orgs/$org/email/contacts/$cid" '{"trust":"approved"}')"
assert_json "$patched" '.contact.trust' 'approved' 'a human marks the contact approved'
assert_json "$patched" '.contact.resolvedBy.id != null' 'true' 'the approval records who made it'

res="$(inject "$(mail '<t3b@mail.example.net>' casey@vendor.example.net "$addr" 'rung 3: again' \
  "$(verified vendor.example.net)")")"
assert_json "$res" '.status' 'delivered' 'rung 3: an approved contact delivers'
assert_json "$res" '.reason' 'null' 'rung 3: no reason on an approved contact'
eml3="$(jq -r '.email.id' <<<"$res")"
assert_eq 0 "$(queued)" 'rung 3: nothing was parked for a human'

# Rung 4 — an `email.trustedPatterns` GLOB. Org policy, not a per-person
# decision: a wildcard local part over a concrete domain is the canonical form.
set_policy reject '["*@partner.example.com"]'
assert_json "$(api "$owner" GET "/orgs/$org")" '.org.settings.email.trustedPatterns | join(",")' \
  '*@partner.example.com' 'the org trusts a whole partner domain'
res="$(inject "$(mail '<t4@mail.example.net>' dana@partner.example.com "$addr" 'rung 4: a partner' \
  "$(verified partner.example.com)")")"
assert_json "$res" '.status' 'delivered' 'rung 4: a trustedPatterns match delivers'
assert_json "$res" '.reason' 'null' 'rung 4: no reason on a pattern match'
eml4="$(jq -r '.email.id' <<<"$res")"
assert_eq 0 "$(queued)" 'rung 4: nothing was parked for a human'

# ===========================================================================
# What trust does not buy.
# ===========================================================================

# A STRANGER under the default `reject` policy: refused, not queued. An
# authenticated sender nobody has ever trusted is still a sender nobody has ever
# trusted, and `reject` means no human is asked to look.
res="$(inject "$(mail '<t5@mail.example.net>' nobody@stranger.example.org "$addr" 'cold outreach' \
  "$(verified stranger.example.org)")")"
assert_json "$res" '.status' 'rejected' 'an unknown sender under reject → rejected'
assert_json "$res" '.reason' 'unrecognized-sender' 'the stranger reason is unrecognized-sender'
assert_json "$res" '.deliveries[0].status' 'rejected' 'the per-anchor delivery agrees'
assert_json "$res" '.deliveries[0].reason' 'unrecognized-sender' 'the per-anchor reason agrees'
stranger_eml="$(jq -r '.email.id' <<<"$res")"
assert_eq 0 "$(queued)" 'a rejected stranger is NOT in the approvals queue'

# A SPOOF. From owner@ex.com — trust-set rung 1, the org's own owner — but the
# edge authenticated nobody. This is the branch that outranks policy, so it is
# tested with the policy flipped to `approve`: an org can choose to review
# strangers, never to review forgeries.
set_policy approve '["*@partner.example.com"]'
assert_json "$(api "$owner" GET "/orgs/$org")" '.org.settings.email.inboundUnrecognized' 'approve' \
  'the org now offers to review strangers'
res="$(inject "$(mail '<t6@mail.example.net>' owner@ex.com "$addr" 'urgent wire transfer' \
  "$(forged ex.com)")")"
assert_json "$res" '.status' 'rejected' 'a forged org human is rejected outright'
assert_json "$res" '.reason' 'spoof' 'the forgery reason is spoof'
assert_eq 0 "$(queued)" 'a spoof is NEVER quarantined, even under an approve policy'

# The same rule guards the pattern rung: forging a trusted DOMAIN is no better
# than forging a trusted person.
res="$(inject "$(mail '<t7@mail.example.net>' dana@partner.example.com "$addr" 'invoice attached' \
  "$(forged partner.example.com)")")"
assert_json "$res" '.status' 'rejected' 'a forged trustedPatterns match is rejected outright'
assert_json "$res" '.reason' 'spoof' 'forging a trusted pattern is also spoof'
assert_eq 0 "$(queued)" 'the second spoof is not quarantined either'

# Meanwhile a genuine stranger under this SAME `approve` policy is quarantined —
# proof that the spoof rejections above were the spoof branch and not the policy.
res="$(inject "$(mail '<t8@mail.example.net>' someone@elsewhere.example.org "$addr" 'a real stranger' \
  "$(verified elsewhere.example.org)")")"
assert_json "$res" '.status' 'quarantined' 'under approve, a genuine stranger is quarantined'
assert_json "$res" '.reason' 'unrecognized-sender' 'the quarantine reason is unrecognized-sender'
stranger_q="$(jq -r '.email.id' <<<"$res")"
assert_eq 1 "$(queued)" 'the quarantined stranger IS in the approvals queue'
# Reset the queue to empty so the spam assertions below can count it cleanly; a
# deny without blockSender refuses this one message and grants nobody anything.
denied="$(api "$owner" POST "/orgs/$org/email/emails/$stranger_q/deny" '{}')"
assert_json "$denied" '.email.disposition' 'rejected' 'a denied quarantine becomes rejected'
assert_json "$denied" '.email.reason' 'denied' 'the human-refusal reason is denied'
assert_eq 0 "$(queued)" 'the queue is empty again'

# A VIRUS verdict outranks trust itself — fired from the org's most trusted
# sender, fully authenticated, while the policy still says "review strangers".
res="$(inject "$(mail '<t9@mail.example.net>' owner@ex.com "$addr" 'payroll.xls' \
  "$(verified ex.com | jq -c '. + {virus:"fail"}')")")"
assert_json "$res" '.status' 'rejected' 'a virus verdict is rejected whatever the sender’s standing'
assert_json "$res" '.reason' 'virus' 'the virus reason is virus'
assert_eq 0 "$(queued)" 'infected mail is never parked for a human to open'

# SPAM is a different claim. It does not say "this is not who it says it is" —
# it denies the FAST PATH, so even a recognized sender falls to the org's policy.
# Under `approve`, that means a human gets to look.
res="$(inject "$(mail '<t10@mail.example.net>' owner@ex.com "$addr" 'hot deals' \
  "$(verified ex.com | jq -c '. + {spam:"fail"}')")")"
assert_json "$res" '.status' 'quarantined' 'spam on a TRUSTED sender falls to the policy path'
assert_json "$res" '.reason' 'spam' 'the diverted-by-spam reason is spam, not unrecognized-sender'
spam_q="$(jq -r '.email.id' <<<"$res")"
assert_eq 1 "$(queued)" 'the spam-diverted email is waiting on a human'
qitem="$(api "$owner" GET "/orgs/$org/email/approvals" | jq -c '.items[0]')"
assert_json "$qitem" '.email.id' "$spam_q" 'the queue holds the spam-diverted email'
assert_json "$qitem" '.email.reason' 'spam' 'the queue carries the reason slug verbatim'
assert_json "$qitem" '.agent.id' "$fid" 'the queue item names the anchor agent'
assert_json "$qitem" '.verification.spam' 'fail' 'the approver sees the edge’s spam verdict'

# The SAME message under the default `reject` policy: the same fall-through, the
# same reason slug, a different terminal state. `spam` names why it left the fast
# path; the policy names where it landed.
set_policy reject '["*@partner.example.com"]'
res="$(inject "$(mail '<t11@mail.example.net>' owner@ex.com "$addr" 'hot deals again' \
  "$(verified ex.com | jq -c '. + {spam:"fail"}')")")"
assert_json "$res" '.status' 'rejected' 'under reject, spam on a trusted sender is rejected'
assert_json "$res" '.reason' 'spam' 'the reason is still spam under either policy'

# ===========================================================================
# The queue and the work loop agree with every verdict above.
# ===========================================================================

# Exactly the four rungs became work. Nothing rejected and nothing quarantined
# ever reached the agent's loop, in arrival order and with nothing in between.
for expected in "$eml1" "$eml2" "$eml3" "$eml4"; do
  got="$(ac_tok "$fkey" pop --json)"
  assert_json "$got" '.item.type' 'email' 'each pop is an email work item'
  assert_json "$got" '.item.email.id' "$expected" 'the ladder delivered exactly this email, in arrival order'
  assert_json "$got" '.item.email.disposition' 'delivered' 'only delivered email is work'
done
assert_json "$(ac_tok "$fkey" pop --json)" '.item' 'null' \
  'rejected and quarantined email never became work items'

# The queue's final contents are the one email a human was actually asked about.
final="$(api "$owner" GET "/orgs/$org/email/approvals")"
assert_json "$final" '.items | length' '1' 'exactly one email is still waiting on a human'
assert_json "$final" '.items[0].email.id' "$spam_q" 'and it is the spam-diverted one'
assert_not_contains "$(jq -c '.items' <<<"$final")" "$stranger_eml" \
  'the rejected stranger never entered the queue'

pass "four trust rungs deliver; stranger rejected and unqueued; spoof rejected even under approve; virus outranks trust; spam falls to policy both ways"
