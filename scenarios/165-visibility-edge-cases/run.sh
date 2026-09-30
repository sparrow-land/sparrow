#!/usr/bin/env bash
# 165-visibility-edge-cases — the edge cases of agent visibility (tags, the
# per-agent messaging policy, delegated grants, analytics) that 160 does not
# walk, driven through the raw /api/v1 wire contract:
#
#   defaults        fresh agents carry tags [] / messaging any, and DMs, room
#                   posts and human DMs behave exactly as before;
#   validation      tag slug shape, the 10-tag cap, sorted tags, bad policy
#                   values, bad grant scopes and principal ids → 400;
#   open-dm-policy  a policy change bites an ALREADY-OPEN agent↔agent DM: sends
#                   (and re-ensures) refused after tightening with the blocking
#                   side named, history still readable, allowed after loosening;
#                   both sides blocking → both named;
#   tag-removed     `tags` policy + the shared tag removed from ONE side
#                   mid-conversation → refused both ways; re-adding it reopens;
#   agent-to-human  `tags` / `none` never restrict agent→human DMs or room posts;
#   delegate        a `tag:T` holder: cannot grant (itself, its granter, anyone),
#                   cannot change its own tags/policy, cannot act outside T,
#                   CAN add T to an untagged agent (spec: "add/remove that tag
#                   on agents"), loses everything once its grant is revoked;
#   chief           a `tags:*` holder grants only `tag:<slug>`, never to itself,
#                   and a `tag:T` holder cannot touch it (outranked) or revoke a
#                   grant it did not create;
#   no-authority    a plain member / a grant-less agent is refused tags,
#                   messaging, grants and another agent's analytics;
#   cross-org       another org's agent / grant / member ids → 404 (never 403),
#                   byte-identical to a fabricated id;
#   analytics       a refused send/ensure counts nothing; an agent→human DM
#                   lands in withHumans;
#   cascade         deleting an agent drops the grants it held; removing a
#                   human from the org drops the grants they held.
#
# Every case runs to completion and the scenario prints a per-case PASS/FAIL
# table; a failing case prints the exact request and response. Behaviour the
# spec does not define is printed as OBSERVED (informational, never a failure).
set -euo pipefail
SCENARIO_NAME="165-visibility-edge-cases"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

# --------------------------------------------------------------------------
# Harness: actors by name, one request helper, per-case isolation.
# --------------------------------------------------------------------------
declare -A TOK=()   # actor name → bearer token (ses_ / agk_)
declare -A ID=()    # actor name → principal id (usr_ / agt_)

# req <actor> <METHOD> <path> [json-body] — sets ST (status), BODY, LAST (the
# exchange, verbatim, for failure reports). Never fails by itself.
req() {
  local who="$1" m="$2" p="$3" b="${4:-}" f
  f="$SPARROW_TMPROOT/resp.$BASHPID"
  local -a args=(-sS -o "$f" -w '%{http_code}' -X "$m" "$SERVER/api/v1$p"
    -H "authorization: Bearer ${TOK[$who]}")
  [ -n "$b" ] && args+=(-H 'content-type: application/json' -d "$b")
  ST="$(curl "${args[@]}" 2>/dev/null || true)"
  BODY="$(cat "$f" 2>/dev/null || true)"
  LAST="[$who] $m $p${b:+ $b} → $ST $BODY"
}

# expect_status <code> <label>
expect_status() {
  [ "$ST" = "$1" ] || fail "$2: expected HTTP $1 — $LAST"
}
# expect_json <jq-filter> <expected> <label>
expect_json() {
  local got
  got="$(printf '%s' "$BODY" | jq -r "$1" 2>/dev/null || echo '<jq error>')"
  [ "$got" = "$2" ] || fail "$3: [$1] expected [$2] got [$got] — $LAST"
}
# expect_refused <code> <reason|-> <label> — status plus error.reason ('-' = any).
expect_refused() {
  expect_status "$1" "$3"
  [ "$2" = "-" ] || expect_json '.error.reason' "$2" "$3 (reason)"
}

# observe <text> — record behaviour the spec does not define (printed, never judged).
observe() { printf '%s\n' "$*" >>"$SPARROW_TMPROOT/obs.$CASE_NAME"; }

