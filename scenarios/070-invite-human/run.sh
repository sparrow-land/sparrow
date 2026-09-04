#!/usr/bin/env bash
# 070-invite-human — a signed-in human following a valid invite is admitted
# immediately (a valid invite IS the approval; approval governs agents only):
# instant 201 member + inviter↔joiner DM; a repeat enroll is idempotent (200).
# The pending → approve/deny lifecycle and ?mine scoping are exercised with
# anonymous AGENT knocks, which are what actually queue for review.
set -euo pipefail
SCENARIO_NAME="070-invite-human"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
ownid="$(ac_tok "$owner" whoami --json | jq -r '.id')"

mk_invite() { invite_token_of "$(api "$owner" POST "/orgs/$org/invites" '{}' | jq -r '.url')"; }

# knock_agent <inviteToken> <name> — anonymous enroll → echoes "<eid> <enrToken>".
knock_agent() {
  local resp
  resp="$(curl -sS -X POST "$SERVER/api/v1/invite/$1/enroll" \
    -H 'content-type: application/json' -d "$(jq -cn --arg n "$2" '{name:$n}')")"
  # The trailing newline matters: callers use `read -r a b < <(knock_agent …)`,
  # and `read` returns 1 on an unterminated final line — which `set -e` turns
  # into a silent scenario abort with no FAIL line.
  printf '%s %s\n' "$(jq -r '.enrollment.id' <<<"$resp")" "$(jq -r '.enrollmentToken' <<<"$resp")"
}

# assert_dm_pair <tokA> <idA> <nameA> <tokB> <idB> <nameB> — after a human joins
# by invite, the inviter↔joiner DM exists: each sees the other in the org HUMANS
# sidebar and as a dm-kind room in /me/rooms with the right counterpart.
assert_dm_pair() {
  local ta="$1" ida="$2" na="$3" tb="$4" idb="$5" nb="$6"
  assert_json "$(api "$ta" GET "/orgs/$org/me/humans")" \
    "[.items[] | select(.human.id == \"$idb\")] | length" '1' "$na sees $nb in HUMANS"
  assert_json "$(api "$tb" GET "/orgs/$org/me/humans")" \
    "[.items[] | select(.human.id == \"$ida\")] | length" '1' "$nb sees $na in HUMANS"
  assert_json "$(ac_tok "$ta" rooms --json)" \
    "[.items[] | select(.room.kind == \"dm\" and .room.counterpart.displayName == \"$nb\")] | length" '1' "$na has a DM with $nb"
  assert_json "$(ac_tok "$tb" rooms --json)" \
    "[.items[] | select(.room.kind == \"dm\" and .room.counterpart.displayName == \"$na\")] | length" '1' "$nb has a DM with $na"
}

# --- valid invite admits a human immediately -------------------------------
h2="$(signup h2@ex.com password123 Human2)"
t2="$(mk_invite)"
join2="$(api "$h2" POST "/invite/$t2/enroll" '{"note":"let me in"}')"
assert_json "$join2" '.role' 'member' 'human admitted immediately as member'
assert_json "$join2" '.org.id' "$org" 'admitted into the inviting org'
# No pending enrollment was queued — the approver list stays empty for humans.
assert_json "$(ac_tok "$owner" requests --json)" \
  '[.items[] | select(.kind == "human")] | length' '0' 'no human request queued'
assert_json "$(ac_tok "$h2" orgs --json)" '.items | length' '1' 'H2 is now an org member'

# Immediate admission auto-ensured the inviter↔joiner DM (both directions).
h2id="$(ac_tok "$h2" whoami --json | jq -r '.id')"
assert_dm_pair "$owner" "$ownid" Owner "$h2" "$h2id" Human2

# Idempotent: enrolling again as a member returns 200 (already a member).
code_again="$(http_status "$h2" POST "/invite/$t2/enroll" '{}')"
assert_eq 200 "$code_again" 'repeat enroll by a member is idempotent (200)'

# --- agent knock: pending → deny → denied ----------------------------------
h3t="$(mk_invite)"
read -r eid3 enr3 < <(knock_agent "$h3t" denybot)
assert_json "$(curl -sS "$SERVER/api/v1/invite/$h3t/enrollments/$eid3" -H "authorization: Bearer $enr3")" \
  '.status' 'pending' 'agent knock is pending under approval policy'
ac_tok "$owner" requests deny "$eid3" >/dev/null
assert_json "$(curl -sS "$SERVER/api/v1/invite/$h3t/enrollments/$eid3" -H "authorization: Bearer $enr3")" \
  '.status' 'denied' 'denied reads denied'

# --- enrollments ?mine scoping (agent knocks) ------------------------------
# Two plain members each create an invite that an anonymous agent knocks on.
m1="$(add_human_to_org "$owner" "$org" m1@ex.com password123 MemberOne)"
m2="$(add_human_to_org "$owner" "$org" m2@ex.com password123 MemberTwo)"
tm1="$(invite_token_of "$(api "$m1" POST "/orgs/$org/invites" '{}' | jq -r '.url')")"
tm2="$(invite_token_of "$(api "$m2" POST "/orgs/$org/invites" '{}' | jq -r '.url')")"
read -r eidk1 _ < <(knock_agent "$tm1" knockbot1)
read -r eidk2 _ < <(knock_agent "$tm2" knockbot2)

# A plain-member inviter sees ONLY their own invite's enrollments.
m1list="$(api "$m1" GET "/orgs/$org/enrollments")"
assert_json "$m1list" '[.items[] | select(.proposedName == "knockbot1")] | length' '1' 'M1 sees their own knocker'
assert_json "$m1list" '[.items[] | select(.proposedName == "knockbot2")] | length' '0' 'M1 does not see M2 knocker'

# The owner (admin) sees ALL pending by default…
ownerlist="$(api "$owner" GET "/orgs/$org/enrollments")"
assert_json "$ownerlist" '[.items[] | select(.proposedName == "knockbot1")] | length' '1' 'owner sees knockbot1'
assert_json "$ownerlist" '[.items[] | select(.proposedName == "knockbot2")] | length' '1' 'owner sees knockbot2'
# …but ?mine=true restricts even the owner to their own invites (none here).
ownermine="$(api "$owner" GET "/orgs/$org/enrollments?mine=true")"
assert_json "$ownermine" '[.items[] | select(.proposedName == "knockbot1" or .proposedName == "knockbot2")] | length' '0' 'owner ?mine=true hides others invites'

# --- agent knock: approve → agent minted -----------------------------------
ac_tok "$owner" requests approve "$eidk1" >/dev/null
assert_json "$(api "$m1" GET "/orgs/$org/enrollments")" \
  '[.items[] | select(.proposedName == "knockbot1")] | length' '0' 'approved knocker leaves the pending list'

pass "human invites admit instantly (+ DM, idempotency); agent knocks drive pending/deny/approve + ?mine scoping"
