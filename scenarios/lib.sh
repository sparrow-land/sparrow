# shellcheck shell=bash
# scenarios/lib.sh — shared helpers for the sparrow v3 e2e scenario suite.
#
# Sourced by every scenarios/NNN-name/run.sh. Provides:
#   scenario_prepare        pre-flight checks, create $SPARROW_TMPROOT, register
#                           EXIT cleanup, and ensure the docker image exists.
#                           Idempotent; called by scenario_start.
#   scenario_start          scenario_prepare + run a fresh container on a random
#                           free 127.0.0.1 port, wait for /healthz, set $SERVER.
#   scenario_requires       declare host-tool requirements (or set
#                           SCENARIO_REQUIRES=(compose swaks) first); a missing
#                           tool prints SKIP and exits 0 — never FAIL.
#   scenario_compose_start  the sidecar variant: everything scenario_prepare does,
#                           then `docker compose -p sparrow-scn-$$ up -d` on the
#                           scenario's own compose.yml. Exports $SERVER and
#                           $ADMIN_TOKEN IDENTICALLY to scenario_start, so every
#                           wrapper below works unchanged.
#
#   CLI wrappers (built CLI at apps/cli/dist/bin.js, isolated XDG_CONFIG_HOME):
#     ac_tok <token> <args...>   run the CLI as a bearer credential (ses_ or
#                                agk_) via SPARROW_TOKEN — the workhorse; no login
#                                needed. Shares one throwaway config dir since
#                                the token, not the store, carries auth.
#     ac_as <profile> <args...>  run the CLI with a per-profile config dir (for
#                                `login` / `enroll` flows that persist a profile).
#     ac <args...>               ac_as default.
#
#   HTTP helpers (raw API, base $SERVER/api/v1):
#     signup <email> <pw> <name>       POST /auth/signup → echoes the ses_ token
#                                      (FIRST signup on an instance bootstraps an
#                                      org and makes that human its owner).
#     api <token> <method> <path> [body]     authed curl, -f (fails on 4xx/5xx)
#     api_raw <token> <method> <path> [body] authed curl, body even on error
#     http_status <token> <method> <path> [body]  → numeric HTTP status only
#     admin_api <method> <path> [body]       curl with X-Admin-Token
#     first_org_id <token>                   → the caller's first org id
#     invite_token_of <url>                  → the ivk_ token from an invite URL
#
#   Assertions / reporting:
#     assert_eq / assert_contains / assert_json / pass / fail
#
# Env overrides:
#   SPARROW_SCENARIO_IMAGE   image tag (default sparrow:scenarios). run-all.sh exports
#                         it after building once so scenarios share one build.
#   SCENARIO_NAME         label in PASS/FAIL output (each run.sh sets it).
#   SCENARIO_DATA_DIR     optional host dir mounted at /data (pre-seed the db).
#   SCENARIO_EXTRA_ENV    optional bash array of extra KEY=VALUE container env
#                         (set before scenario_start; e.g. OPEN_ORG_CREATION=false).
#   SCENARIO_REQUIRES     optional bash array of host tools the scenario needs
#                         (e.g. (compose swaks)); a missing one → SKIP, exit 0.
#   SCENARIO_COMPOSE_PORTS  optional bash array of VARIABLE NAMES that
#                         scenario_compose_start fills with free host ports and
#                         exports into the compose environment (e.g. (SMTP_PORT)).
#   SCENARIO_COMPOSE_READY  optional bash array of `PORT_VAR:/path` readiness
#                         probes polled after `up -d`, alongside core's /healthz.

# Resolve repo root from this file's location (scenarios/ -> repo root).
SPARROW_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPARROW_REPO_ROOT="$(cd "$SPARROW_LIB_DIR/.." && pwd)"
SPARROW_CLI_BIN="$SPARROW_REPO_ROOT/apps/cli/dist/bin.js"
SPARROW_IMAGE="${SPARROW_SCENARIO_IMAGE:-sparrow:scenarios}"
ADMIN_TOKEN_VALUE="scenario-admin"
SCENARIO_NAME="${SCENARIO_NAME:-scenario}"