CASES=(); RESULTS=(); FAILURES=()
# run_case <name> <function> — run a case in a subshell: a `fail` ends the case,
# not the scenario. State shared across cases lives on the SERVER (and in the
# setup globals), never in shell variables set inside a case.
run_case() {
  local name="$1" fn="$2" out obs
  CASE_NAME="$name"; obs="$SPARROW_TMPROOT/obs.$name"
  if out="$( ( "$fn" ) 2>&1 )"; then
    RESULTS+=("PASS"); echo "  PASS  $name"
  else
    RESULTS+=("FAIL"); echo "  FAIL  $name"
    FAILURES+=("$name: $(printf '%s' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -F 'FAIL ' | head -1)")
  fi
  CASES+=("$name")
  if [ -s "$obs" ]; then while IFS= read -r l; do OBSERVED_ALL+=("$name: $l"); done <"$obs"; fi
}
OBSERVED_ALL=()

j() { jq -cn "$@"; }

# --------------------------------------------------------------------------
# Setup: org 1 with an owner, a plain member, a delegate human; agents minted
# by the owner who have all met in one room. Org 2 for the cross-org cases.
# --------------------------------------------------------------------------
TOK[owner]="$(signup owner@ex.com password123 Owner)"
ORG="$(first_org_id "${TOK[owner]}")"
ID[owner]="$(api "${TOK[owner]}" GET /me | jq -r '.principal.id')"
TOK[member]="$(add_human_to_org "${TOK[owner]}" "$ORG" member@ex.com password123 Member)"
ID[member]="$(api "${TOK[member]}" GET /me | jq -r '.principal.id')"
TOK[dora]="$(add_human_to_org "${TOK[owner]}" "$ORG" dora@ex.com password123 Dora)"
ID[dora]="$(api "${TOK[dora]}" GET /me | jq -r '.principal.id')"
for who in owner member dora; do
  case "${ID[$who]}" in usr_*) : ;; *) fail "setup: could not resolve $who's id (${ID[$who]})" ;; esac
done

mint() { # mint <owner-actor> <name> — agent created by that human, joined to the crew room
  local r
  r="$(create_agent "${TOK[$1]}" "$ORG" "$2")" || fail "setup: create agent $2"
  ID[$2]="$(jq -r '.agent.id' <<<"$r")"; TOK[$2]="$(jq -r '.key' <<<"$r")"
  printf '%s' "$r" >"$SPARROW_TMPROOT/created.$2"
}
for a in ant bee cat dan eel fox gnu hen; do mint owner "$a"; done

CREW="$(ac_tok "${TOK[owner]}" room create crew --json | jq -r '.id')"
[ -n "$CREW" ] && [ "$CREW" != null ] || fail "setup: create crew room"
for a in ant bee cat dan eel fox gnu hen; do
  ac_tok "${TOK[owner]}" room add "${ID[$a]}" --room "$CREW" >/dev/null || fail "setup: add $a to crew"
done

# Org 2: a second human's own org, with an agent and a grant of its own.
TOK[owner2]="$(signup owner2@ex.com password123 OwnerTwo)"
ORG2="$(api "${TOK[owner2]}" POST /orgs '{"name":"Org Two"}' | jq -r '.org.id')"
ID[owner2]="$(api "${TOK[owner2]}" GET /me | jq -r '.principal.id')"
r="$(create_agent "${TOK[owner2]}" "$ORG2" zed)"; ID[zed]="$(jq -r '.agent.id' <<<"$r")"; TOK[zed]="$(jq -r '.key' <<<"$r")"
TOK[yak2]="$(add_human_to_org "${TOK[owner2]}" "$ORG2" yak@ex.com password123 Yak)"
ID[yak2]="$(api "${TOK[yak2]}" GET /me | jq -r '.principal.id')"
G2="$(api "${TOK[owner2]}" POST "/orgs/$ORG2/grants" "$(j --arg p "${ID[zed]}" '{principalId:$p,scope:"tag:ops"}')" | jq -r '.grant.id')"
case "$G2" in grt_*) : ;; *) fail "setup: org2 grant ($G2)" ;; esac

A="/orgs/$ORG/agents"
# dm <actor> <principal-id> — ensure a DM, echo the room id (sets ST/BODY/LAST).
dm_room() { req "$1" POST /me/dms "$(j --arg p "$2" '{principal:$p}')"; }
send() { req "$1" POST "/rooms/$2/messages" "$(j --arg b "$3" '{body:$b}')"; }
set_policy() { req owner PUT "$A/${ID[$1]}/messaging" "$(j --arg m "$2" '{messaging:$m}')"; expect_status 200 "setup policy $1=$2"; }
set_tags() { req owner PUT "$A/${ID[$1]}/tags" "$(jq -cn --args '{tags:$ARGS.positional}' "${@:2}")"; expect_status 200 "setup tags $1"; }
grant() { # grant <actor> <principal-name> <scope> → echoes grant id
  req "$1" POST "/orgs/$ORG/grants" "$(j --arg p "${ID[$2]}" --arg s "$3" '{principalId:$p,scope:$s}')"
}

