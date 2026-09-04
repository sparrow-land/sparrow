#!/usr/bin/env bash
# 055-onboarding-doc — the invite URL is content-negotiated: markdown for agents
# (curl UA / */*), the SPA for browsers, ?format=md forces markdown. install.sh
# and the bundled CLI are served and runnable. Raw-API enroll+poll per the doc.
set -euo pipefail
SCENARIO_NAME="055-onboarding-doc"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
url="$(ac_tok "$owner" invites create --json | jq -r '.url')"
token="$(invite_token_of "$url")"

# Agent fetch (default curl UA contains "curl" → markdown even with */*).
ct_agent="$(curl -s -o "$SPARROW_TMPROOT/doc.md" -w '%{content_type}' "$SERVER/invite/$token")"
assert_contains "$ct_agent" 'text/markdown' 'agent gets markdown'
doc="$(cat "$SPARROW_TMPROOT/doc.md")"
assert_contains "$doc" 'enroll' 'doc explains enrolling'
# A valid invite names the org (the bootstrap org is "Owner's org").
assert_contains "$doc" 'Owner' 'doc names the org/inviter'

# Browser fetch (Mozilla UA + Accept text/html) → the SPA.
ct_browser="$(curl -s -o /dev/null -w '%{content_type}' \
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64)' -H 'Accept: text/html' \
  "$SERVER/invite/$token")"
assert_contains "$ct_browser" 'text/html' 'browser gets the SPA'

# ?format=md forces markdown even for a browser.
ct_force="$(curl -s -o /dev/null -w '%{content_type}' \
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64)' -H 'Accept: text/html' \
  "$SERVER/invite/$token?format=md")"
assert_contains "$ct_force" 'text/markdown' 'format=md overrides UA/Accept'

# The installer and the bundles have ONE home (INSTALL_URL, default
# https://sparrow.land): the instance never serves them, it redirects — so old
# links and `sparrow upgrade` on old clients keep working while every document
# says `curl -fsSL https://sparrow.land/install.sh | sh`.
redir() { curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "$1"; }
assert_eq "302 https://sparrow.land/install.sh" "$(redir "$SERVER/install.sh")" \
  'install.sh redirects to the canonical install home'
assert_eq "302 https://sparrow.land/install/sparrow.js" "$(redir "$SERVER/install/sparrow.js")" \
  'the CLI bundle redirects to the canonical install home'
# Docs have one home too (DOCS_URL, default https://sparrow.land/docs): a
# non-browser caller is sent to the markdown page, a browser to the reference page.
assert_eq "302 https://sparrow.land/docs/api/index.md" "$(redir "$SERVER/docs/api")" \
  'docs index redirects agents to the markdown home'
assert_eq "302 https://sparrow.land/docs/api/me/inbox.md" "$(redir "$SERVER/docs/api/me/inbox")" \
  'a docs page redirects agents to its markdown twin'
assert_eq "302 https://sparrow.land/docs/api/" \
  "$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' -A 'Mozilla/5.0' -H 'accept: text/html' "$SERVER/docs/api/me/inbox")" \
  'a browser is sent to the one REST reference page'
# The invite doc itself still tells the agent the canonical install line.
md_doc="$(curl -fsS "$SERVER/invite/$token?format=md")"
assert_contains "$md_doc" 'curl -fsSL https://sparrow.land/install.sh | sh' \
  'the invite doc quotes the canonical installer'

# Raw-API enroll + poll exactly as the doc's Option A prescribes.
enr_resp="$(curl -sS -X POST "$SERVER/api/v1/invite/$token/enroll" \
  -H 'content-type: application/json' -d '{"name":"doc-bot"}')"
eid="$(jq -r '.enrollment.id' <<<"$enr_resp")"
enr="$(jq -r '.enrollmentToken' <<<"$enr_resp")"
assert_json "$(curl -sS "$SERVER/api/v1/invite/$token/enrollments/$eid" -H "authorization: Bearer $enr")" \
  '.status' 'pending' 'poll reports pending before approval'
ac_tok "$owner" requests approve "$eid" >/dev/null
poll="$(curl -sS "$SERVER/api/v1/invite/$token/enrollments/$eid" -H "authorization: Bearer $enr")"
assert_json "$poll" '.status' 'approved' 'poll reports approved'
assert_json "$poll" '(.key // "") | startswith("agk_")' 'true' 'key delivered per the doc'

pass "invite doc negotiation, canonical install/docs redirects, and raw enroll/poll all verified"
