#!/usr/bin/env bash
# 130-email-loopback — the email medium, round trip, on the EMAIL_PROVIDER=fake
# stack. An agent has a real mailbox whose address is DERIVED, never stored
# (<name>@<slug><EMAIL_ORG_SUFFIX>), and /capabilities — not a 404 — is where a
# client learns the medium is on. Mail from an org human is recognized by
# membership alone, so it lands with no approval, becomes an ordinary work item
# on the ONE unified queue (`{type:'email'}` beside chat's `{type:'chat.message'}`),
# and the human-readable drain leads with the medium it came from. The agent
# answers in-thread and the fake provider captures exactly what would have gone
# on the wire: the derived recipient set, one `Re: ` prefix and never two, an
# In-Reply-To pointing at the message being answered, and a Message-ID minted by
# core as <{emailId}@{org mail domain}> — the identity that makes the reply
# coming back resolve in a single lookup, which the scenario then proves by
# injecting that reply and watching it land in the SAME thread. Mailboxes belong
# to agents: a human session on /me/email/* is 403, not 404.
#
# A second, keyless stack (no email env at all) is the other half of the
# contract: the medium is entirely dormant — capabilities.email false, every
# route 404, and an agent that advertises no address at all.
set -euo pipefail
SCENARIO_NAME="130-email-loopback"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

# --- the clean, fully authenticated verification block the edge would compute.
verified() { # <domain>
  jq -cn --arg d "$1" '{spf:"pass",dkim:"pass",dmarc:"pass",domain:$d}'
}

# --- build one normalized inbound payload (the shape POST /email/inbound takes).
# jq --arg keeps the generated org slug from ever being pasted into a string.
mail() { # <rfcMessageId> <fromEmail> <toAddress> <subject> <text> <verification> [inReplyTo]
  jq -cn --arg id "$1" --arg f "$2" --arg to "$3" --arg s "$4" --arg t "$5" \
    --argjson v "$6" --arg irt "${7:-}" \
    '{rfcMessageId:$id, from:{email:$f,name:"Dana Lee"}, to:[{email:$to}],
      subject:$s, text:$t, verification:$v}
     + (if $irt == "" then {} else {inReplyTo:$irt, references:[$irt]} end)'
}

# ===========================================================================
# Stack 1 — EMAIL_PROVIDER=fake: the medium is on and loops back in-process.
# ===========================================================================
SCENARIO_EXTRA_ENV=(EMAIL_PROVIDER=fake EMAIL_ORG_SUFFIX=.example.com EMAIL_INBOUND_TOKEN=scenario-inbound)
scenario_start

# 1) /capabilities is the authority on whether a medium exists.
caps="$(curl -fsS "$SERVER/api/v1/capabilities")" || fail "GET /capabilities failed"
assert_json "$caps" '.email' 'true' 'fake email stack: capabilities.email true'

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
slug="$(api "$owner" GET "/orgs/$org" | jq -r '.org.slug')"
[ -n "$slug" ] && [ "$slug" != null ] || fail "could not read the org slug"

f="$(create_agent "$owner" "$org" fable)"
fid="$(jq -r '.agent.id' <<<"$f")"
fkey="$(jq -r '.key' <<<"$f")"
addr="fable@${slug}.example.com"

# 2) The address is DERIVED — <agent-name>@<org-slug><EMAIL_ORG_SUFFIX> — and is
# advertised on the agent record as well as on its own /me/email/address route.
assert_json "$f" '.agent.emailAddress' "$addr" 'a minted agent advertises its derived address'
mine="$(ac_tok "$fkey" email address --json)"
assert_json "$mine" '.address' "$addr" 'GET /me/email/address is <name>@<slug><suffix>'
assert_json "$mine" '.domain' "${slug}.example.com" 'the mail domain is the slug plus the suffix'
assert_json "$mine" '.orgId' "$org" 'the address route names the org'
assert_json "$mine" '.agentId' "$fid" 'the address route names the agent'
assert_contains "$(ac_tok "$fkey" email address)" "$addr" 'the human-readable address prints it'

# The owner reaches the same mailbox through the org twin.
theirs="$(api "$owner" GET "/orgs/$org/agents/$fid/email/address")"
assert_json "$theirs" '.address' "$addr" 'the owner reads the same address via the org route'

# 3) Mailboxes belong to AGENTS. A human session on /me/email/* is 403 — the
# route exists, the caller is simply the wrong kind of principal ("email
# addresses belong to agents"), so this must not degrade into a 404.
assert_eq 403 "$(http_status "$owner" GET /me/email/address)" 'human session on /me/email/address → 403'
assert_eq 403 "$(http_status "$owner" GET /me/email/threads)" 'human session on /me/email/threads → 403'

# 4) An inbound from an ORG HUMAN's account email. Membership IS the grant
# (trust-set entry 1), so it delivers with no approval and no quarantine.
msgA='<a1@mail.example.net>'
resA="$(admin_api POST /admin/email/inject \
  "$(mail "$msgA" owner@ex.com "$addr" 'Q3 rollout' 'ship it on the 14th' "$(verified ex.com)")")"