# --------------------------------------------------------------------------
# Cases
# --------------------------------------------------------------------------

case_defaults() {
  local created room
  created="$(cat "$SPARROW_TMPROOT/created.hen")"
  BODY="$created"; LAST="POST /me/agents → $created"
  expect_json '.agent.tags | length' '0' 'minted agent has no tags'
  expect_json '.agent.messaging' 'any' 'minted agent defaults to any'
  req hen GET "$A/${ID[hen]}"
  expect_status 200 'agent reads itself via the org route'
  expect_json '.agent.tags | length' '0' 'GET agent: tags []'
  expect_json '.agent.messaging' 'any' 'GET agent: messaging any'
  # Untouched agents that have met DM each other and post in the room as before.
  dm_room hen "${ID[gnu]}"; expect_status 201 'default hen → gnu DM ensure'
  room="$(jq -r '.room.id' <<<"$BODY")"
  send hen "$room" 'hi gnu'; expect_status 201 'default hen → gnu send'
  send gnu "$room" 'hi hen'; expect_status 201 'default gnu → hen reply'
  send hen "$CREW" 'hello crew'; expect_status 201 'default room post'
  dm_room hen "${ID[owner]}"; expect_status 201 'default hen → owner DM ensure'
  send hen "$(jq -r '.room.id' <<<"$BODY")" 'hi owner'; expect_status 201 'default hen → owner send'
  # The agents list carries the new fields with defaults for everyone.
  req owner GET "/me/agents"
  if [ "$ST" = 200 ]; then
    expect_json "[.. | objects | select(.id? == \"${ID[hen]}\" and has(\"messaging\")) | .messaging] | first" 'any' 'agents list: hen messaging any'
  fi
}

case_validation() {
  req owner PUT "$A/${ID[eel]}/tags" '{"tags":["Cubes"]}';   expect_status 400 'uppercase slug'
  req owner PUT "$A/${ID[eel]}/tags" '{"tags":["-lead"]}';   expect_status 400 'leading hyphen'
  req owner PUT "$A/${ID[eel]}/tags" "$(j --arg t "a$(printf 'b%.0s' {1..32})" '{tags:[$t]}')"; expect_status 400 '33-char slug'
  req owner PUT "$A/${ID[eel]}/tags" "$(j --arg t "a$(printf 'b%.0s' {1..31})" '{tags:[$t]}')"; expect_status 200 '32-char slug is the max'
  req owner PUT "$A/${ID[eel]}/tags" '{"tags":["t1","t2","t3","t4","t5","t6","t7","t8","t9","t10","t11"]}'
  expect_status 400 '11 tags'
  req owner PUT "$A/${ID[eel]}/tags" '{"tags":["t9","t1","t2","t3","t4","t5","t6","t7","t8","t10"]}'
  expect_status 200 '10 tags is the cap'
  expect_json '.agent.tags | join(",")' 't1,t10,t2,t3,t4,t5,t6,t7,t8,t9' 'tags come back sorted'
  req owner PUT "$A/${ID[eel]}/tags" '{"tags":[]}'; expect_status 200 'clear tags'
  expect_json '.agent.tags | length' '0' 'tags cleared'
  req owner PUT "$A/${ID[eel]}/messaging" '{"messaging":"some"}'; expect_status 400 'bad policy value'
  req owner PUT "$A/${ID[eel]}/messaging" '{}';                    expect_status 400 'missing policy'
  grant owner eel 'tag:Bad';   expect_status 400 'bad grant slug'
  grant owner eel 'admin';     expect_status 400 'unknown scope'
  grant owner eel 'tags:ops';  expect_status 400 'tags:<x> is not a scope'
  req owner POST "/orgs/$ORG/grants" '{"principalId":"foo_123","scope":"tag:x"}'; expect_status 400 'non-principal id'
}

