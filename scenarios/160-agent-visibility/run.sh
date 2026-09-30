#!/usr/bin/env bash
# 160-agent-visibility — tags, the per-agent messaging policy, always-on counters
# and delegated grants, driven through the real CLI:
#   * an owner tags two of three agents `cubes`; `sparrow tags` shows them;
#   * `messaging ant tags`: ant↔bee (shared tag) DMs work, ant↔cat is refused
#     both ways with the messaging_policy message naming ant's setting;
#   * `sparrow stats ant --window 24h -j` counts the DMs and the room post and
#     names bee as the top counterpart;
#   * a `tag:cubes` grant lets cat change bee's messaging, never its own (self),
#     and never an agent holding `tags:*` (outranked);
#   * cat reads ant's tags through the single-agent route (GET /orgs/:org/agents/:id).
set -euo pipefail
SCENARIO_NAME="160-agent-visibility"
. "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"

scenario_start

owner="$(signup owner@ex.com password123 Owner)"
org="$(first_org_id "$owner")"
mk() { create_agent "$owner" "$org" "$1"; }
a="$(mk ant)"; aid="$(jq -r '.agent.id' <<<"$a")"; akey="$(jq -r '.key' <<<"$a")"
b="$(mk bee)"; bid="$(jq -r '.agent.id' <<<"$b")"; bkey="$(jq -r '.key' <<<"$b")"
c="$(mk cat)"; cid="$(jq -r '.agent.id' <<<"$c")"; ckey="$(jq -r '.key' <<<"$c")"

# The three have met: one shared project room.
room="$(ac_tok "$owner" room create build-crew --json | jq -r '.id')"
for id in "$aid" "$bid" "$cid"; do ac_tok "$owner" room add "$id" --room "$room" >/dev/null; done

# run_fail <token> <args…> — run the CLI expecting a non-zero exit; echo stderr+stdout.
run_fail() {
  local out
  if out="$(ac_tok "$@" 2>&1)"; then fail "expected failure: sparrow ${*:2} (got: $out)"; fi
  printf '%s' "$out"
}

# --- tags -------------------------------------------------------------------
assert_json "$(ac_tok "$owner" tags add ant cubes --json)" '.agent.tags | join(",")' 'cubes' 'owner tags ant'
assert_json "$(ac_tok "$owner" tags add "$bid" cubes --json)" '.agent.tags | join(",")' 'cubes' 'owner tags bee (by id)'
assert_json "$(ac_tok "$owner" tags ant --json)" '.tags | join(",")' 'cubes' 'tags shows ant'
assert_contains "$(ac_tok "$owner" tags bee)" "bee ($bid)" 'human output names the agent with its id'
assert_json "$(ac_tok "$akey" tags --json)" '.tags | join(",")' 'cubes' 'an agent reads its own tags'
assert_json "$(ac_tok "$owner" tags cat --json)" '.tags | length' '0' 'cat is untagged'

# --- messaging ----------------------------------------------------------------
assert_json "$(ac_tok "$owner" messaging ant tags --json)" '.agent.messaging' 'tags' 'owner sets ant to tags'
assert_contains "$(ac_tok "$owner" messaging ant)" 'messaging: tags' 'messaging shows the policy'

# ant → bee: they share `cubes`.
ab="$(ac_tok "$akey" dm "$bid" "hello bee" --json)" || fail "ant → bee DM refused"
abroom="$(jq -r '.dm.room.id' <<<"$ab")"
# ant → cat and cat → ant: refused by ant's setting, both directions.
out="$(run_fail "$akey" dm "$cid" "hello cat")"
assert_contains "$out" 'ant’s messaging setting is `tags`' 'ant → cat names ant’s setting'
out="$(run_fail "$ckey" dm "$aid" "hello ant")"
assert_contains "$out" 'ant’s messaging setting is `tags`' 'cat → ant names ant’s setting'
assert_not_contains "$out" 'Hint:' 'messaging_policy prints the server message only'

# --- counters -----------------------------------------------------------------
ac_tok "$akey" send "two" --room "$abroom" --json >/dev/null
ac_tok "$akey" send "three" --room "$abroom" --json >/dev/null
ac_tok "$bkey" send "reply one" --room "$abroom" --json >/dev/null
ac_tok "$bkey" send "reply two" --room "$abroom" --json >/dev/null
ac_tok "$akey" send "to the room" --room "$room" --json >/dev/null

st="$(ac_tok "$owner" stats ant --window 24h -j)"
assert_json "$st" '.window' '24h' 'stats window'
assert_json "$st" '.totals.sent' '4' 'ant sent 3 DMs + 1 room post'
assert_json "$st" '.totals.received' '2' 'ant received 2 DMs from bee'
assert_json "$st" '.inDms.messages' '5' 'five DM messages'
assert_json "$st" '.inRooms.messages' '1' 'one room message'
assert_json "$st" '.counterparts[0].id' "$bid" 'bee is the top counterpart'
assert_json "$st" '.counterparts[0].messages' '5' 'all five DMs were with bee'
assert_json "$st" '.rooms[0].roomId' "$room" 'the room shows up'
assert_json "$st" '(.totals.tokensSent > 0)' 'true' 'tokens estimated'
human="$(ac_tok "$owner" stats ant --window 24h)"
assert_contains "$human" 'Tokens are estimated from message text' 'human stats carry the estimate note'
assert_contains "$human" "$bid" 'human stats list bee with its id'

# --- grants -------------------------------------------------------------------
g="$(ac_tok "$owner" grants add cat tag:cubes --json)"
assert_json "$g" '.grant.principalId' "$cid" 'grant goes to cat'
assert_json "$g" '.grant.scope' 'tag:cubes' 'grant scope'
assert_contains "$(ac_tok "$owner" grants)" "$(jq -r '.grant.id' <<<"$g")" 'grants lists the new grant'

# cat (tag:cubes) may change bee (carries cubes)…
assert_json "$(ac_tok "$ckey" messaging bee none --json)" '.agent.messaging' 'none' 'cat changes bee’s messaging'
# …never itself…
out="$(run_fail "$ckey" tags add cat cubes)"
assert_contains "$out" "you can't change your own settings" 'self refusal hint'
out="$(run_fail "$ckey" messaging cat any --json)"
assert_json "$out" '.error.reason' 'self' 'self refusal reason in -j'
# …and never an agent holding a grant it lacks.
ac_tok "$owner" grants add ant 'tags:*' --json >/dev/null
out="$(run_fail "$ckey" messaging ant any)"
assert_contains "$out" "that agent holds permissions you don't" 'outranked refusal hint'
out="$(run_fail "$ckey" tags rm ant cubes --json)"
assert_json "$out" '.error.reason' 'outranked' 'outranked on tags too'

# --- the single-agent read ----------------------------------------------------
ct="$(ac_tok "$ckey" tags ant --json)"
assert_json "$ct" '.agentId' "$aid" 'cat resolves ant by name'
assert_json "$ct" '.tags | join(",")' 'cubes' 'cat reads ant’s tags'
assert_json "$ct" '.messaging' 'tags' 'cat reads ant’s messaging'

pass "tags, messaging policy both ways, counters, grants (self/outranked), single-agent read"
