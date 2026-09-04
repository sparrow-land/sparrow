# scenarios — e2e regression suite

Self-contained end-to-end tests. Each scenario builds nothing but reuses one
shared Docker image, starts its **own** container on a random `127.0.0.1` port
with a fresh `DATA_DIR`, drives the built `ac` CLI (plus occasional `curl`), and
prints `PASS`/`FAIL`. Requires `docker`, `jq`, and a built CLI (`pnpm build`).

## Run

    scenarios/run-all.sh                  # build image once, run all, summary table
    scenarios/010-bootstrap-org/run.sh    # run one (builds image if missing)

`run-all.sh` exits non-zero if any scenario fails. Override the image with
`SPARROW_SCENARIO_IMAGE=<tag>`.

The suite mirrors the SPEC "Scenarios" list. 010–120 cover bootstrap/invite/
enroll, messaging (send/pop/read/broadcast/attachments/conversation), the invite
onboarding doc, working status & presence, the human CLI, rooms & members,
suggested replies, agent sharing, org boundaries, direct conversations, the
sidebar sources (#borg) regression, voice, and delivery receipts. 125 and 155
cover v4's unified attention layer: the medium-spanning work queue
(`POST /me/inbox/pop` → `{ item: WorkItem | null }`) and the activity timeline —
both now interleave chat with email.

130–150 are the email medium. 130/135/140/145/148 run the `EMAIL_PROVIDER=fake`
stack, driving inbound through `POST /admin/email/inject` (the injector picks the
`verification` verdicts, so spoof / spam / virus are testable offline) and reading
outbound off `GET /admin/email/outbox`. **150-email-smtp** is the only scenario
that is not one container: see below.

## Compose scenarios (`scenario_compose_start`)

A scenario that needs sidecars ships a `compose.yml` next to its `run.sh` and
calls `scenario_compose_start "$(dirname "$0")"` instead of `scenario_start`. It
does everything `scenario_prepare` does and then brings the stack up under a
**per-run project name** (`docker compose -p sparrow-scn-$$ up -d --build`), so
concurrent or repeated runs never collide:

- host ports come from the same `_ac_free_port` helper — `SPARROW_PORT` for core,
  plus every variable named in `SCENARIO_COMPOSE_PORTS`, exported so compose
  interpolates them;
- the compose file pins `image: ${SPARROW_SCENARIO_IMAGE}` for core, so
  `run-all.sh`'s single build is reused, and pins upstream tags for sidecars;
- readiness is core's `/healthz` plus each `PORT_VAR:/path` in
  `SCENARIO_COMPOSE_READY`;
- `$SERVER` / `$ADMIN_TOKEN` / `$SPARROW_SERVER` are exported **identically** to
  `scenario_start`, so `ac_tok`, `api`, `signup`, `sse_me_watch` … all work
  unchanged;
- the EXIT trap gains `docker compose … down -v` ahead of the tmp-root wipe.

Host-tool requirements are **declared**, never assumed: `SCENARIO_REQUIRES=(compose
swaks)` plus a `scenario_requires` call makes a missing tool print `SKIP` and exit
0. `run-all.sh` reports SKIP in its summary and stays green — a machine without
the toolchain reports the gap instead of failing the suite.

Two shapes to keep straight when writing pop assertions: the **unified**
`sparrow pop` (no `--room`) returns the v4 `{ item }` envelope, while the
**room-scoped** `sparrow pop --room <id>` keeps its v3 `{ message, room }` shape
— rooms have no email, so that route never became a work-item route.

## Add scenario NNN-name

1. `mkdir scenarios/NNN-name && touch scenarios/NNN-name/run.sh && chmod +x` it.
2. Start it with:

       #!/usr/bin/env bash
       set -euo pipefail
       SCENARIO_NAME="NNN-name"
       . "$(cd "$(dirname "$0")/.." && pwd)/lib.sh"
       scenario_start   # sets $SERVER, $ADMIN_TOKEN, $SPARROW_SERVER; traps cleanup

3. Drive the CLI and API with the v3 helpers (see `lib.sh` for the full set):
   - `signup <email> <pw> <name>` → a `ses_` token (the FIRST signup bootstraps
     an org and owns it).
   - `ac_tok <token> <args…>` — run the CLI as a bearer credential (`ses_`/`agk_`)
     via `SPARROW_TOKEN`; `ac_as <profile> <args…>` for `login`/`enroll` persistence.
   - `create_agent`, `add_human_to_org`, `enroll_existing_human` for fixtures.
   - `api` / `api_raw` / `http_status` / `admin_api` for raw calls; `first_org_id`,
     `invite_token_of` for discovery; `sse_room_watch` / `sse_me_watch` +
     `wait_for_line` for SSE assertions (grep-based — never awk on vm8's mawk).
   - `assert_eq` / `assert_contains` / `assert_not_contains` / `assert_json` /
     `pass` / `fail` / `skip`.
   `run-all.sh` picks up `[0-9]*-*/run.sh` automatically, in sorted order.
4. Needs sidecars? Add a `compose.yml` beside `run.sh`, set
   `SCENARIO_REQUIRES` / `SCENARIO_COMPOSE_PORTS` / `SCENARIO_COMPOSE_READY`, and
   call `scenario_compose_start "$(cd "$(dirname "$0")" && pwd)"`. See
   `150-email-smtp` for the worked example (core + `apps/mail-gateway` + mailpit
   + a CoreDNS sidecar publishing the DKIM key the edge has to look up).
