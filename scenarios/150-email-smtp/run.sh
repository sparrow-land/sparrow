#!/usr/bin/env bash
# 150-email-smtp — the medium over REAL SMTP, with no fake anywhere in the path.
# The only compose scenario in the suite: core (EMAIL_PROVIDER=webhook) +
# apps/mail-gateway + mailpit as the sink + a CoreDNS sidecar publishing the one
# DKIM key the edge must be able to look up.
#
# Four legs, each a claim the fake provider cannot make:
#
#   1. unknown local part → the gateway refuses at SMTP time. Core answers
#      `202 { status: "unknown-recipient" }` and persists NOTHING; the gateway
#      turns that one word into a permanent `550`, so the sending MTA bounces it
#      instead of the message being accepted and dropped.
#   2. a DKIM-SIGNED message to <agent>@<slug><suffix> → mailauth authenticates
#      it at the edge, the gateway POSTs /email/inbound, and the agent pops it
#      as a work item carrying the PASSING verification block. The org trusts
#      `*@partner.example.com`, so the trust ladder delivers it outright.
#   3. the agent replies → core mints the threading identity, posts the outbound
#      webhook envelope, and the gateway relays it DKIM-signed to the sink. The
#      sink's raw source carries the DKIM-Signature, the To, the `Re:` subject,
#      the In-Reply-To pointing back at leg 2, and `Auto-Submitted`.
#   4. the SAME sender, UNSIGNED → not authenticated, but its From would match
#      the trust set: a hard spoof reject (`reason: "spoof"`), never a
#      quarantine. No work item; the refusal is visible on the timeline.
#
# Host requirements are declared, not assumed: without `docker compose` this
# prints SKIP and exits 0 rather than failing the suite.
set -euo pipefail
SCENARIO_NAME="150-email-smtp"
HERE="$(cd "$(dirname "$0")" && pwd)"
SCENARIO_REQUIRES=(compose)
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_requires
# The SMTP client is nodemailer, borrowed from apps/mail-gateway's own deps (see
# send-mail.mjs) — a tree that was installed without it can report the gap the
# same way a missing host tool would.
node -e 'require("node:module").createRequire(process.argv[1]).resolve("nodemailer")' \
  "$SPARROW_REPO_ROOT/apps/mail-gateway/index.cjs" >/dev/null 2>&1 \
  || skip "nodemailer is not installed under apps/mail-gateway (run pnpm install)"

# The DKIM private key whose public half `dns/example.com.db` publishes at
# scn._domainkey.partner.example.com. A 1024-bit throwaway, so the TXT record
# fits in one ≤255-char string.
DKIM_KEY="$(sed -n '/BEGIN PRIVATE KEY/,/END PRIVATE KEY/p' "$HERE/compose.yml" | sed 's/^ *//')"
[ -n "$DKIM_KEY" ] || fail "could not read the test DKIM key out of compose.yml"

# --- send one message over SMTP; echo the sender's JSON result --------------
# `swaks` is the traditional tool here and cannot DKIM-sign; nodemailer can, and
# it is already a dependency of apps/mail-gateway — so no extra host tool.
smtp_send() { # <from> <to> <subject> <text> <messageId> <signed:yes|no> [inReplyTo]
  MAIL_FROM="$1" MAIL_TO="$2" MAIL_SUBJECT="$3" MAIL_TEXT="$4" \
  MAIL_MESSAGE_ID="$5" MAIL_IN_REPLY_TO="${7:-}" \
  SMTP_HOST=127.0.0.1 SMTP_PORT="$SMTP_PORT" \
  DKIM_DOMAIN="$([ "$6" = yes ] && echo partner.example.com || echo '')" \
  DKIM_SELECTOR="$([ "$6" = yes ] && echo scn || echo '')" \
  DKIM_PRIVATE_KEY="$([ "$6" = yes ] && echo "$DKIM_KEY" || echo '')" \
    node "$HERE/send-mail.mjs"
}

# --- mailpit ---------------------------------------------------------------
mailpit_api() { curl -fsS "http://127.0.0.1:${MAILPIT_PORT}/api/v1$1"; }

# wait_mailpit <n> — poll until the sink holds n messages; echo the listing.
wait_mailpit() {
  local want="$1" i list n
  for ((i = 0; i < 60; i++)); do
    list="$(mailpit_api /messages 2>/dev/null || echo '{"messages":[]}')"
    n="$(jq -r '.messages | length' <<<"$list" 2>/dev/null || echo 0)"
    if [ "${n:-0}" -ge "$want" ]; then
      printf '%s' "$list"
      return 0
    fi
    sleep 0.5
  done
  fail "the sink never received $want message(s)"
}

# ===========================================================================
# Bring the stack up. Each service's host port comes from lib.sh's free-port
# helper; the compose network gets a randomized /24 so concurrent runs never
# collide over the DNS sidecar's static address.
# ===========================================================================
_o1=$((RANDOM % 200 + 20)); _o2=$((RANDOM % 250 + 1))
export DNS_SUBNET="10.${_o1}.${_o2}.0/24"
export DNS_IP="10.${_o1}.${_o2}.53"