# Colors (only when stdout is a terminal).
if [ -t 1 ]; then
  SPARROW_RED=$'\033[31m'; SPARROW_GREEN=$'\033[32m'; SPARROW_YELLOW=$'\033[33m'
  SPARROW_RESET=$'\033[0m'
else
  SPARROW_RED=''; SPARROW_GREEN=''; SPARROW_YELLOW=''; SPARROW_RESET=''
fi

# --- reporting -------------------------------------------------------------

fail() {
  printf '%s\n' "${SPARROW_RED}FAIL ${SCENARIO_NAME}${SPARROW_RESET}: $*" >&2
  exit 1
}

pass() {
  if [ $# -gt 0 ]; then
    printf '%s\n' "${SPARROW_GREEN}PASS ${SCENARIO_NAME}${SPARROW_RESET}: $*"
  else
    printf '%s\n' "${SPARROW_GREEN}PASS ${SCENARIO_NAME}${SPARROW_RESET}"
  fi
  exit 0
}

# skip <why> — the scenario cannot run on this host (a missing host tool, never a
# product problem). Exit 0: a machine without the SMTP toolchain must not turn
# the suite red — run-all.sh reads this line and reports SKIP in its summary.
skip() {
  printf '%s\n' "${SPARROW_YELLOW}SKIP ${SCENARIO_NAME}${SPARROW_RESET}: $*"
  exit 0
}

# --- assertions ------------------------------------------------------------

assert_eq() { # <expected> <actual> [message]
  if [ "$1" != "$2" ]; then
    fail "${3:-assert_eq}: expected [$1] got [$2]"
  fi
}

assert_contains() { # <haystack> <needle> [message]
  case "$1" in
    *"$2"*) : ;;
    *) fail "${3:-assert_contains}: [$1] does not contain [$2]" ;;
  esac
}

assert_not_contains() { # <haystack> <needle> [message]
  case "$1" in
    *"$2"*) fail "${3:-assert_not_contains}: [$1] unexpectedly contains [$2]" ;;
    *) : ;;
  esac
}

# assert_json <json> <jq-filter> <expected> [message]
assert_json() {
  local got
  if ! got="$(printf '%s' "$1" | jq -r "$2" 2>/dev/null)"; then
    fail "${4:-assert_json}: jq filter [$2] failed to evaluate"
  fi
  if [ "$got" != "$3" ]; then
    fail "${4:-assert_json}: filter [$2] expected [$3] got [$got] (json: $1)"
  fi
}

# --- image / container lifecycle ------------------------------------------

_ac_free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})'
}

# Build the scenario image from the repo-root Dockerfile (which owns apps/api's
# build context).
_ac_build_image() {
  echo "[lib] building image $SPARROW_IMAGE ..." >&2
  docker build -t "$SPARROW_IMAGE" "$SPARROW_REPO_ROOT" >&2 || fail "docker build failed"
}

_ac_ensure_image() {
  if docker image inspect "$SPARROW_IMAGE" >/dev/null 2>&1; then
    return 0
  fi
  _ac_build_image
}

# Cleanup handler registered by scenario_prepare. Removes the container (or the
# compose project) and any tmp dirs created for the run.
_ac_cleanup() {
  local code=$?
  if [ -n "${SPARROW_CID:-}" ]; then
    docker rm -fv "$SPARROW_CID" >/dev/null 2>&1 || true
  fi
  # A compose scenario takes its whole project down, volumes included, BEFORE the
  # tmp root is wiped (the project may bind-mount fixtures from it).
  if [ -n "${SPARROW_COMPOSE_PROJECT:-}" ] && [ -n "${SPARROW_COMPOSE_FILE:-}" ]; then
    docker compose -p "$SPARROW_COMPOSE_PROJECT" -f "$SPARROW_COMPOSE_FILE" \
      down -v --remove-orphans --timeout 5 >/dev/null 2>&1 || true
  fi
  # Files under a mounted SCENARIO_DATA_DIR may be root-owned (written by the
  # container); wipe them from inside a container before rm -rf'ing the tmp root.
  if [ -n "${SCENARIO_DATA_DIR:-}" ] && [ -d "${SCENARIO_DATA_DIR:-}" ]; then
    docker run --rm -v "$SCENARIO_DATA_DIR:/wipe" "$SPARROW_IMAGE" \
      node -e 'const fs=require("fs");for(const f of fs.readdirSync("/wipe"))fs.rmSync("/wipe/"+f,{recursive:true,force:true})' \
      >/dev/null 2>&1 || true
  fi
  if [ -n "${SPARROW_TMPROOT:-}" ]; then
    rm -rf "$SPARROW_TMPROOT" 2>/dev/null || true
  fi
  return $code
}

