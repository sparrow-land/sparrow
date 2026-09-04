#!/usr/bin/env bash
# 015-invite-agent — create an invite → anonymous agent enroll → approve (yes/no;
# the proposed name is final) → key delivered EXACTLY once → owner↔agent DM
# auto-ensured → visibility row exists. An email-unsafe proposed name is rejected
# at the knock (v4 name rule). An invalid invite 404s; a REVOKED one 410s (it was
# a real door, closed on purpose) with a message naming why.
set -euo pipefail
SCENARIO_NAME="015-invite-agent"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"

# Owner creates an invite (token appears once, in url).
url="$(ac_tok "$owner" invites create --note "come aboard" --json | jq -r '.url')"
token="$(invite_token_of "$url")"

# GET /invite/:token/info (no auth) — the SPA landing metadata names the org and
# the inviter, including the inviter's email, and states the agent policy.
info="$(curl -fsS "$SERVER/api/v1/invite/$token/info")"
assert_json "$info" '.inviter.email' 'owner@ex.com' 'invite info reveals the inviter email'
assert_json "$info" '.inviter.displayName' 'Owner' 'invite info reveals the inviter name'
assert_json "$info" '.agentPolicy' 'approval' 'invite info states the agent policy'

# v4 agent names ARE email local parts, so an email-unsafe proposed name is
# rejected up front (400) — before any enrollment row exists. Uppercase, v3's
# `host:folder` colon form, a trailing dot and an embedded `..` all fail the rule.
for bad in 'Deploy-Bot' 'demo1:projects/foo' 'deploy-bot.' 'deploy..bot'; do
  code="$(http_status '' POST "/invite/$token/enroll" "$(jq -cn --arg n "$bad" '{name:$n}')")"
  assert_eq 400 "$code" "email-unsafe proposed name [$bad] → 400"
done

# Anonymous enroll → agent enrollment held for approval (202 + one-time enr_).
enr_resp="$(curl -sS -X POST "$SERVER/api/v1/invite/$token/enroll" \
  -H 'content-type: application/json' -d '{"name":"deploy-bot","note":"ci runner"}')"
eid="$(jq -r '.enrollment.id' <<<"$enr_resp")"
enr="$(jq -r '.enrollmentToken' <<<"$enr_resp")"
assert_json "$enr_resp" '.enrollment.status' 'pending' 'enrollment pending'
[ -n "$eid" ] && [ "$eid" != null ] || fail "no enrollment id"

# Owner sees the pending request and approves it. v4 approval is strictly
# yes/no — the name the agent proposed at the knock is final.
reqs="$(ac_tok "$owner" requests --json)"
assert_json "$reqs" '.items[0].kind' 'agent' 'pending request is an agent'
assert_json "$reqs" '.items[0].proposedName' 'deploy-bot' 'proposed name'
ac_tok "$owner" requests approve "$eid" >/dev/null

# First poll: approved, agent minted, key + dmRoomId delivered ONCE.
poll1="$(curl -sS "$SERVER/api/v1/invite/$token/enrollments/$eid" -H "authorization: Bearer $enr")"
assert_json "$poll1" '.status' 'approved' 'first poll approved'
assert_json "$poll1" '.agent.name' 'deploy-bot' 'minted with the proposed name (approval is yes/no)'
assert_json "$poll1" '(.key // "") | startswith("agk_")' 'true' 'agent key delivered'
dm_room="$(jq -r '.dmRoomId' <<<"$poll1")"
agk="$(jq -r '.key' <<<"$poll1")"
[ -n "$dm_room" ] && [ "$dm_room" != null ] || fail "no dmRoomId in delivery"

# Second poll: still approved, but the key is NOT re-delivered.
poll2="$(curl -sS "$SERVER/api/v1/invite/$token/enrollments/$eid" -H "authorization: Bearer $enr")"
assert_json "$poll2" '.status' 'approved' 'second poll approved'
assert_json "$poll2" '(.key // "null")' 'null' 'key delivered exactly once'

# Owner↔agent DM auto-ensured: the dmRoomId is one of the owner's rooms with the
# agent as counterpart.
rooms="$(ac_tok "$owner" rooms --json)"
assert_json "$rooms" "[.items[] | select(.room.id == \"$dm_room\")] | length" '1' 'owner has the auto DM room'
assert_json "$rooms" ".items[] | select(.room.id == \"$dm_room\") | .room.counterpart.displayName" 'deploy-bot' 'DM counterpart is the agent'

# Visibility row exists: the owner sees the agent in their visibility list.
agents="$(ac_tok "$owner" agents --json)"
assert_json "$agents" '[.items[] | select(.agent.name == "deploy-bot")] | length' '1' 'agent visible to owner'

# The minted key authenticates as the agent.
assert_json "$(ac_tok "$agk" whoami --json)" '.type' 'agent' 'agent key works'

# Revoked invite → 410 gone (naming the revocation). Unknown token → 404.
rev="$(ac_tok "$owner" invites create --json)"
rev_tok="$(invite_token_of "$(jq -r '.url' <<<"$rev")")"
rev_id="$(jq -r '.invite.id' <<<"$rev")"
ac_tok "$owner" invites revoke "$rev_id" >/dev/null
code_revoked="$(http_status '' POST "/invite/$rev_tok/enroll" '{"name":"late"}')"
assert_eq 410 "$code_revoked" 'revoked invite enroll → 410'
code_bogus="$(http_status '' POST "/invite/ivk_totallyinvalidtoken/enroll" '{"name":"nope"}')"
assert_eq 404 "$code_bogus" 'invalid invite enroll → 404'

pass "invite → enroll → approve(yes/no) → key once → auto DM + visibility; unsafe names 400; revoked 410 / invalid 404"