case_open_dm_policy() {
  local room
  dm_room ant "${ID[bee]}"; expect_status 201 'ant → bee DM (both any)'
  room="$(jq -r '.room.id' <<<"$BODY")"
  send ant "$room" 'before'; expect_status 201 'send before tightening'

  set_policy ant none
  send ant "$room" 'after none'
  expect_refused 403 messaging_policy 'ant (none) send into the open DM'
  expect_json '.error.message | contains("ant’s messaging setting is `none`")' 'true' 'names ant’s setting'
  send bee "$room" 'reply after none'
  expect_refused 403 messaging_policy 'bee send into the DM ant tightened'
  expect_json '.error.message | contains("ant")' 'true' 'bee hears ant’s setting'
  dm_room bee "${ID[ant]}"
  expect_refused 403 messaging_policy 're-ensure of the existing DM is refused too'
  # History stays readable for both sides.
  req ant GET "/rooms/$room/messages"; expect_status 200 'ant still reads the DM'
  expect_json '[.items[]? // .messages[]? | select(.body == "before")] | length' '1' 'history kept (ant)'
  req bee GET "/rooms/$room/messages"; expect_status 200 'bee still reads the DM'

  # Both sides blocking → both named.
  set_policy bee tags
  send bee "$room" 'both blocked'
  expect_refused 403 messaging_policy 'both sides block'
  expect_json '.error.message | (contains("ant’s messaging setting is `none`") and contains("bee’s messaging setting is `tags`"))' 'true' 'both sides named'

  # Loosen: back to any → the same DM works again, both directions.
  set_policy ant any
  set_policy bee any
  send ant "$room" 'after loosening'; expect_status 201 'ant sends after loosening'
  send bee "$room" 'reply after loosening'; expect_status 201 'bee sends after loosening'
}

case_tag_removed_midway() {
  local room
  set_tags cat cubes
  set_tags dan cubes
  set_policy cat tags
  dm_room cat "${ID[dan]}"; expect_status 201 'cat (tags) → dan share cubes'
  room="$(jq -r '.room.id' <<<"$BODY")"
  send dan "$room" 'shared tag'; expect_status 201 'dan (any) → cat while shared'

  # Remove the shared tag from dan (the side whose policy is `any`).
  set_tags dan
  send cat "$room" 'after removal'
  expect_refused 403 messaging_policy 'cat sends after dan lost the shared tag'
  expect_json '.error.message | contains("cat’s messaging setting is `tags`")' 'true' 'names cat (the tags side)'
  send dan "$room" 'after removal'
  expect_refused 403 messaging_policy 'dan (any) is refused too: both policies must allow'
  req dan GET "/rooms/$room/messages"; expect_status 200 'dan still reads the DM'

  # A different tag on dan does not count; the shared one reopens.
  set_tags dan reviewers
  send cat "$room" 'still no'; expect_refused 403 messaging_policy 'non-shared tag does not reopen'
  set_tags dan cubes reviewers
  send cat "$room" 'shared again'; expect_status 201 'shared tag back → allowed'
  send dan "$room" 'shared again'; expect_status 201 'dan allowed again'
  set_policy cat any; set_tags cat; set_tags dan
}

case_agent_to_human() {
  local room policy
  for policy in tags none; do
    set_policy fox "$policy"
    dm_room fox "${ID[owner]}"
    [ "$ST" = 200 ] || [ "$ST" = 201 ] || fail "fox ($policy) → owner DM ensure: $LAST"
    room="$(jq -r '.room.id' <<<"$BODY")"
    send fox "$room" "to owner under $policy"; expect_status 201 "fox ($policy) → owner send"
    send owner "$room" "owner reply under $policy"; expect_status 201 "owner → fox ($policy) send"
    send fox "$CREW" "room post under $policy"; expect_status 201 "fox ($policy) room post"
  done
  # …while agent→agent is refused under `none`.
  dm_room fox "${ID[gnu]}"; expect_refused 403 messaging_policy 'fox (none) → gnu refused'
  set_policy fox any
}