# scenario_requires [tool...] — assert the host tools this scenario needs, from
# the arguments or from the SCENARIO_REQUIRES array. `compose` is special-cased
# (it is a docker plugin, not a binary on PATH). A missing tool SKIPs — the gap
# is reported, never failed, so the suite stays green on a machine that lacks the
# SMTP toolchain.
scenario_requires() {
  local -a tools=("$@")
  if [ ${#tools[@]} -eq 0 ]; then
    tools=(${SCENARIO_REQUIRES[@]+"${SCENARIO_REQUIRES[@]}"})
  fi
  local t
  for t in ${tools[@]+"${tools[@]}"}; do
    case "$t" in
      compose)
        docker compose version >/dev/null 2>&1 \
          || skip "docker compose is not available on this host"
        ;;
      *)
        command -v "$t" >/dev/null 2>&1 || skip "$t not found on PATH"
        ;;
    esac
  done
}

# scenario_prepare — pre-flight checks, tmp root + cleanup trap, docker image.
scenario_prepare() {
  [ -n "${SPARROW_TMPROOT:-}" ] && return 0

  command -v docker >/dev/null 2>&1 || fail "docker not found on PATH"
  command -v jq >/dev/null 2>&1 || fail "jq not found on PATH"
  command -v curl >/dev/null 2>&1 || fail "curl not found on PATH"
  [ -f "$SPARROW_CLI_BIN" ] || fail "CLI not built: $SPARROW_CLI_BIN (run pnpm build)"

  SPARROW_TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/sparrow-scenario.XXXXXX")"
  trap _ac_cleanup EXIT

  _ac_ensure_image
}

# scenario_start — prepare, run a container, wait for health, set $SERVER.
scenario_start() {
  scenario_prepare

  local -a mount_args=()
  if [ -n "${SCENARIO_DATA_DIR:-}" ]; then
    mount_args=(-v "$SCENARIO_DATA_DIR:/data")
  fi

  local -a extra_env_args=()
  local kv
  for kv in ${SCENARIO_EXTRA_ENV[@]+"${SCENARIO_EXTRA_ENV[@]}"}; do
    extra_env_args+=(-e "$kv")
  done

  local port cid attempt
  for attempt in 1 2 3 4 5; do
    port="$(_ac_free_port)"
    [ -n "$port" ] || continue
    if cid="$(docker run -d \
        -p "127.0.0.1:${port}:8722" \
        -e ADMIN_TOKEN="$ADMIN_TOKEN_VALUE" \
        -e BASE_URL="http://127.0.0.1:${port}" \
        -e PRESENCE_GRACE_SECONDS="${PRESENCE_GRACE_SECONDS:-30}" \
        ${mount_args[@]+"${mount_args[@]}"} \
        ${extra_env_args[@]+"${extra_env_args[@]}"} \
        "$SPARROW_IMAGE" 2>/dev/null)"; then
      sleep 0.3
      if [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" = "true" ]; then
        SPARROW_CID="$cid"
        SPARROW_PORT="$port"
        break
      fi
      docker rm -fv "$cid" >/dev/null 2>&1 || true
      cid=""
    fi
  done
  [ -n "${SPARROW_CID:-}" ] || fail "could not start container on a free port after 5 attempts"

  SERVER="http://127.0.0.1:${SPARROW_PORT}"
  ADMIN_TOKEN="$ADMIN_TOKEN_VALUE"
  export SERVER ADMIN_TOKEN SPARROW_SERVER="$SERVER"

  local i
  for i in $(seq 1 30); do
    if curl -fsS "$SERVER/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "--- container logs ---" >&2
  docker logs "$SPARROW_CID" >&2 2>&1 || true
  fail "server did not become healthy within 30s at $SERVER"
}

