#!/usr/bin/env bash
# 010-bootstrap-org — the FIRST signup auto-creates an org (owner); the SECOND
# signup arrives with zero orgs; with orgs.openCreation=false, POST /orgs is 403.
set -euo pipefail
SCENARIO_NAME="010-bootstrap-org"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

# openCreation off: bootstrap still works (it ignores the flag), but a second
# human cannot create additional orgs.
SCENARIO_EXTRA_ENV=(OPEN_ORG_CREATION=false)
scenario_start

# First human on the instance → bootstrapped org, role owner.
owner="$(signup owner@ex.com password123 Owner)"
orgs1="$(ac_tok "$owner" orgs --json)"
assert_json "$orgs1" '.items | length' '1' 'owner has exactly one org'
assert_json "$orgs1" '.items[0].role' 'owner' 'owner role is owner'
org_name="$(printf '%s' "$orgs1" | jq -r '.items[0].org.name')"
assert_contains "$org_name" "Owner" 'org named after the owner'

# Second human → no orgs.
second="$(signup second@ex.com password123 Second)"
orgs2="$(ac_tok "$second" orgs --json)"
assert_json "$orgs2" '.items | length' '0' 'second human has no orgs'

# openCreation=false blocks POST /orgs for the second human.
code="$(http_status "$second" POST /orgs '{"name":"Second Org"}')"
assert_eq 403 "$code" 'POST /orgs blocked when openCreation=false'

pass "bootstrap gave org1 to the owner; second human has none; org creation 403"
