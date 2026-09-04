# Voice v1 — design proposal (manual mode)

Status: APPROVED by Jake 2026-08-21; implemented on this branch (wire shapes
graduated into SPEC.md — SPEC is the contract, this doc is the design record).

## Goal

Let a human hold a voice exchange with an agent using the existing messaging
system: click the mic to speak (speech → text), click the speaker on a reply to
hear it (text → speech). Fully manual in v1 — no auto-listen, no auto-play.
Everything lands in sparrow-core (open source); the UI only shows voice controls
when the server holds the requisite vendor key.

## Vendor research (Aug 2026, verified against live docs)

- **ElevenLabs** does both directions with one key (`ELEVENLABS_API_KEY`):
  - STT: `POST /v1/speech-to-text` (model `scribe_v2`), multipart, accepts
    webm/ogg/mp4 straight from browsers, $0.22/hr.
  - TTS: `POST /v1/text-to-speech/{voiceId}` (model `eleven_flash_v2_5`,
    ~75 ms, $0.05/1K chars), MP3 out — plays natively in every browser.
  - Official SDK `@elevenlabs/elevenlabs-js` — but the two calls are plain
    fetch + multipart; **no SDK dependency needed**.
- **OpenAI** (`gpt-4o-mini-transcribe` ≈$0.18/hr, `gpt-4o-mini-tts`) fits the
  same interface; 25 MB upload cap is its only quirk. Second provider, later.
- **Web Speech API**: keyless but Firefox lacks STT and Chrome ships audio to
  Google anyway. Not the foundation; possible progressive enhancement later.
- **Browser capture**: `MediaRecorder` — Chrome/Firefox produce
  `audio/webm;codecs=opus`, Safari `audio/mp4`. Feature-detect via
  `isTypeSupported`, send the blob's real MIME. Vendors accept both, so **no
  transcoding anywhere**.

## Architecture

### 1. Provider seam (apps/api, mirrors `AuthProvider`)

```ts
interface SttProvider {
  id: string;                                   // 'elevenlabs'
  transcribe(audio: Buffer, contentType: string,
             opts?: { language?: string }): Promise<{ text: string; language?: string }>;
}
interface TtsProvider {
  id: string;
  synthesize(text: string): Promise<{ audio: Buffer; contentType: string }>; // audio/mpeg
}
```

Registered at `buildServer()` iff their key is present (exact pattern of
`googleCredentialsPresent()` → provider registration). Core ships:

- `elevenlabs` — both interfaces, gated on `ELEVENLABS_API_KEY`.
- `fake` — deterministic test/dev provider (fixed transcript, tiny valid MP3),
  gated on `VOICE_PROVIDER=fake`. This is what unit tests, scenario tests, and
  keyless dev stacks use; it keeps TDD hermetic (no network, no billing).

Config descriptors (ConfigStore, `secret: true`, masked on the wire):
`voice.elevenLabsApiKey` (env `ELEVENLABS_API_KEY`), plus non-secret
`voice.ttsVoiceId`, `voice.ttsModelId`, `voice.sttModelId` with the defaults
above. Resolution db → env → default as usual, so keys can also be entered at
runtime through instance settings.

### 2. Capability exposure (never the key)

New unauthenticated endpoint, room to grow beyond voice:

```
GET /api/v1/capabilities → { voice: { stt: boolean, tts: boolean } }
```

Booleans only, derived from which providers registered (same trust model as
`GET /auth/config` advertising the Google provider). Web fetches it at boot
alongside `auth/config`; CLI/MCP may use it to decide whether to surface voice
affordances.

### 3. Speech-to-text route

```
POST /api/v1/voice/transcriptions          auth: session or agent key
body { audioBase64, contentType, language? }
 → 200 { text, language? }
 → 404 when no STT provider registered; 413 over cap; 502 vendor failure
```

- Principal-scoped (not room-scoped): a transcription is not room data.
- Base64 JSON body keeps consistency with attachment upload (no multipart
  machinery). Cap: 15 MB decoded (~ minutes of opus; far above a mic clip).
- The transcript is returned to the caller; **the server does not send any
  message**. Sending stays an explicit, separate act (manual mode).