# --- compose-based scenarios ----------------------------------------------
# Most scenarios stay single-container; `scenario_start` above is unchanged and
# remains the default. A scenario that needs SIDECARS (today only
# 150-email-smtp) ships its own `compose.yml` next to `run.sh` and calls
# `scenario_compose_start "$(dirname "$0")"`.

# _ac_compose — `docker compose` for THIS run's project.
_ac_compose() {
  docker compose -p "$SPARROW_COMPOSE_PROJECT" -f "$SPARROW_COMPOSE_FILE" "$@"
}

# _ac_wait_http <url> <tries> — poll a URL until it answers 2xx.
_ac_wait_http() {
  local url="$1" tries="${2:-60}" i
  for ((i = 0; i < tries; i++)); do
    curl -fsS -o /dev/null "$url" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# scenario_compose_start <dir> — everything scenario_prepare does (pre-flight,
# tmp root, EXIT trap, ONE shared image), then brings up <dir>/compose.yml under
# a PER-RUN project name so concurrent or repeated runs never collide.
#
#   * host ports come from the same `_ac_free_port` helper single-container
#     scenarios use: SPARROW_PORT for core, plus every name in
#     SCENARIO_COMPOSE_PORTS (exported, so compose interpolates them);
#   * the compose file pins `image: ${SPARROW_SCENARIO_IMAGE}` for the core
#     service, so run-all.sh's one build is reused and sidecars pin upstream tags;
#   * readiness: core's /healthz plus each `PORT_VAR:/path` in
#     SCENARIO_COMPOSE_READY;
#   * $SERVER / $ADMIN_TOKEN / $SPARROW_SERVER are exported IDENTICALLY to
#     scenario_start, so ac_tok, api, signup, sse_me_watch … work unchanged;
#   * the EXIT trap gains `docker compose … down -v` ahead of the tmp-root wipe.
scenario_compose_start() {
  local dir
  dir="$(cd "$1" && pwd)"
  [ -f "$dir/compose.yml" ] || fail "scenario_compose_start: no compose.yml in $dir"

  scenario_requires compose
  scenario_prepare

  # The core service pins this tag; run-all.sh built it once already.
  export SPARROW_SCENARIO_IMAGE="$SPARROW_IMAGE"
  export ADMIN_TOKEN="$ADMIN_TOKEN_VALUE"
  export SPARROW_TMPROOT

  # File before project: the EXIT trap keys off the project name, and must never
  # see one without the file it belongs to.
  SPARROW_COMPOSE_FILE="$dir/compose.yml"
  SPARROW_COMPOSE_PROJECT="sparrow-scn-$$"

  local attempt name
  for attempt in 1 2 3; do
    # Fresh ports on every attempt: a port that was free a moment ago may not be.
    SPARROW_PORT="$(_ac_free_port)"
    export SPARROW_PORT
    for name in ${SCENARIO_COMPOSE_PORTS[@]+"${SCENARIO_COMPOSE_PORTS[@]}"}; do
      printf -v "$name" '%s' "$(_ac_free_port)"
      export "${name?}"
    done

    # `--build` so a sidecar built from this tree is never stale; layer caching
    # makes that a few seconds when nothing changed. Core is `image:`-pinned and
    # is never built here.
    if _ac_compose up -d --build --remove-orphans >/dev/null 2>&1; then
      SERVER="http://127.0.0.1:${SPARROW_PORT}"
      export SERVER SPARROW_SERVER="$SERVER"

      local ok=1
      _ac_wait_http "$SERVER/healthz" 60 || ok=0
      if [ "$ok" = 1 ]; then
        local probe var path
        for probe in ${SCENARIO_COMPOSE_READY[@]+"${SCENARIO_COMPOSE_READY[@]}"}; do
          var="${probe%%:*}"; path="${probe#*:}"
          _ac_wait_http "http://127.0.0.1:${!var}${path}" 60 || { ok=0; break; }
        done
      fi
      [ "$ok" = 1 ] && return 0

      echo "--- compose logs (attempt $attempt) ---" >&2
      _ac_compose logs --tail 60 >&2 2>&1 || true
      _ac_compose down -v --remove-orphans --timeout 5 >/dev/null 2>&1 || true
      fail "compose stack did not become ready at $SERVER"
    fi
    _ac_compose down -v --remove-orphans --timeout 5 >/dev/null 2>&1 || true
  done
  fail "could not bring the compose stack up on free ports after 3 attempts"
}

# --- CLI wrappers ----------------------------------------------------------

# ac_tok <token> <args...> — run the built CLI authenticated by a bearer token
# (ses_ session or agk_ agent key) via SPARROW_TOKEN. This is the primary wrapper:
# no `login`/profile needed. SPARROW_SERVER points at the running container.
ac_tok() {
  local token="$1"; shift
  XDG_CONFIG_HOME="$SPARROW_TMPROOT/cfg-tok" SPARROW_SERVER="$SERVER" SPARROW_TOKEN="$token" \
    node "$SPARROW_CLI_BIN" "$@"
}

# ac_as <profile> <args...> — run the CLI with a per-profile isolated config dir
# (no SPARROW_TOKEN), for exercising `login` / `login-agent` / `enroll` persistence.
ac_as() {
  local profile="$1"; shift
  XDG_CONFIG_HOME="$SPARROW_TMPROOT/cfg-$profile" SPARROW_SERVER="$SERVER" \
    node "$SPARROW_CLI_BIN" "$@"
}

# ac <args...> — default-profile convenience wrapper.
ac() {
  ac_as default "$@"
}

# --- HTTP helpers ----------------------------------------------------------

# signup <email> <password> <displayName> — POST /auth/signup, echo the ses_
# token. The FIRST signup on a fresh instance auto-creates an org (owner role).
signup() {
  local email="$1" pw="$2" name="$3" resp
  resp="$(curl -fsS -X POST "$SERVER/api/v1/auth/signup" \
    -H 'content-type: application/json' \
    -d "$(jq -cn --arg e "$email" --arg p "$pw" --arg n "$name" \
          '{email:$e,password:$p,displayName:$n}')")" \
    || { echo "signup: POST /auth/signup failed for $email" >&2; return 1; }
  printf '%s' "$resp" | jq -r '.token'
}

# api <token> <method> <path> [json-body] — authed curl against $SERVER/api/v1.
# Uses -f: non-2xx makes curl exit non-zero (use api_raw / http_status for those).
api() {
  local tok="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$SERVER/api/v1$path" \
      -H "authorization: Bearer $tok" -H 'content-type: application/json' -d "$body"
  else
    curl -fsS -X "$method" "$SERVER/api/v1$path" -H "authorization: Bearer $tok"
  fi
}

# api_raw <token> <method> <path> [json-body] — like api but returns the body on
# any status (no -f), so error envelopes can be inspected.
api_raw() {
  local tok="$1" method="$2" path="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$SERVER/api/v1$path" \
      -H "authorization: Bearer $tok" -H 'content-type: application/json' -d "$body"
  else
    curl -sS -X "$method" "$SERVER/api/v1$path" -H "authorization: Bearer $tok"
  fi
}

# http_status <token> <method> <path> [json-body] — echo just the numeric status.
# An empty token means "no Authorization header".
http_status() {
  local tok="$1" method="$2" path="$3" body="${4:-}"
  local -a args=(-s -o /dev/null -w '%{http_code}' -X "$method" "$SERVER/api/v1$path")
  [ -n "$tok" ] && args+=(-H "authorization: Bearer $tok")
  if [ -n "$body" ]; then
    args+=(-H 'content-type: application/json' -d "$body")
  fi
  curl "${args[@]}"
}

# admin_api <method> <path> [json-body] — curl with the instance X-Admin-Token.
admin_api() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$SERVER/api/v1$path" \
      -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' -d "$body"
  else
    curl -fsS -X "$method" "$SERVER/api/v1$path" -H "x-admin-token: $ADMIN_TOKEN"
  fi
}

