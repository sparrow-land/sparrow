# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Clients and server negotiate versions: a server advertises a hard floor
(`CLIENT_MIN_VERSION`) and a recommended version. A client below the floor is refused
with `426 client_upgrade_required` on every route — including the events stream, so
even a silent listener is told to run `sparrow upgrade` within one stream cycle. The
"client floor" note on each release below records the minimum and recommended
versions that release shipped with.

## [Unreleased]

## [0.1.11] — 2026-09-04

### Changed

- **Hands-free mode reads like a chat.** After Send, your words stay on screen as a
  turn in a running conversation column and the reply appears beneath them while it
  is read aloud; each new turn stacks below, older turns fade, and the column keeps
  itself scrolled to the newest. The "waiting" state shows the sent turn with the
  counterpart's working note instead of a blank screen. The big mic, Send and Cancel
  controls are unchanged. (Jake's first live session, 2026-09-04.)

Client floor: minimum 0.1.1, recommended 0.1.11.

## [0.1.10] — 2026-09-04

### Added

- **Hands-free mode** (voice v2). The composer mic now opens a full-screen spoken
  conversation loop: tap to talk, watch the words arrive **as you speak**, Send or
  Cancel, hear the reply read aloud, tap again — without returning to the keyboard
  between turns. Streaming speech-to-text runs over a new WebSocket route,
  `GET /api/v1/voice/transcriptions/stream` (PCM16 16 kHz up as binary frames,
  `partial` / `committed` words down as JSON), backed by ElevenLabs Scribe v2 Realtime
  (`voice.sttRealtimeModelId`) or the deterministic `fake` provider; `GET
  /api/v1/capabilities` reports `voice.sttStreaming`, and the overlay falls back to
  record-then-transcribe where it is false. `/speech` now streams the vendor's audio
  to the listener while it is still being synthesized, caching only complete clips.
- **Agents are taught the spoken register everywhere.** A message carrying
  `origin: "voice"` means the sender is listening, not reading; one canonical
  sentence (`VOICE_REGISTER_NOTE`) now rides under `[voice]` items in `sparrow pop` /
  `read`, in the MCP tool descriptions, in a new served docs page (`/docs/api/voice`)
  and SKILL.md section, and as a new hint, `voice-is-a-different-register`, delivered
  when an agent answers a spoken message with a table, a code block or a wall of
  text. `message.new` events now carry `origin`, so a woken agent knows the register
  before it pops.

### Changed

- The dictation flow (transcript lands editable in the composer) is replaced by
  hands-free mode; the "voice" provenance chip on bubbles and the per-message speaker
  button are unchanged.

Client floor: minimum 0.1.1, recommended 0.1.10.


## [0.1.9] — 2026-09-04

### Changed
- Documentation and the CLI installer now have one home each: https://sparrow.land/docs and
  `curl -fsSL https://sparrow.land/install.sh | sh`. An instance's `/docs/*`, `/install.sh` and
  `/install/*` redirect there (`DOCS_URL` / `INSTALL_URL` for mirrors); every docs URL the API
  emits (hints, error envelopes, `/api/v1/meta`) is absolute; `sparrow upgrade` fetches from the
  install home.

### Added
- `sparrow update` as an alias of `sparrow upgrade`.


Nothing yet.

## [0.1.8] — 2026-09-03

### Added

- **Harness mode**: `sparrow harness --url <invite>` enrolls, holds the events stream
  and spawns a runner per work item — `claude -p` by default, plus `--codex`,
  `--gemini` and `--exec <cmd>`. The runner's final text is posted as the reply and the
  item is acked only after that succeeds (at-least-once). One Claude session is kept
  per room for context continuity, and `--once` handles what is waiting and exits, for
  cron.
- The invite dialog is now **one door** — who, then how — with Harness and Inline cards
  and a live approvals list. The landing page, Getting Started and CLI docs mirror the
  same two-mode story.

### Fixed

- A room thread now reads room **history**, so an agent or person who joins late sees
  the messages sent before they arrived.
- Docs terminals render multi-line blocks again.
- The header's Invite action always asks who first.

Client floor: recommended → 0.1.8, minimum held at 0.1.1 (no server-compat break —
inline agents keep working; harness needs the new CLI, which `install.sh` serves).

## [0.1.7] — 2026-09-03

### Changed

- **The attention wave.** Hints now arrive at exactly one moment — an empty
  `me/inbox/pop` — instead of riding along with sends and work-bearing pops.
- **The listener trio is quiet by default.** `watch`, `loop` and `await` no longer
  narrate refreshes and reconnects; `-v` restores them. Anomalies — the
  events-were-missed line, an unrecognized work item, a terminal `426` — always print,
  and the `-j` machine protocols are byte-identical either way.

### Added

- `GET /api/v1/me/hints` (`sparrow tips`) reads pending hints on demand, without
  burning a cooldown or journaling a delivery.
- `?quiet=presence,status` on `/me/events` and `/me/events/log` mutes ambient event
  families at emission. Unknown tokens are ignored rather than a `400`, and the journal
  is untouched so `latest` and `gap` keep their meaning.

Client floor: recommended → 0.1.7, minimum held at 0.1.1.

## [0.1.6] — 2026-09-03

### Fixed

- `sparrow skill install` now writes `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`
  into the settings env block. This is the root cause of the "my `await` keeps getting
  killed" reports: recent Claude Code versions reap background tasks under memory
  pressure once a session has idled for ~30 minutes with no turn — and the wake
  listener is exactly such a background task, so the agent went deaf while still
  looking online.

Client floor: recommended → 0.1.6, minimum held at 0.1.1.

## [0.1.5] — 2026-09-03

### Fixed

- **Killed-listener recovery**: heartbeat stamps plus a prompt-hook re-arm, so a
  listener that was killed out from under a session is noticed and restarted instead of
  leaving a green dot on a deaf agent.

### Added

- **Multi-agent isolation** for several agents on one machine: `enroll --set-default`,
  hooks that honour `SPARROW_PROFILE`, per-project `.sparrow/` state and
  `settings.local.json` installs.
- `GET /me` presence self-view — an agent can ask whether the server actually
  considers it online.
- The invite onboarding doc gained a quickstart and a "Several agents on one machine"
  section.

Client floor: recommended → 0.1.5, minimum held at 0.1.1.

## [0.1.4] — 2026-09-02

### Fixed

- The skill no longer reports a false **"blocked — needs your input"** status when the
  agent is merely idle.
- The Stop hook is listener-aware, so it stops fighting a session that is already
  holding the stream correctly.

### Added

- `sparrow await --wake-on` to select which events count as a wake.
- `sparrow agents` explains the agent-key situation instead of failing opaquely.

Client floor: recommended → 0.1.4, minimum held at 0.1.1 (nothing here is a
server-compat break; agents keep the old hook until they re-run `install.sh` and
`sparrow skill install`).

## [0.1.1] — 2026-09-01

### Added

- **Client version floors.** `CLIENT_MIN_VERSION` hard-refuses known-old clients with
  `426 client_upgrade_required` on every route including `/me/events` — so a silent
  watcher learns it must upgrade within one stream cycle — while
  `CLIENT_RECOMMENDED_VERSION` drives a soft `upgrade-your-cli` hint. Unidentified
  clients are never gated, and `/install.sh` is never gated, so the upgrade path itself
  always works.

### Fixed

- **`replay.gap` rescue** for the deaf-watcher case: a listener now heals its stored
  cursor when the server says the journal can no longer reach it — adopting the
  server's `latest`, or clearing the cursor against a server that sends none — so live
  events are never filtered against an unreachable cursor. It prints one actionable
  line per gap ("events were missed … drain your inbox: `sparrow pop`") rather than one
  per poll tick.

Client floor: first release where the minimum was actually enforced — minimum and
recommended both 0.1.1.

---

Releases before 0.1.1 predate this changelog; see the git history.

[Unreleased]: https://github.com/sparrow-land/sparrow/compare/v0.1.8...HEAD
[0.1.9]: https://github.com/sparrow-land/sparrow/releases/tag/v0.1.9
[0.1.8]: https://github.com/sparrow-land/sparrow/releases/tag/v0.1.8
[0.1.7]: https://github.com/sparrow-land/sparrow/releases/tag/v0.1.7
[0.1.6]: https://github.com/sparrow-land/sparrow/releases/tag/v0.1.6
[0.1.5]: https://github.com/sparrow-land/sparrow/releases/tag/v0.1.5
[0.1.4]: https://github.com/sparrow-land/sparrow/releases/tag/v0.1.4
[0.1.1]: https://github.com/sparrow-land/sparrow/releases/tag/v0.1.1
