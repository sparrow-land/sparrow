#!/usr/bin/env bash
# 110-sidebar-sources — the #borg regression. The AGENTS sidebar (/orgs/:id/me/
# agents) is the visibility list, independent of any room: owned agents appear
# whether or not they are in a room, and under `sharing: selected` sharing a room
# with an agent grants NO visibility ("Under `selected`, room co-membership
# confers nothing" — SPEC → Sharing modes). The claim is about the SOURCE of the
# list, so it is pinned on a `selected` agent; the last leg flips the same agent
# to `room-members` and shows co-membership then doing its job. The HUMANS
# sidebar (/orgs/:id/me/humans) is the org roster — every member but the caller,
# room-shared or not — with rooms supplying only presence.
set -euo pipefail
SCENARIO_NAME="110-sidebar-sources"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
ownid="$(ac_tok "$owner" whoami --json | jq -r '.id')"

# Two owned agents: B (will share a room with a bystander) and D (in no room).
bid="$(create_agent "$owner" "$org" bee | jq -r '.agent.id')"
did="$(create_agent "$owner" "$org" denise | jq -r '.agent.id')"

# Agents mint with `sharing: room-members` (the default). The #borg claim — that
# the AGENTS list is a visibility list and never room-derived — is the `selected`
# rule, so pin B there explicitly rather than leaning on any default.
assert_json "$(api "$owner" PATCH "/me/agents/$bid" '{"sharing":"selected"}')" \
  '.agent.sharing' 'selected' 'B pinned to sharing: selected'

# A bystander human G, and an unrelated human H (never co-located with G).
g="$(add_human_to_org "$owner" "$org" g@ex.com password123 Gee)"
gid="$(ac_tok "$g" whoami --json | jq -r '.id')"
h="$(add_human_to_org "$owner" "$org" h@ex.com password123 Aitch)"
hid="$(ac_tok "$h" whoami --json | jq -r '.id')"

# Put G and agent B in the SAME room (co-membership, but NO share to G).
room="$(ac_tok "$owner" room create sharedroom --json | jq -r '.id')"
ac_tok "$owner" room add "$bid" --room "$room" >/dev/null
ac_tok "$owner" room invite g@ex.com --room "$room" >/dev/null
rin="$(ac_tok "$g" invitations --json | jq -r '.items[0].id')"
ac_tok "$g" invitations accept "$rin" >/dev/null

# AGENTS is room-independent: the owner sees BOTH B (in a room) and D (in none).
own_agents="$(api "$owner" GET "/orgs/$org/me/agents")"
assert_json "$own_agents" "[.items[] | select(.agent.id == \"$bid\")] | length" '1' 'owner sees roomed agent B'
assert_json "$own_agents" "[.items[] | select(.agent.id == \"$did\")] | length" '1' 'owner sees roomless agent D'

# #borg: under `selected`, co-membership grants G NO visibility on B.
g_org_agents="$(api "$g" GET "/orgs/$org/me/agents")"
assert_json "$g_org_agents" "[.items[] | select(.agent.id == \"$bid\")] | length" '0' 'room co-membership grants NO agent visibility (org endpoint)'
assert_json "$(ac_tok "$g" agents --json)" "[.items[] | select(.agent.id == \"$bid\")] | length" '0' 'nor via /me/agents'

# The mode is what decides, not the room: flip the SAME agent in the SAME room to
# `room-members` and G — still holding no explicit grant — now sees it on both
# endpoints. Flip back and the visibility goes away again (access is computed,
# never a stored grant).
assert_json "$(api "$owner" PATCH "/me/agents/$bid" '{"sharing":"room-members"}')" \
  '.agent.sharing' 'room-members' 'B flipped to sharing: room-members'
assert_json "$(api "$g" GET "/orgs/$org/me/agents")" \
  "[.items[] | select(.agent.id == \"$bid\")] | length" '1' 'room-members makes the co-member see B (org endpoint)'
assert_json "$(ac_tok "$g" agents --json)" \
  "[.items[] | select(.agent.id == \"$bid\")] | length" '1' 'and via /me/agents'
api "$owner" PATCH "/me/agents/$bid" '{"sharing":"selected"}' >/dev/null
assert_json "$(api "$g" GET "/orgs/$org/me/agents")" \
  "[.items[] | select(.agent.id == \"$bid\")] | length" '0' 'back to selected → computed access drops'

# HUMANS is the ORG roster, not a room projection: "every human member of the org
# except the caller … a member the caller shares no room with still appears, with
# `lastSeenAt: null`" (SPEC → /orgs/:orgId/me/humans). Rooms only supply presence:
# G shares a room with the owner (lastSeenAt set) and none with H (null) — but
# both are listed.
g_humans="$(api "$g" GET "/orgs/$org/me/humans")"
assert_json "$g_humans" "[.items[] | select(.human.id == \"$ownid\")] | length" '1' 'G sees the owner (shared room)'
assert_json "$g_humans" "[.items[] | select(.human.id == \"$hid\")] | length" '1' 'G ALSO sees the room-less member H'
assert_json "$g_humans" ".items[] | select(.human.id == \"$hid\") | .lastSeenAt" 'null' 'H has no shared room → lastSeenAt null'
assert_json "$g_humans" "[.items[] | select(.human.id == \"$gid\")] | length" '0' 'the caller is never in their own roster'

pass "AGENTS is visibility-scoped & room-independent under selected (#borg), room-members flips it; HUMANS is the org roster"