# first_org_id <token> — the caller's first org id (GET /me/orgs).
first_org_id() {
  api "$1" GET /me/orgs | jq -r '.items[0].org.id'
}

# invite_token_of <invite-url> — extract the ivk_ token from a …/invite/<token> URL.
invite_token_of() {
  printf '%s' "${1##*/invite/}"
}

# create_agent <ownerToken> <orgId> <name> — POST /me/agents, echo the full
# CreateAgentResponse JSON `{ agent:{id,name,orgId,...}, key:"agk_..." }`. The
# key is delivered exactly once (here); NOTE: a directly-minted agent has NO
# auto-DM (that is an enrollment-only convenience) — `dm` to ensure one.
create_agent() {
  api "$1" POST /me/agents "$(jq -cn --arg o "$2" --arg n "$3" '{orgId:$o,name:$n}')"
}

# enroll_existing_human <approverToken> <orgId> <humanToken> — invite an EXISTING
# human (by their session token) into the org and approve them (default approval
# policy). Idempotent-ish: an already-member enroll (200, no enrollment) is a
# no-op. Leaves the human a `member` of the org.
enroll_existing_human() {
  local at="$1" org="$2" ht="$3" url token eresp eid
  url="$(api "$at" POST "/orgs/$org/invites" '{}' | jq -r '.url')"
  token="$(invite_token_of "$url")"
  eresp="$(api "$ht" POST "/invite/$token/enroll" '{}')"
  eid="$(jq -r '.enrollment.id // empty' <<<"$eresp")"
  if [ -n "$eid" ]; then
    api "$at" POST "/orgs/$org/enrollments/$eid/approve" '{}' >/dev/null
  fi
}