# A `tag:cubes` delegate that is an AGENT (cat) and one that is a HUMAN (dora).
case_delegate() {
  set_tags bee cubes
  set_tags gnu
  grant owner cat tag:cubes; [ "$ST" = 201 ] || [ "$ST" = 200 ] || fail "grant cat tag:cubes: $LAST"
  local gcat; gcat="$(jq -r '.grant.id' <<<"$BODY")"
  grant owner dora tag:cubes; [ "$ST" = 201 ] || [ "$ST" = 200 ] || fail "grant dora tag:cubes: $LAST"

  # (a) cannot grant — not itself, not its granter, not anyone.
  grant cat cat tag:cubes;    expect_refused 403 self 'cat grants itself'
  grant cat owner tag:cubes;  expect_refused 403 grant_required 'cat grants its granter'
  grant cat bee tag:cubes;    expect_refused 403 grant_required 'cat grants a peer'
  grant dora dora tag:cubes;  expect_refused 403 self 'dora grants herself'
  grant dora member tag:cubes; expect_refused 403 grant_required 'dora grants a member'
  # (b) cannot change its own tags or policy.
  req cat PUT "$A/${ID[cat]}/tags" '{"tags":["cubes"]}';    expect_refused 403 self 'cat tags itself'
  req cat PUT "$A/${ID[cat]}/messaging" '{"messaging":"none"}'; expect_refused 403 self 'cat sets its own policy'
  # (c) inside T: may change bee's policy and toggle cubes on bee…
  req cat PUT "$A/${ID[bee]}/messaging" '{"messaging":"tags"}'; expect_status 200 'cat sets bee (cubes) policy'
  req dora PUT "$A/${ID[bee]}/messaging" '{"messaging":"any"}'; expect_status 200 'dora sets bee (cubes) policy'
  # …but not outside T.
  req cat PUT "$A/${ID[gnu]}/messaging" '{"messaging":"none"}'; expect_refused 403 grant_required 'cat on untagged gnu policy'
  req dora PUT "$A/${ID[gnu]}/messaging" '{"messaging":"none"}'; expect_refused 403 grant_required 'dora on untagged gnu policy'
  req cat PUT "$A/${ID[bee]}/tags" '{"tags":["cubes","other"]}'; expect_refused 403 grant_required 'cat adds a tag outside T'
  set_tags bee cubes other
  req cat PUT "$A/${ID[bee]}/tags" '{"tags":["cubes"]}'; expect_refused 403 grant_required 'cat removes a tag outside T'
  req cat PUT "$A/${ID[bee]}/tags" '{"tags":["other","cubes"]}'; expect_status 200 'unchanged set needs no extra authority'
  req cat PUT "$A/${ID[bee]}/tags" '{"tags":["other"]}'; expect_status 200 'cat removes cubes (T) from bee'
  req cat PUT "$A/${ID[bee]}/messaging" '{"messaging":"none"}'; expect_refused 403 grant_required 'cat lost bee once cubes is gone'
  # A `tag:<name>` holder manages agents already carrying the tag; it never
  # recruits new ones (that would hand it authority over any agent).
  req cat PUT "$A/${ID[gnu]}/tags" '{"tags":["cubes"]}'; expect_refused 403 grant_required 'cat cannot recruit untagged gnu into T'
  req cat GET "$A/${ID[gnu]}/analytics?window=24h"; expect_refused 403 grant_required 'cat cannot read untagged gnu analytics'
  set_tags gnu cubes
  req cat PUT "$A/${ID[gnu]}/messaging" '{"messaging":"tags"}'; expect_status 200 'cat governs gnu once the owner tags it'
  # Analytics follow the same cover.
  req cat GET "$A/${ID[gnu]}/analytics?window=24h"; expect_status 200 'cat reads gnu (cubes) analytics'
  req cat GET "$A/${ID[hen]}/analytics?window=24h"; expect_refused 403 grant_required 'cat reads untagged hen analytics'

  # (d) revoked → every power gone.
  req owner DELETE "/orgs/$ORG/grants/$gcat"; expect_status 200 'owner revokes cat'
  req cat PUT "$A/${ID[gnu]}/messaging" '{"messaging":"any"}'; expect_refused 403 grant_required 'revoked cat changes policy'
  req cat PUT "$A/${ID[gnu]}/tags" '{"tags":[]}'; expect_refused 403 grant_required 'revoked cat changes tags'
  req cat GET "$A/${ID[gnu]}/analytics?window=24h"; expect_refused 403 grant_required 'revoked cat reads analytics'
  req cat DELETE "/orgs/$ORG/grants/$gcat"; expect_status 404 'revoked grant is gone'
  req owner GET "/orgs/$ORG/grants"
  expect_json "[.items[] | select(.id == \"$gcat\")] | length" '0' 'grant list no longer has it'
  set_policy gnu any; set_tags gnu; set_tags bee
}

case_self_revoke() {
  # Spec §3/§6: "Nobody changes their own … grants"; "Who may delete: org
  # owners/admins, or the grant's creator". The server lets a holder give up its
  # own grant — recorded, not judged (see the open questions in the report).
  grant owner hen tag:qa; [ "$ST" = 201 ] || fail "grant hen tag:qa: $LAST"
  local g; g="$(jq -r '.grant.id' <<<"$BODY")"
  req hen DELETE "/orgs/$ORG/grants/$g"
  observe "holder (agent, not creator) deletes its own grant → $ST $BODY"
  # A non-holder, non-creator, non-admin may never revoke someone else's grant.
  grant owner hen tag:qa; g="$(jq -r '.grant.id' <<<"$BODY")"
  req member DELETE "/orgs/$ORG/grants/$g"; expect_refused 403 grant_required 'plain member revokes hen'
  req gnu DELETE "/orgs/$ORG/grants/$g";    expect_refused 403 grant_required 'grant-less agent revokes hen'
  req owner DELETE "/orgs/$ORG/grants/$g";  expect_status 200 'cleanup'
}