### 4. Voice origin metadata on messages

`messages` gains a nullable `origin` column; `Message` and
`SendMessageRequest` gain `origin?: 'voice'` (`null` = typed). String enum,
extensible later (e.g. 'email-bridge').

- Recipient agents (CLI `read`/`pop` output, MCP tool results) see
  `origin: 'voice'`; the MCP `pop_next_message`/`read_message` descriptions
  gain one line: when a message carries `origin: 'voice'`, prefer a concise,
  speakable reply (no tables/code walls) — the sender is likely listening, not
  reading.
- **Schema-change note**: v3 is fresh-DB-only with no migration chain. An
  additive nullable column is the gentlest possible change; proposal is one
  guarded `ALTER TABLE messages ADD COLUMN origin TEXT` in `migrate.ts`
  (PRAGMA table_info check, idempotent) rather than wiping DBs again. This
  bends "no migration chain" without starting one — flagged for decision.

### 5. Text-to-speech route (message-scoped)

```
GET /api/v1/rooms/:roomId/messages/:id/speech    auth: member + can-read
 → 200 audio/mpeg (content-disposition: inline)
 → 404 no TTS provider / not readable; 502 vendor failure
```

- Message-scoped rather than free-text: authz falls out of the existing
  `memberCanReadMessage`, and the server synthesizes only content that already
  exists in a room — no open text-to-audio proxy on someone else's API bill.
- Synthesized audio cached on disk at `$DATA_DIR/tts/{messageId}` (input text
  is immutable), so replays and multiple listeners bill the vendor once.
  Speaks `subject + body` stripped of markdown syntax.
- Served inline (unlike attachments' forced download) so the web can stream it
  into an `<audio>` element; playback stays inside the click gesture chain to
  satisfy autoplay policies.

### 6. Web UI (all gated on `capabilities.voice`)

- **Composer** (`Composer.tsx`): mic button (hidden without `voice.stt`).
  Click → record (pulsing state, click again to stop) → POST transcription →
  transcript lands **in the composer, editable**, with a small "voice" chip;
  Send transmits it with `origin: 'voice'`. Recording errors and mic-denied
  states surface inline. Manual and predictable — no auto-send in v1.
- **Message bubbles** (`Room.tsx`): speaker button on counterpart messages
  (hidden without `voice.tts`) → fetch `/speech` → Blob URL → play, with
  playing/stop toggle. No auto-play.

### 7. Out of scope for v1 (the v2+ exploration)

Auto-pop-and-play of replies, push-to-talk, streaming TTS
(`/stream` endpoint exists and pipes through Fastify when we want it), audible
"agent is working" cues, voice notes as attachments (original audio riding the
message), per-agent voices. The provider seam and `origin` field are the
foundation all of these build on.

## Test plan (TDD order)

1. `common-types`: schema tests for `origin`, capabilities, transcription
   shapes (failing first).
2. `apps/api`: route tests via `fastify.inject` with the `fake` provider —
   capabilities on/off, transcription happy/413/404, speech authz + cache,
   origin round-trip through send/read/pop. Provider unit tests mock fetch
   (assert exact ElevenLabs endpoint/headers/multipart against the researched
   contract).
3. `packages/client`: `getCapabilities`, `transcribe`, `getMessageSpeech`
   methods against in-process server.
4. `apps/web`: component tests — buttons hidden without capability, transcript
   → composer flow, origin chip.
5. Scenario `115-voice`: fake-provider e2e — enroll, transcribe via curl, send
   with origin, speech bytes identical on second fetch (cache).

## Open questions for Jake

1. **Origin marking**: transcript is editable in the composer — still mark
   `origin: 'voice'` after edits? (Proposal: yes — provenance, not verbatim.)
2. **ALTER TABLE stance** (§4): guarded additive ALTER vs. another fresh-DB
   cutover for staging/prod.
3. **Capabilities endpoint** unauthenticated (like `auth/config`) vs
   session-gated — booleans only either way.
4. **ElevenLabs account**: need a real `ELEVENLABS_API_KEY` in Doppler
   (`sparrow` project, dev first) for live testing; free tier is enough for dev.