# add_human_to_org <approverToken> <orgId> <email> <pw> <name> — sign up a NEW
# human and enroll+approve them into the org. Echoes the new human's ses_ token.
add_human_to_org() {
  local htok
  htok="$(signup "$3" "$4" "$5")" || return 1
  enroll_existing_human "$1" "$2" "$htok" >/dev/null || return 1
  printf '%s' "$htok"
}

# --- SSE watchers (background) ---------------------------------------------
# vm8's awk is mawk (block-buffers pipes); these write raw JSON lines to a file
# and callers poll with grep -F, never awk.

# sse_room_watch <token> <roomId> <outfile> — tail a room's SSE stream in the
# background (node directly so $! is the node pid). Echoes the pid.
sse_room_watch() {
  XDG_CONFIG_HOME="$SPARROW_TMPROOT/cfg-tok" SPARROW_SERVER="$SERVER" SPARROW_TOKEN="$1" \
    node "$SPARROW_CLI_BIN" watch --room "$2" --json >"$3" 2>/dev/null &
  echo $!
}

# sse_me_watch <token> <outfile> — tail the /me/events fan-in stream. Echoes pid.
sse_me_watch() {
  XDG_CONFIG_HOME="$SPARROW_TMPROOT/cfg-tok" SPARROW_SERVER="$SERVER" SPARROW_TOKEN="$1" \
    node "$SPARROW_CLI_BIN" watch --json >"$2" 2>/dev/null &
  echo $!
}

# wait_for_line <file> <fixed-needle> [tries] — poll a file until it contains the
# needle (grep -F, line-buffer-safe). Returns 0 on match, 1 on timeout.
wait_for_line() {
  local f="$1" needle="$2" tries="${3:-40}" i
  for ((i = 0; i < tries; i++)); do
    grep -qF "$needle" "$f" 2>/dev/null && return 0
    sleep 0.25
  done
  return 1
}