case_chief() {
  grant owner dan 'tags:*'; [ "$ST" = 201 ] || fail "grant dan tags:*: $LAST"
  local gdan; gdan="$(jq -r '.grant.id' <<<"$BODY")"
  grant dan dan tag:x;       expect_refused 403 self 'chief grants itself'
  grant dan eel 'tags:*';    expect_refused 403 grant_required 'chief grants tags:*'
  grant dan eel tag:ops;     expect_status 201 'chief grants tag:ops to eel'
  local geel; geel="$(jq -r '.grant.id' <<<"$BODY")"
  expect_json '.grant.grantedBy' "${ID[dan]}" 'grantedBy is the chief'
  # The tag:ops holder cannot touch the chief (outranked) nor revoke the chief's grant.
  set_tags dan ops
  req eel PUT "$A/${ID[dan]}/messaging" '{"messaging":"none"}'; expect_refused 403 outranked 'tag:ops holder on the chief'
  req eel PUT "$A/${ID[dan]}/tags" '{"tags":[]}';              expect_refused 403 outranked 'tag:ops holder on the chief tags'
  req eel DELETE "/orgs/$ORG/grants/$gdan";                    expect_refused 403 grant_required 'eel revokes the chief grant'
  # The chief acts on the ungranted owner-minted agents and revokes what it created.
  req dan PUT "$A/${ID[hen]}/messaging" '{"messaging":"tags"}'; expect_status 200 'chief sets hen policy'
  req dan DELETE "/orgs/$ORG/grants/$geel"; expect_status 200 'chief revokes the grant it created'
  # A plain member who owns an agent keeps implicit authority over it even when it holds tags:*.
  local mo; mo="$(create_agent "${TOK[member]}" "$ORG" mo)"; ID[mo]="$(jq -r '.agent.id' <<<"$mo")"
  grant owner mo 'tags:*'; expect_status 201 'admin grants the member’s agent tags:*'
  req member PUT "$A/${ID[mo]}/messaging" '{"messaging":"none"}'; expect_status 200 'owner (member) exempt from outranked'
  req dan PUT "$A/${ID[mo]}/messaging" '{"messaging":"any"}'; expect_status 200 'tags:* holder on a tags:* holder (covers it)'
  grant member eel tag:ops; expect_refused 403 grant_required 'agent ownership confers no grant authority'
  req owner DELETE "/orgs/$ORG/grants/$gdan"; expect_status 200 'cleanup chief'
  set_policy hen any; set_tags dan
}

case_no_authority() {
  req member PUT "$A/${ID[ant]}/tags" '{"tags":["cubes"]}';     expect_refused 403 grant_required 'member tags owner’s agent'
  req member PUT "$A/${ID[ant]}/messaging" '{"messaging":"none"}'; expect_refused 403 grant_required 'member sets owner’s agent policy'
  req member GET "$A/${ID[ant]}/analytics?window=7d";           expect_refused 403 grant_required 'member reads owner’s agent analytics'
  req gnu GET "$A/${ID[ant]}/analytics?window=7d";              expect_refused 403 grant_required 'agent reads another agent’s analytics'
  req gnu PUT "$A/${ID[ant]}/messaging" '{"messaging":"none"}';  expect_refused 403 grant_required 'agent sets another agent’s policy'
  grant member member tag:x; expect_refused 403 self 'member grants itself'
  grant member ant tag:x;    expect_refused 403 grant_required 'member grants'
  # Reads the spec opens to every member.
  req member GET "/orgs/$ORG/grants";  expect_status 200 'any member lists grants'
  req gnu GET "/orgs/$ORG/grants";     expect_status 200 'any agent lists grants'
  req member GET "$A/${ID[ant]}";      expect_status 200 'any member reads an agent (tags are org-visible)'
  # Recorded, not judged: the spec lists owner/admins/grant holders as readers.
  req ant GET "$A/${ID[ant]}/analytics?window=24h"; observe "agent reads its OWN analytics → $ST"
}