assert_json "$resA" '.status' 'delivered' 'an org human is recognized: delivered'
assert_json "$resA" '.reason' 'null' 'a clean delivery carries no reason'
assert_json "$resA" '.deliveries | length' '1' 'one anchor agent, one delivery'
assert_json "$resA" '.deliveries[0].agentId' "$fid" 'the delivery is anchored to fable'
emlA="$(jq -r '.email.id' <<<"$resA")"
ethA="$(jq -r '.email.threadId' <<<"$resA")"
assert_contains "$emlA" 'eml_' 'the inbound response carries the email id'
assert_contains "$ethA" 'eth_' 'the inbound response carries the thread id'

# Nothing was parked for a human: recognized mail never touches the queue.
assert_json "$(api "$owner" GET "/orgs/$org/email/approvals")" '.items | length' '0' \
  'recognized inbound is not in the approvals queue'

# 5) A thread exists, and it is the agent's own.
threads="$(ac_tok "$fkey" email threads --json)"
assert_json "$threads" '.items | length' '1' 'the delivery created exactly one thread'
assert_json "$threads" '.items[0].id' "$ethA" 'the thread is the one the inbound named'
assert_json "$threads" '.items[0].subject' 'Q3 rollout' 'the thread keeps the first subject'
assert_json "$threads" '.items[0].agentId' "$fid" 'the thread is anchored to fable'

# 6) It pops off the ONE unified queue as a typed email work item.
p1="$(ac_tok "$fkey" pop --json)"
assert_json "$p1" '.item.type' 'email' 'the popped work item is an email'
assert_json "$p1" '.item.email.id' "$emlA" 'pop returns the delivered email'
assert_json "$p1" '.item.email.direction' 'in' 'the popped email is inbound'
assert_json "$p1" '.item.email.from.email' 'owner@ex.com' 'pop names the sender'
# The From resolved to a PRINCIPAL, not a stranger: this address is a member's.
assert_json "$p1" '.item.email.from.principalId != null' 'true' 'the sender resolved to an org principal'
assert_json "$p1" '.item.email.from.contactId' 'null' 'a member is never an external contact'
assert_json "$p1" '.item.email.text' 'ship it on the 14th' 'the work item carries the body'
assert_json "$p1" '.item.thread.id' "$ethA" 'the email item carries its medium ref: the thread'
# The email variant carries email+thread and nothing from the chat medium.
assert_json "$p1" '.item | has("message")' 'false' 'an email item carries no chat message ref'
assert_json "$p1" '.item | has("room")' 'false' 'an email item carries no room ref'
# Popping is the read: a drained mailbox pops nothing.
assert_json "$(ac_tok "$fkey" pop --json)" '.item' 'null' 'the popped email was the only work'

# 7) The agent answers in the thread. owner@ex.com is an org human, so the
# recipient is recognized and the mail is relayed (captured) immediately.
admin_api DELETE /admin/email/outbox >/dev/null
r1="$(ac_tok "$fkey" email reply 'on it — the 14th works.' --to "$emlA" --json)"
assert_json "$r1" '.disposition' 'sent' 'a reply to a recognized recipient is sent, not held'
assert_json "$r1" '.direction' 'out' 'the reply is outbound'
assert_json "$r1" '.threadId' "$ethA" 'the reply lands in the inbound message’s thread'
rid1="$(jq -r '.id' <<<"$r1")"

# 8) What the fake provider captured is what would have gone on the wire.
box="$(admin_api GET /admin/email/outbox)"
assert_json "$box" '.items | length' '1' 'the reply was captured exactly once'
cap="$(jq -c '.items[0]' <<<"$box")"
# Recipients are DERIVED from the thread's most recent inbound email, minus the
# agent's own address — the agent wrote only a body.
assert_json "$cap" '.to | join(",")' 'owner@ex.com' 'the capture is addressed to the inbound sender'
assert_json "$cap" '.to | length' '1' 'the agent’s own address is dropped from its reply'
assert_json "$cap" '.raw.subject' 'Re: Q3 rollout' 'the reply subject is Re: <thread subject>'
assert_json "$cap" '.raw.text' 'on it — the 14th works.' 'the capture carries the body'
assert_json "$cap" '.headers.inReplyTo' "$msgA" 'In-Reply-To is the message being answered'
assert_json "$cap" '.headers.messageId' "<${rid1}@${slug}.example.com>" \
  'Message-ID is <{emailId}@{agent address domain}>'
assert_json "$cap" '.email.id' "$rid1" 'the capture carries the persisted email row'