SCENARIO_COMPOSE_PORTS=(SMTP_PORT GATEWAY_PORT MAILPIT_PORT)
SCENARIO_COMPOSE_READY=(GATEWAY_PORT:/healthz MAILPIT_PORT:/api/v1/messages)
scenario_compose_start "$HERE"

# The stack is real, so the medium is on for the same reason a self-hoster's
# would be: a suffix plus a provider that registers.
caps="$(curl -fsS "$SERVER/api/v1/capabilities")" || fail "GET /capabilities failed"
assert_json "$caps" '.email' 'true' 'the webhook stack reports capabilities.email true'

owner="$(signup owner@example.com password123 Owner)"
org="$(first_org_id "$owner")"
slug="$(api "$owner" GET "/orgs/$org" | jq -r '.org.slug')"
[ -n "$slug" ] && [ "$slug" != null ] || fail "could not read the org slug"

f="$(create_agent "$owner" "$org" fable)"
fid="$(jq -r '.agent.id' <<<"$f")"
fkey="$(jq -r '.key' <<<"$f")"

# The address is derived, never stored: <agent-name>@<org-slug><EMAIL_ORG_SUFFIX>.
addr="$(ac_tok "$fkey" email address --json | jq -r '.address')"
assert_eq "fable@${slug}.example.com" "$addr" 'the agent address is name@slug<suffix>'

# The org trusts the correspondent's whole domain — trust-set entry 4. Nothing
# about that entry can rescue an unauthenticated message (leg 4 is the proof).
api "$owner" PATCH "/orgs/$org" \
  '{"settings":{"email":{"trustedPatterns":["*@partner.example.com"]}}}' >/dev/null \
  || fail "could not set the org email policy"

# ===========================================================================
# Leg 1 — mail for an unknown local part is refused AT SMTP TIME.
# The RCPT suffix matches, so the gateway takes it; core resolves no recipient,
# answers `unknown-recipient`, and the gateway turns that into a permanent 550.
# ===========================================================================
r1="$(smtp_send 'dana@partner.example.com' "ghost@${slug}.example.com" \
      'nobody home' 'body' '<scn-ghost@partner.example.com>' yes)"
assert_json "$r1" '.ok' 'false' 'mail for an unknown local part is NOT accepted'
assert_json "$r1" '.code' '550' 'unknown-recipient is a PERMANENT SMTP failure (550)'
# A domain the gateway does not serve is refused earlier still — it is not an
# open relay.
r1b="$(smtp_send 'dana@partner.example.com' 'someone@elsewhere.invalid' \
       'not ours' 'body' '<scn-relay@partner.example.com>' yes)"
assert_json "$r1b" '.ok' 'false' 'a foreign domain is refused'
assert_json "$r1b" '.code' '550' 'relay access denied is 550 too'

assert_json "$(ac_tok "$fkey" email threads --json)" '.items | length' '0' \
  'an unroutable message persisted nothing'

# ===========================================================================
# Leg 2 — a SIGNED message is delivered, and pops with passing verification.
# ===========================================================================
MID_IN='<scn-signed-1@partner.example.com>'
r2="$(smtp_send 'dana@partner.example.com' "fable@${slug}.example.com" \
      'Q3 rollout' 'Can you confirm the Friday cut?' "$MID_IN" yes)"
assert_json "$r2" '.ok' 'true' 'the signed message is accepted'
assert_json "$r2" '.code' '250' 'core took custody → 250 OK'

p="$(ac_tok "$fkey" pop --json)"
assert_json "$p" '.item.type' 'email' 'the popped work item is an email'
assert_json "$p" '.item.email.direction' 'in' 'it is inbound'
assert_json "$p" '.item.email.disposition' 'delivered' 'a trusted, authenticated sender is delivered'
assert_json "$p" '.item.email.reason' 'null' 'a clean delivery carries no reason'
assert_json "$p" '.item.email.from.email' 'dana@partner.example.com' 'the From survived the edge'
assert_json "$p" '.item.email.to[0].email' "fable@${slug}.example.com" 'addressed at the agent'
assert_json "$p" '.item.email.subject' 'Q3 rollout' 'the subject survived the edge'
assert_json "$p" '.item.email.rfcMessageId' "$MID_IN" 'the Message-ID is passed through verbatim'
assert_contains "$(jq -r '.item.email.text' <<<"$p")" 'Friday cut' 'the body survived MIME normalization'
# The verification block is the EDGE's work, computed by mailauth against the
# DKIM key the DNS sidecar publishes. This is the whole point of the scenario.
assert_json "$p" '.item.email.verification.dkim' 'pass' 'the edge verified the DKIM signature'
assert_json "$p" '.item.email.verification.domain' 'partner.example.com' \
  'and named the domain the passing mechanism authenticated'
