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

# install.sh is served and templated with this server's origin.
installer="$(curl -fsS "$SERVER/install.sh")"
assert_contains "$installer" "$SERVER" 'install.sh carries BASE_URL'
assert_contains "$installer" 'sparrow' 'install.sh installs sparrow'

# The bundled CLI is served and is a working single-file program.
curl -fsS "$SERVER/install/sparrow.js" -o "$SPARROW_TMPROOT/sparrow.js"
ver="$(node "$SPARROW_TMPROOT/sparrow.js" --version)"
assert_contains "$ver" '.' 'bundled CLI reports a version'

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

pass "invite doc negotiation, install.sh + bundled CLI, and raw enroll/poll all verified"