# 9) `Re: ` at most ONCE. A second reply in the same thread — whose subject is
# already prefixed — must not compound into "Re: Re: ".
admin_api DELETE /admin/email/outbox >/dev/null
r2="$(ac_tok "$fkey" email reply 'confirming again.' --to "$emlA" --json)"
rid2="$(jq -r '.id' <<<"$r2")"
cap2="$(admin_api GET /admin/email/outbox | jq -c '.items[0]')"
assert_json "$cap2" '.raw.subject' 'Re: Q3 rollout' 'a reply to a Re: thread keeps ONE Re: prefix'
assert_not_contains "$(jq -r '.raw.subject' <<<"$cap2")" 'Re: Re:' 'the Re: prefix never compounds'
# In-Reply-To tracks the thread's most recent email in ANY direction — here the
# agent's own first reply.
assert_json "$cap2" '.headers.inReplyTo' "<${rid1}@${slug}.example.com>" \
  'In-Reply-To is the thread’s most recent email, whatever its direction'
assert_json "$cap2" '.headers.messageId' "<${rid2}@${slug}.example.com>" 'the second reply mints its own Message-ID'

# 10) The loop closes: the correspondent answers the agent's Message-ID and the
# reply resolves into the SAME thread in one lookup — the reason core, not the
# gateway, owns threading identity.
resB="$(admin_api POST /admin/email/inject \
  "$(mail '<b2@mail.example.net>' owner@ex.com "$addr" 'Re: Q3 rollout' 'great, thanks.' \
      "$(verified ex.com)" "<${rid2}@${slug}.example.com>")")"
assert_json "$resB" '.status' 'delivered' 'the answer to the agent’s reply delivers'
assert_json "$resB" '.email.threadId' "$ethA" 'In-Reply-To resolved it into the original thread'
assert_json "$(ac_tok "$fkey" email threads --json)" '.items | length' '1' \
  'the round trip stayed in one thread'

# 11) The human-readable drain LEADS with the medium the work came from.
human="$(ac_tok "$fkey" pop)"
assert_contains "$human" "[email: ${ethA}" 'the popped email leads with [email: <thread>]'
assert_contains "$human" 'Q3 rollout' 'the popped email names its subject'
assert_contains "$human" 'owner@ex.com' 'the popped email names its sender'
assert_contains "$human" 'great, thanks.' 'the popped email prints the body'

# ===========================================================================
# Stack 2 — keyless (no email env at all): the medium is entirely dormant.
# ===========================================================================
docker rm -fv "$SPARROW_CID" >/dev/null 2>&1 || true
SPARROW_CID=""
SCENARIO_EXTRA_ENV=()
scenario_start

caps2="$(curl -fsS "$SERVER/api/v1/capabilities")" || fail "keyless GET /capabilities failed"
assert_json "$caps2" '.email' 'false' 'keyless stack: capabilities.email false'

owner2="$(signup owner@ex.com password123 Owner)"
org2="$(first_org_id "$owner2")"
f2="$(create_agent "$owner2" "$org2" fable)"
fid2="$(jq -r '.agent.id' <<<"$f2")"
fkey2="$(jq -r '.key' <<<"$f2")"

# No provider, no address: nothing is advertised anywhere an agent is described.
assert_json "$f2" '.agent.emailAddress' 'null' 'keyless stack: a minted agent advertises no address'
assert_json "$(api "$owner2" GET "/orgs/$org2/agents")" \
  "[.items[] | select(.id == \"$fid2\")][0].emailAddress" 'null' \
  'keyless stack: the org agent list advertises no address'

# Every route in the medium 404s — for the agent, for its owner, and for the edge.
assert_eq 404 "$(http_status "$fkey2" GET /me/email/address)" 'keyless /me/email/address → 404'
assert_eq 404 "$(http_status "$fkey2" GET /me/email/threads)" 'keyless /me/email/threads → 404'
assert_eq 404 "$(http_status "$fkey2" POST /me/email/send '{"to":["x@y.com"],"subject":"s","text":"t"}')" \
  'keyless /me/email/send → 404'
assert_eq 404 "$(http_status "$owner2" GET "/orgs/$org2/agents/$fid2/email/address")" \
  'keyless org agent address route → 404'
assert_eq 404 "$(http_status "$owner2" GET "/orgs/$org2/agents/$fid2/email/threads")" \
  'keyless org agent threads route → 404'
assert_eq 404 "$(http_status "$owner2" GET "/orgs/$org2/email/approvals")" 'keyless approvals queue → 404'
assert_eq 404 "$(http_status "$owner2" GET "/orgs/$org2/email/contacts")" 'keyless contacts list → 404'
# The inbound seam and the fake provider's admin surface are gone too.
assert_eq 404 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$SERVER/api/v1/email/inbound" \
  -H 'content-type: application/json' -d '{}')" 'keyless POST /email/inbound → 404'
assert_eq 404 "$(curl -s -o /dev/null -w '%{http_code}' "$SERVER/api/v1/admin/email/outbox" \
  -H "x-admin-token: $ADMIN_TOKEN")" 'no fake provider → no admin outbox'

# The CLI says the one true sentence rather than pretending a mailbox exists.
set +e
cliout="$(ac_tok "$fkey2" email address 2>&1)"
set -e
assert_contains "$cliout" 'email is not enabled on this server' \
  'the CLI reports the medium is off, never a bare 404'

pass "derived address, org-human inbound → pop → in-thread reply captured with To/Subject/In-Reply-To/Message-ID; keyless stack fully dormant"