assert_json "$p" '.item.email.verification.dmarc' 'none' 'no DMARC record published → none'
assert_json "$p" '.item.email.verification.spf' 'none' 'no SPF record published → none'
# dmarc=none + dkim=pass + domain == the From domain IS the authenticated rule.
eml_in="$(jq -r '.item.email.id' <<<"$p")"
eth="$(jq -r '.item.thread.id' <<<"$p")"
assert_json "$p" '.item.thread.subject' 'Q3 rollout' 'the thread took the inbound subject'
assert_json "$(ac_tok "$fkey" pop --json)" '.item' 'null' 'one message, one work item'

# ===========================================================================
# Leg 3 — the agent replies; the gateway relays it out, signed, to the sink.
# ===========================================================================
rep="$(ac_tok "$fkey" email reply 'Confirmed — Friday it is.' --to "$eml_in" --json)"
assert_json "$rep" '.direction' 'out' 'the reply is outbound'
assert_json "$rep" '.disposition' 'sent' 'a recognized recipient never touches the hold path'
assert_json "$rep" '.threadId' "$eth" 'the reply stayed in the inbound thread'
assert_json "$rep" '.to[0].email' 'dana@partner.example.com' \
  "the recipient set came from the thread's last inbound email"
assert_json "$rep" '.subject' 'Re: Q3 rollout' 'a reply subject gets exactly one Re: prefix'
mid_out="$(jq -r '.rfcMessageId' <<<"$rep")"
assert_contains "$mid_out" "@${slug}.example.com" 'core minted <emailId@agent-domain> before relaying'

list="$(wait_mailpit 1)"
sink_id="$(jq -r '.messages[0].ID' <<<"$list")"
raw="$(mailpit_api "/message/${sink_id}/raw")" || fail "could not read the raw message from the sink"
assert_contains "$raw" 'DKIM-Signature:' 'the gateway signed the outbound message'
assert_contains "$raw" 'd=example.com' 'signed under the configured DKIM domain'
assert_contains "$raw" 's=scn' 'with the configured selector'
assert_contains "$raw" "Message-ID: $mid_out" "the gateway passed core's Message-ID through verbatim"
assert_contains "$raw" "In-Reply-To: $MID_IN" 'In-Reply-To points back at the message being answered'
assert_contains "$raw" "References: $MID_IN" 'References carries the ancestor chain'
assert_contains "$raw" 'dana@partner.example.com' 'addressed to the correspondent'
assert_contains "$raw" 'Subject: Re: Q3 rollout' 'the Re: subject went out on the wire'
assert_contains "$raw" "fable@${slug}.example.com" 'From is the agent address'
assert_contains "$raw" 'Auto-Submitted: auto-generated' 'machine-sent mail says so'
assert_contains "$raw" 'Friday it is' 'the body went out'

# ===========================================================================
# Leg 4 — the SAME would-be-trusted sender, UNSIGNED: a hard spoof reject.
# An org can choose to review strangers; it can never choose to review forgeries.
# ===========================================================================
MID_SPOOF='<scn-unsigned-1@partner.example.com>'
r4="$(smtp_send 'dana@partner.example.com' "fable@${slug}.example.com" \
      'urgent wire transfer' 'send the codes' "$MID_SPOOF" no)"
assert_json "$r4" '.ok' 'true' 'custody is still transferred — a rejection is not a bounce'
assert_json "$r4" '.code' '250' '202 (any disposition) maps to 250 OK'

assert_json "$(ac_tok "$fkey" pop --json)" '.item' 'null' 'a spoof is never a work item'

# The refusal is visible: `email.rejected` on the timeline, and the row itself
# carries the slug. (A rejected inbound keeps metadata only — never the body.)
act="$(ac_tok "$owner" activity --agent fable --json)"
assert_json "$act" '[.items[] | select(.type == "email.rejected")] | length' '1' \
  'the spoof rejection is on the agent timeline'
eml_spoof="$(jq -r '[.items[] | select(.type == "email.rejected")][0].refs.emailId' <<<"$act")"
spoof="$(api "$owner" GET "/orgs/$org/email/emails/$eml_spoof")"
assert_json "$spoof" '.email.disposition' 'rejected' 'the unsigned message was rejected'
assert_json "$spoof" '.email.reason' 'spoof' 'and the reason is the spoof slug, verbatim'
assert_json "$spoof" '.email.verification.dkim' 'none' 'because nothing authenticated it'
assert_json "$spoof" '.email.text' '' 'a rejected inbound keeps metadata only — never the body'
# Never quarantined: it is not in the approvals queue, and no human can approve it.
assert_json "$(api "$owner" GET "/orgs/$org/email/approvals")" '.items | length' '0' \
  'a spoof is never parked for a human'
# The thread it would have opened stays invisible: only delivered/sent mail
# bumps lastEmailAt, so a forgery cannot push a subject into the mailbox.
assert_json "$(ac_tok "$fkey" email threads --json)" '.items | length' '1' \
  'the mailbox still holds exactly the one real conversation'

pass "SMTP in (550 unknown-recipient, signed→delivered with passing verification), reply relayed DKIM-signed to the sink, unsigned trusted-domain sender hard-rejected as spoof"