case_cross_org() {
  local fake='agt_00000000000000000000000000' fakeg='grt_00000000000000000000000000' b_real b_fake
  # Another org's agent under MY org's routes: 404, same body as a fabricated id.
  req owner PUT "$A/${ID[zed]}/tags" '{"tags":["x"]}'; expect_status 404 'org1 owner tags org2 agent'
  b_real="$BODY"
  req owner PUT "$A/$fake/tags" '{"tags":["x"]}'; expect_status 404 'fabricated agent id'
  [ "$b_real" = "$BODY" ] || fail "cross-org agent body differs from fabricated: [$b_real] vs [$BODY]"
  req owner PUT "$A/${ID[zed]}/messaging" '{"messaging":"none"}'; expect_status 404 'org1 owner sets org2 agent policy'
  req owner GET "$A/${ID[zed]}/analytics?window=24h";             expect_status 404 'org1 owner reads org2 agent analytics'
  req owner GET "$A/${ID[zed]}";                                   expect_status 404 'org1 owner reads org2 agent'
  # Another org's grant id.
  req owner DELETE "/orgs/$ORG/grants/$G2"; expect_status 404 'org1 owner deletes org2 grant via org1'
  b_real="$BODY"
  req owner DELETE "/orgs/$ORG/grants/$fakeg"; expect_status 404 'fabricated grant id'
  [ "$b_real" = "$BODY" ] || fail "cross-org grant body differs from fabricated: [$b_real] vs [$BODY]"
  req owner DELETE "/orgs/$ORG2/grants/$G2"; expect_status 404 'non-member deletes org2 grant via org2'
  # Another org's principals as grantees.
  grant owner zed tag:x;  expect_status 404 'grant to org2 agent'
  grant owner yak2 tag:x; expect_status 404 'grant to org2-only human'
  # Another org's routes altogether: org1 human and org1 agent are not members.
  req owner GET "/orgs/$ORG2/grants";                 expect_status 404 'org1 owner lists org2 grants'
  req ant GET "/orgs/$ORG2/grants";                   expect_status 404 'org1 agent lists org2 grants'
  req ant PUT "/orgs/$ORG2/agents/${ID[zed]}/messaging" '{"messaging":"none"}'; expect_status 404 'org1 agent on org2 agent'
  req ant GET "/orgs/$ORG2/agents/${ID[zed]}/analytics"; expect_status 404 'org1 agent reads org2 analytics'
  # And org2's grant holder gets no reach into org1.
  req zed PUT "$A/${ID[ant]}/messaging" '{"messaging":"none"}'; expect_status 404 'org2 agent on org1 agent'
}

case_analytics_refused() {
  local before after room
  set_tags eel
  dm_room eel "${ID[hen]}"; expect_status 201 'eel → hen DM'
  room="$(jq -r '.room.id' <<<"$BODY")"
  send eel "$room" 'counted'; expect_status 201 'one counted send'
  req owner GET "$A/${ID[eel]}/analytics?window=24h"; expect_status 200 'owner reads eel'
  before="$BODY"
  req owner GET "$A/${ID[hen]}/analytics?window=24h"; local hen_before="$BODY"
  set_policy eel none
  send eel "$room" 'refused one'; expect_refused 403 messaging_policy 'refused send'
  send hen "$room" 'refused two'; expect_refused 403 messaging_policy 'refused reply'
  dm_room eel "${ID[gnu]}";       expect_refused 403 messaging_policy 'refused ensure'
  req owner GET "$A/${ID[eel]}/analytics?window=24h"; after="$BODY"
  BODY="$after"; LAST="GET eel analytics after refusals → $after (before: $before)"
  expect_json '.totals' "$(jq -r '.totals' <<<"$before")" 'eel totals unchanged by refusals'
  req owner GET "$A/${ID[hen]}/analytics?window=24h"
  expect_json "[.counterparts[] | select(.id == \"${ID[eel]}\")][0].messages" '1' 'hen↔eel: only the one stored DM (refused reply not counted)'
  expect_json '.totals' "$(jq -r '.totals' <<<"$hen_before")" 'hen totals unchanged by refusals'
  set_policy eel any

  # Agent → human DMs land in withHumans with the human as counterpart.
  dm_room eel "${ID[owner]}"; [ "$ST" = 201 ] || [ "$ST" = 200 ] || fail "eel → owner: $LAST"
  room="$(jq -r '.room.id' <<<"$BODY")"
  send eel "$room" 'abcdefgh'; expect_status 201 'eel → owner'
  send owner "$room" 'abcd';   expect_status 201 'owner → eel'
  req owner GET "$A/${ID[eel]}/analytics?window=all"; expect_status 200 'window all'
  expect_json '.withHumans.messages' '2' 'withHumans counts both directions'
  expect_json '.withHumans.tokens' '3' 'tokens = ceil(8/4)+ceil(4/4)'
  expect_json "[.counterparts[] | select(.kind == \"human\" and .id == \"${ID[owner]}\")][0].messages" '2' 'owner is a human counterpart'
  req owner GET "$A/${ID[eel]}/analytics?window=1y"; expect_status 400 'unknown window'
}

