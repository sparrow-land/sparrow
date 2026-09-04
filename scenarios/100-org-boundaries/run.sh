#!/usr/bin/env bash
# 100-org-boundaries — two orgs stay strictly isolated: directory, agents, and
# rooms are per-org; a cross-org DM is 403; a human in both orgs sees per-org
# lists; the org governance agent list is owner/admin-only.
set -euo pipefail
SCENARIO_NAME="100-org-boundaries"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

# Org 1 (bootstrap) and Org 2 (created by a second human).
owner1="$(signup owner1@ex.com password123 OwnerOne)"
org1="$(first_org_id "$owner1")"
owner2="$(signup owner2@ex.com password123 OwnerTwo)"
org2="$(api "$owner2" POST /orgs '{"name":"Org Two"}' | jq -r '.org.id')"
assert_json "$(ac_tok "$owner2" orgs --json)" '.items[0].role' 'owner' 'owner2 owns org2'

# Owner1 also joins org2 → a human in both orgs.
enroll_existing_human "$owner2" "$org2" "$owner1"
assert_json "$(ac_tok "$owner1" orgs --json)" '.items | length' '2' 'owner1 is in both orgs'

# A human X only in org1.
x="$(add_human_to_org "$owner1" "$org1" xavier@ex.com password123 Xavier)"
xid="$(ac_tok "$x" whoami --json | jq -r '.id')"

# Agents: A1 in org1, A2 in org2. Rooms: R1 in org1, R2 in org2.
a1="$(create_agent "$owner1" "$org1" agent-one | jq -r '.agent.id')"
a2="$(create_agent "$owner2" "$org2" agent-two | jq -r '.agent.id')"
r1="$(ac_tok "$owner1" room create room-one --org "$org1" --json | jq -r '.id')"
ac_tok "$owner2" room create room-two --org "$org2" --json >/dev/null

# Rooms are per-org: owner1's org1 rooms include R1; its org2 rooms do not.
assert_json "$(ac_tok "$owner1" rooms --org "$org1" --json)" "[.items[] | select(.room.id == \"$r1\")] | length" '1' 'R1 listed under org1'
assert_json "$(ac_tok "$owner1" rooms --org "$org2" --json)" "[.items[] | select(.room.id == \"$r1\")] | length" '0' 'R1 not listed under org2'

# Agents are per-org and visibility-scoped: A1 under org1 only; A2 invisible to owner1.
assert_json "$(ac_tok "$owner1" agents --org "$org1" --json)" "[.items[] | select(.agent.id == \"$a1\")] | length" '1' 'A1 visible in org1'
assert_json "$(ac_tok "$owner1" agents --org "$org2" --json)" "[.items[] | select(.agent.id == \"$a1\")] | length" '0' 'A1 not in org2 list'
assert_json "$(ac_tok "$owner1" agents --org "$org1" --json)" "[.items[] | select(.agent.id == \"$a2\")] | length" '0' 'A2 (org2) not visible to owner1'

# Directory is per-org: X is findable in org1, absent from org2.
assert_json "$(api "$owner1" GET "/orgs/$org1/directory?q=xavier")" '[.items[] | select(.id == "'"$xid"'")] | length' '1' 'X in org1 directory'
assert_json "$(api "$owner2" GET "/orgs/$org2/directory?q=xavier")" '.items | length' '0' 'X absent from org2 directory'

# Cross-org DM is refused (owner2 and X share no org).
assert_eq 403 "$(http_status "$owner2" POST /me/dms "{\"principal\":\"$xid\"}")" 'cross-org DM → 403'

# Governance agent list is owner/admin-only.
assert_json "$(api "$owner1" GET "/orgs/$org1/agents")" "[.items[] | select(.agent.id == \"$a1\")] | length" '1' 'governance list has A1 (owner)'
assert_eq 403 "$(http_status "$x" GET "/orgs/$org1/agents")" 'governance list forbidden to a plain member'

pass "orgs isolated across directory/agents/rooms; cross-org DM 403; governance gated"
