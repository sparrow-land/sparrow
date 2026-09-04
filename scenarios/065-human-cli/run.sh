#!/usr/bin/env bash
# 065-human-cli — `sparrow login` stores a ses_ session that authenticates /me/*,
# room routes, and org routes; logging the session out kills it.
set -euo pipefail
SCENARIO_NAME="065-human-cli"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

# Create the account (bootstraps the org), then log in through the CLI.
signup owner@ex.com password123 Owner >/dev/null
export SPARROW_EMAIL=owner@ex.com SPARROW_PASSWORD=password123
login_out="$(ac_as owner login)"
assert_contains "$login_out" 'Logged in as Owner' 'login succeeded'
unset SPARROW_EMAIL SPARROW_PASSWORD

# /me/* — whoami resolves the human principal from the stored ses_ token.
assert_json "$(ac_as owner whoami --json)" '.type' 'human' 'whoami via stored session'
# org route — /me/orgs.
assert_json "$(ac_as owner orgs --json)" '.items[0].role' 'owner' 'orgs via stored session'
# org route — invites list (org-scoped).
ac_as owner invites list --json >/dev/null || fail 'invites list failed'
# room route — create a room, then list its members.
room="$(ac_as owner room create loungeroom --json | jq -r '.id')"
assert_json "$(ac_as owner members --room "$room" --json)" \
  '[.items[] | select(.kind == "human")] | length' '1' 'room members via stored session'

# Log the session out (no CLI verb for logout — hit the API with the stored
# token), then confirm the token is dead.
sestok="$(jq -r '.profiles | to_entries[0].value.token' "$SPARROW_TMPROOT/cfg-owner/sparrow/credentials.json")"
assert_contains "$sestok" 'ses_' 'stored a ses_ session token'
curl -fsS -X POST "$SERVER/api/v1/auth/logout" -H "authorization: Bearer $sestok" >/dev/null
code="$(http_status "$sestok" GET /me)"
assert_eq 401 "$code" 'session token rejected after logout'

pass "sparrow login session works across /me, room, and org routes; logout kills it"