case_cascade() {
  local g gd room
  # An agent holding a grant, tags, and counters as someone's counterpart.
  local r; r="$(create_agent "${TOK[owner]}" "$ORG" imp)"; ID[imp]="$(jq -r '.agent.id' <<<"$r")"; TOK[imp]="$(jq -r '.key' <<<"$r")"
  ac_tok "${TOK[owner]}" room add "${ID[imp]}" --room "$CREW" >/dev/null
  set_tags imp cubes
  grant owner imp 'tags:*'; expect_status 201 'grant imp tags:*'; g="$(jq -r '.grant.id' <<<"$BODY")"
  grant imp gnu tag:cubes; expect_status 201 'imp grants gnu tag:cubes'; gd="$(jq -r '.grant.id' <<<"$BODY")"
  dm_room imp "${ID[hen]}"; room="$(jq -r '.room.id' <<<"$BODY")"
  send imp "$room" 'before delete'; expect_status 201 'imp → hen'
  req owner DELETE "/me/agents/${ID[imp]}"; expect_status 200 'owner deletes imp'
  req owner GET "/orgs/$ORG/grants"
  expect_json "[.items[] | select(.id == \"$g\")] | length" '0' 'the grant imp HELD is gone'
  observe "grant CREATED by the deleted agent (gnu tag:cubes) → $(jq -c "[.items[] | select(.id == \"$gd\")] | length" <<<"$BODY") remaining"
  req owner GET "$A/${ID[imp]}"; expect_status 404 'deleted agent is 404'
  req owner GET "$A/${ID[imp]}/analytics?window=24h"; expect_status 404 'deleted agent analytics 404'
  req owner GET "$A/${ID[hen]}/analytics?window=24h"
  observe "hen's analytics after its counterpart imp was deleted: counterparts=$(jq -c "[.counterparts[] | select(.id == \"${ID[imp]}\")]" <<<"$BODY")"
  [ -n "$gd" ] && req owner DELETE "/orgs/$ORG/grants/$gd"

  # A human holding a grant is removed from the org → the grant goes.
  local ivy; ivy="$(add_human_to_org "${TOK[owner]}" "$ORG" ivy@ex.com password123 Ivy)"
  TOK[ivy]="$ivy"; ID[ivy]="$(api "$ivy" GET /me | jq -r '.principal.id')"
  grant owner ivy tag:cubes; expect_status 201 'grant ivy'; g="$(jq -r '.grant.id' <<<"$BODY")"
  req owner DELETE "/orgs/$ORG/humans/${ID[ivy]}"; expect_status 200 'owner removes ivy'
  req owner GET "/orgs/$ORG/grants"
  expect_json "[.items[] | select(.id == \"$g\" or .principalId == \"${ID[ivy]}\")] | length" '0' 'removed human’s grants are gone'
  req ivy PUT "$A/${ID[bee]}/messaging" '{"messaging":"none"}'; expect_status 404 'removed human is a non-member (404)'
}

echo "Cases:"
run_case defaults            case_defaults
run_case validation          case_validation
run_case open-dm-policy      case_open_dm_policy
run_case tag-removed-midway  case_tag_removed_midway
run_case agent-to-human      case_agent_to_human
run_case delegate            case_delegate
run_case self-revoke         case_self_revoke
run_case chief               case_chief
run_case no-authority        case_no_authority
run_case cross-org           case_cross_org
run_case analytics-refused   case_analytics_refused
run_case cascade             case_cascade

if [ ${#OBSERVED_ALL[@]} -gt 0 ]; then
  echo "Observed (spec silent — informational):"
  printf '  %s\n' "${OBSERVED_ALL[@]}"
fi

if [ ${#FAILURES[@]} -gt 0 ]; then
  printf '%s\n' "${FAILURES[@]}" >&2
  fail "${#FAILURES[@]} of ${#CASES[@]} cases failed"
fi
pass "${#CASES[@]} visibility edge cases"
