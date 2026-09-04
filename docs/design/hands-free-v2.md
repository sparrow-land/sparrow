# Voice v2 — hands-free mode (design)

Status: PROPOSED 2026-09-04 (Jake's brief, DM). Builds on
[voice-v1.md](voice-v1.md) (manual dictation, approved 2026-08-21). Wire shapes
graduate into SPEC.md when this lands; SPEC stays the contract.

## Goal

Turn the one-shot dictation flow (mic → full-screen stop target → transcript
lands in the composer → send by hand) into a **conversation loop you can run
without looking at the keyboard**:

1. Tap the mic → enter **hands-free mode** (full-viewport, one big mic).
2. Tap the mic → **listening**. Words appear **as you speak** (streamed STT).
3. Two big buttons while listening: **Send** and **Cancel**.
4. Send posts the transcript to the room **and stays in hands-free mode**. When
   the counterpart's reply arrives, the client **reads it aloud** (TTS).
5. Tap the mic again for the next turn. Leave with the corner ✕ / Escape.

The message that results is an ordinary chat message with `origin: "voice"`.
Agents that receive one are told, on every client, that the sender is
**listening, not reading**, so they answer in a speakable register.

## What exists today (from the code map, 2026-09-04)

- Provider seam `apps/api/src/voice/{types,elevenlabs,fake}.ts` — buffered
  `transcribe(Buffer)` and `synthesize(text)`; one vendor (ElevenLabs
  `scribe_v2` / `eleven_flash_v2_5`) + `fake` for tests. **No streaming.**
- Routes `apps/api/src/routes/voice.ts` — `POST /voice/transcriptions` (base64,
  ≤15 MB), `GET /rooms/:r/messages/:id/speech` (buffered MP3, cached per
  message), `GET /capabilities → voice:{stt,tts}`.
- Web `MicButton` → `RecordingOverlay` (MediaRecorder webm/opus, whole-surface
  stop, corner cancel) → `Composer` with a "voice" chip; `SpeakerButton` plays
  `/speech` from a Blob URL on click. `Room.tsx` spreads `origin:'voice'` into
  the send.
- Marker: `MessageSchema.origin ∈ {'voice'} | null` is round-tripped through
  send/read/pop/outbox/log. MCP tool descriptions already say "sender is likely
  listening — prefer a concise, speakable answer". CLI prints `[voice]` only.
  `message.new` SSE frames do **not** carry `origin`. No voice hint in
  `hints.ts`, no voice segment in the served agent docs, one incidental mention
  in SKILL.md.

## Design

### 1. Streaming STT (server)

**Provider seam** — additive, optional method so `fake` and any future provider
can opt in:

```ts
interface SttStream {
  push(pcm16: Buffer): void;       // 16 kHz mono signed-16 LE
  commit(): void;                   // "I'm done — finalize"
  close(): void;
  on(ev: 'partial' | 'committed', cb: (text: string) => void): void;
  on(ev: 'error', cb: (err: Error) => void): void;
}
interface SttProvider {
  …existing…
  stream?(opts?: { language?: string }): SttStream;
}
```

- **ElevenLabs**: `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime`,
  header `xi-api-key`; send `{message_type:'input_audio_chunk', audio_base_64,
  sample_rate:16000, commit:false}`, commit with `commit:true`; receive
  `partial_transcript` / `committed_transcript` (`text`). Node 22's global
  `WebSocket` client — no SDK. New config `voice.sttRealtimeModelId`
  (default `scribe_v2_realtime`).
- **fake**: emits `partial` for each pushed chunk from a fixed script
  (`fake`, `fake transcript`), `committed: 'fake transcript'` on commit.
  Byte-deterministic for scenarios.
- `capabilities.voice` gains `sttStreaming: boolean` (Zod `.default(false)`),
  true iff the registered STT provider implements `stream`.

**Transport**: `GET /api/v1/voice/transcriptions/stream` upgraded to a
**WebSocket** via `@fastify/websocket` (new dep). Auth exactly like
`/me/events`: session cookie or `?token=`. Frames:

- client → server: **binary** = raw PCM16 16 kHz mono; **text** JSON
  `{"type":"commit"}` / `{"type":"close"}`.
- server → client: `{"type":"partial","text"}`, `{"type":"committed","text"}`,
  `{"type":"error","message"}` then close. Vendor failure → error frame (never
  the vendor body), no provider / no `stream` → HTTP 404 before upgrade.
- Principal-scoped, like one-shot transcription; the server never sends the
  transcript to a room. Cap: 10 minutes or 20 MB per session → close.

Why WebSocket and not SSE: the stream is **bidirectional** (audio up, words
down) and the vendor side is a WebSocket; SSE would need a second POST channel
per audio chunk. Cloudflare tunnels pass WS. (Fallback if we ever need it: POST
chunks to a session id + SSE for partials — same seam, worse ergonomics.)

### 2. TTS

Phase 1 reuses `GET …/speech` unchanged (buffered, cached). Phase 2 (same
effort if time permits): `synthesizeStream(text)` on the provider hitting
`/v1/text-to-speech/{voice}/stream`, the route pipes chunked `audio/mpeg`
while tee-ing into the cache file; the browser plays the URL progressively.

### 3. Web — `HandsFreeOverlay`

Replaces `RecordingOverlay`. `MicButton` becomes the entry point (same
placement; rendered iff `voice.stt`). State machine:

```
ready ──tap mic──▶ listening ──Send──▶ sending ──▶ awaiting ──reply──▶ speaking ──▶ ready
  ▲                  │Cancel                                  │ tap mic (interrupt)
  └──────────────────┘◀───────────────────────────────────────┘
```

- **ready**: big mic, "Tap to talk"; last reply text shown small.
- **listening**: level meter; **live transcript** (partials in muted color,
  committed in full color); **Send** (primary, disabled until any text) and
  **Cancel**. With `sttStreaming:false` we fall back to MediaRecorder +
  one-shot `/voice/transcriptions` after Stop, so the same overlay works on
  a keyless-streaming instance (no live words, one transcript on stop).
- Capture: `AudioContext({sampleRate:16000})` + `AudioWorkletNode` → Int16
  frames every ~250 ms over the WS. Where the context refuses 16 kHz, the
  worklet downsamples.
- **sending**: `POST …/messages` with `origin:'voice'` (existing send path;
  drafts/attachments untouched).
- **awaiting**: shows the counterpart's working status (already streamed to
  the room). Any message from **another member** that arrives while in mode
  is queued for speech; the first one after our send is what we're waiting
  for (prefer `inReplyTo === ourMessageId` when present).
