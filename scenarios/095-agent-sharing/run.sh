#!/usr/bin/env bash
# 095-agent-sharing — sharing grants a human visibility: they see the agent, DM
# it, and attach it to rooms. Unsharing is forward-looking: no new DM/attach, but
# existing memberships persist. Grantees cannot re-share; the owner row is
# irrevocable.
#
# This is the EXPLICIT-GRANT story, so the agent is pinned to `sharing: selected`
# (agents mint as `room-members`). It has to be: the grantee attaches the agent to
# a room of their own mid-scenario, and under `room-members` that co-membership
# would legitimately re-grant access — "Under `selected`, room co-membership
# confers nothing" (SPEC → Sharing modes). Mode-driven access is 110's subject.
set -euo pipefail
SCENARIO_NAME="095-agent-sharing"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
ownid="$(ac_tok "$owner" whoami --json | jq -r '.id')"
b="$(create_agent "$owner" "$org" bee)"; bid="$(jq -r '.agent.id' <<<"$b")"
# Explicit grants only — no computed access from a shared room (see the header).
assert_json "$(api "$owner" PATCH "/me/agents/$bid" '{"sharing":"selected"}')" \
  '.agent.sharing' 'selected' 'agent pinned to sharing: selected'

g="$(add_human_to_org "$owner" "$org" grantee@ex.com password123 Grantee)"
gid="$(ac_tok "$g" whoami --json | jq -r '.id')"
add_human_to_org "$owner" "$org" other@ex.com password123 Other >/dev/null

# Before sharing, the grantee cannot see the agent.
assert_json "$(ac_tok "$g" agents --json)" "[.items[] | select(.agent.id == \"$bid\")] | length" '0' 'grantee cannot see agent pre-share'

# Owner shares by email.
ac_tok "$owner" share "$bid" grantee@ex.com >/dev/null
gagents="$(ac_tok "$g" agents --json)"
assert_json "$gagents" "[.items[] | select(.agent.id == \"$bid\")] | length" '1' 'grantee sees agent post-share'
assert_json "$gagents" ".items[] | select(.agent.id == \"$bid\") | .sharedBy.displayName" 'Owner' 'shared-by names the owner'

# Grantees cannot re-share — the agent is not theirs to manage (owner-only
# management routes resolve owner-only, so a non-owner gets not_found).
assert_eq 404 "$(http_status "$g" POST "/me/agents/$bid/share" '{"human":"other@ex.com"}')" 'grantee cannot re-share'

# Grantee DMs the agent and attaches it to a room they own.
assert_json "$(ac_tok "$g" dm "$bid" --json)" '.dm.created' 'true' 'grantee opens a DM'
room1="$(ac_tok "$g" room create granteeroom --json | jq -r '.id')"
ac_tok "$g" room add "$bid" --room "$room1" >/dev/null
assert_json "$(ac_tok "$g" members --room "$room1" --json)" \
  "[.items[] | select(.principalId == \"$bid\")] | length" '1' 'grantee attached the agent'

# The owner's own visibility row is irrevocable.
assert_eq 400 "$(http_status "$owner" DELETE "/me/agents/$bid/share/$ownid")" 'owner row cannot be revoked'

# Owner unshares the grantee.
ac_tok "$owner" unshare "$bid" grantee@ex.com >/dev/null

# Forward-looking: no new DM, no new attach.
assert_eq 403 "$(http_status "$g" POST "/me/dms" "{\"principal\":\"$bid\"}")" 're-ensure DM after unshare → 403'
room2="$(ac_tok "$g" room create granteeroom2 --json | jq -r '.id')"
assert_eq 403 "$(http_status "$g" POST "/rooms/$room2/members" "{\"principal\":\"$bid\"}")" 'new attach after unshare → 403'

# But existing memberships persist.
assert_json "$(ac_tok "$g" members --room "$room1" --json)" \
  "[.items[] | select(.principalId == \"$bid\")] | length" '1' 'existing room membership persists'
assert_json "$(ac_tok "$g" rooms --json)" \
  '[.items[] | select(.room.kind == "dm" and .room.counterpart.displayName == "bee")] | length' '1' 'existing DM room with the agent persists'

pass "share grants see/DM/attach; unshare is forward-looking; owner row irrevocable"