- **speaking**: fetch `/speech` for the queued message and play. Autoplay:
  the `Audio` element is created and unlocked (silent play) inside the Send
  tap, then reused — required on iOS Safari. Tap mic = stop speaking, start
  listening. Messages from ourselves are never spoken.
- Exit: corner ✕ or Escape; stops capture, stops audio, returns to composer.
  Body scroll locked, `role="dialog" aria-modal`, `aria-live` on the
  transcript.
- `SpeakerButton` and the "voice" chip stay as they are.

### 4. Agents: the voice-input marker and the speakable register

- **Marker stays `origin: 'voice'`.** After this refactor every spoken message
  comes from hands-free mode, so `origin:'voice'` *means* "the sender is
  listening"; a second value would only split one semantic in two.
- **`message.new` gains `origin`** (additive, nullable) so an SSE-woken agent
  knows the register before it pops.
- **Every client teaches it the same sentence** (MCP already does):
  - CLI `pop` / `read` / `inbox` print, under a `[voice]` item, one line:
    *voice: the sender is listening, not reading — answer short and
    speakable: plain sentences, no tables, code blocks, links or long lists.*
  - SKILL.md gets a **Voice / hands-free** section (both copies:
    `packages/skill/assets/SKILL.md` and `.claude/skills/sparrow/SKILL.md`).
  - Served agent docs (`docs-content.ts`) gain a `voice` segment; the web
    API docs page documents the voice routes and `origin`.
- **Hint** `voice-is-a-different-register` (template: `email-is-a-different-register`):
  applies when the agent's most recent reply to a voice-origin message (within
  `RECENT_ACTIVITY_MS`) is not speakable — contains a table, fenced code, or
  exceeds ~600 chars. Text: what the sender hears vs. reads, and the fix.
  Permanent, cooldown like its email sibling.

### 5. Out of scope (v3)

Barge-in / VAD auto-stop, per-agent voices, streaming TTS if it slips,
Web Speech API, calls/telephony, TTS cache invalidation on voice change
(tracked separately).

## Test plan (TDD per package)

- **common-types**: `capabilities.voice.sttStreaming` default, `message.new`
  `origin`.
- **api**: `fake.stream()` determinism; ElevenLabs realtime frames against a
  mocked WebSocket; WS route: auth (cookie, token, 401), 404 without provider /
  without `stream`, partial→committed round trip, error frame on vendor
  failure, size/time cap; capabilities flag.
- **web**: overlay state machine (every transition above), fallback path
  without streaming, speak-on-reply (queued, never self), autoplay unlock on
  Send, exit cleanup (tracks stopped, audio stopped, scroll restored).
- **cli/mcp**: the register line under voice items; MCP description parity.
- **hints**: registry test + applies/build for the new trigger.
- **scenario `115-voice`**: extend with a WS streaming exchange against the
  fake provider (node one-liner client), `sttStreaming` booleans on both
  stacks, `message.new` carrying `origin`.

## Rollout

Land in sparrow-core (public), `monosplice push`, roll staging → prod per
docs/operations.md; the ElevenLabs key already present in all three configs
enables realtime STT with no infra change.
