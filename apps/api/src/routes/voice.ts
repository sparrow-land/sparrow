/**
 * Voice routes (SPEC "Voice (STT & TTS)"). Vendor-key-gated: with no provider
 * registered the voice routes `404` and clients hide voice controls.
 *
 * - `GET /capabilities` (no auth): registered-provider booleans, never keys.
 * - `POST /voice/transcriptions` (principal auth): principal-scoped STT — the
 *   transcript returns to the caller; the server never sends on their behalf.
 * - `GET /rooms/:roomId/messages/:id/speech` (any room member — the same authz as
 *   GetAttachment; recipient rows are delivery state, never visibility):
 *   synthesized speech of subject + body with markdown stripped, cached at
 *   `$DATA_DIR/tts/{messageId}` (message bodies are immutable → one vendor call
 *   per message ever). Works on archived rooms.
 */
import { createWriteStream, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import {
  TranscriptionRequestSchema,
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  type CapabilitiesResponse,
  type TranscriptionResponse,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { resolvePrincipal, principalIdent } from '../context.js';
import { resolveStreamPrincipal } from './events.js';
import { parse } from '../validate.js';
import { badGateway, notFound, payloadTooLarge } from '../errors.js';
import { requireRoomMember } from '../room-helpers.js';
import { messageInRoom, memberCanReadMessage } from '../message-helpers.js';
import { emailMediumOn } from '../email/addresses.js';
import type { MessageRow } from '../db/schema.js';

/**
 * Per-session caps on `GET /voice/transcriptions/stream` (SPEC *Voice*). A hot
 * microphone is an open-ended vendor bill and an open-ended socket; both are
 * bounded so a forgotten tab cannot run either forever.
 */
export const VOICE_STREAM_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const VOICE_STREAM_MAX_SECONDS = 600;

/** One frame the socket sends down. Kept local: it is a transport, not a resource. */
type VoiceStreamFrame =
  | { type: 'partial'; text: string }
  | { type: 'committed'; text: string }
  | { type: 'error'; message: string };

/**
 * Strip common markdown markers so the synthesized speech reads cleanly: link/
 * image syntax collapses to its text, and stray `#*_`>[]()` markers are removed.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) / ![alt](url) → text/alt
    .replace(/[#*_`>]/g, '')
    .replace(/[[\]()]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** The text spoken for a message: subject (if any) then body, markdown stripped. */
function speechText(row: MessageRow): string {
  const raw = row.subject ? `${row.subject}. ${row.body}` : row.body;
  return stripMarkdown(raw);
}

/** Normalize either stream flavor a provider may hand back to a Node readable. */
function toNodeStream(source: ReadableStream<Uint8Array> | NodeJS.ReadableStream): NodeJS.ReadableStream {
  return typeof (source as ReadableStream<Uint8Array>).getReader === 'function'
    ? Readable.fromWeb(source as Parameters<typeof Readable.fromWeb>[0])
    : (source as NodeJS.ReadableStream);
}

/**
 * Write `audio` to `cachePath` ATOMICALLY: stage it in a per-request part file,
 * then rename it into place.
 *
 * `writeFileSync` is not a substitute. It opens with `'w'` — truncating — and
 * then LOOPS `writeSync` until the buffer is drained, so between those two
 * moments the cache path exists holding less than a clip. A concurrent listener
 * (whose route does `existsSync` then `readFileSync`) can read that short file
 * and serve it as audio, and a crash in the window leaves it there for good:
 * message bodies are immutable, so the entry is never invalidated. A rename is
 * a single atomic step — readers see the whole clip or no file at all.
 */
function publishCache(cachePath: string, audio: Buffer): void {
  const partPath = `${cachePath}.${randomUUID()}.part`;
  try {
    writeFileSync(partPath, audio);
    renameSync(partPath, cachePath);
  } catch {
    // The client still gets its audio; a cache we could not publish just means
    // the next listener re-synthesizes. Never leave the staged file behind.
    rmSync(partPath, { force: true });
  }
}

/**
 * Pipe `source` to the client AND into `cachePath` at the same time.
 *
 * The cache lands via a part file renamed only once the vendor stream ENDS: a
 * listener who hangs up mid-sentence, or a vendor that dies, must not leave a
 * truncated file behind — message bodies are immutable, so a poisoned cache
 * entry would be permanent.
 *
 * The part file is UNIQUE PER REQUEST, which is the whole reason this is not a
 * one-liner. Two listeners can hit the same uncached message at once; sharing
 * one part path means the second `'w'` open truncates the first mid-write, the
 * first keeps writing at its old offset (leaving a zero-filled hole), and the
 * first's rename then publishes that hole as the permanent cache. With one file
 * each, the writers never touch each other: whoever finishes renames a COMPLETE
 * clip into place, and a later winner overwrites it with identical bytes.
 */
function teeToCache(source: NodeJS.ReadableStream, cachePath: string): NodeJS.ReadableStream {
  const out = new PassThrough();
  const partPath = `${cachePath}.${randomUUID()}.part`;
  const file = createWriteStream(partPath);
  // Only ever removes THIS request's part file — never a concurrent listener's.
  const discard = (): void => {
    file.destroy();
    rmSync(partPath, { force: true });
  };
  file.on('finish', () => {
    try {
      renameSync(partPath, cachePath);
    } catch {
      /* the directory went away under us; the client already has its audio */
    }
  });
  file.on('error', discard);
  source.on('error', () => {
    discard();
    out.destroy();
  });
  source.pipe(out);
  source.pipe(file);
  return out;
}

export function registerVoiceRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* ------------------------------- Capabilities ---------------------- */
  app.get('/api/v1/capabilities', (_request, reply) => {
    // A workspace directory URL turns the leftnav org header into a switcher; the
    // create URL is optional (only offered when both are configured). Unset
    // directory URL → `null` → the SPA shows a plain org label.
    const directoryUrl = String(ctx.configStore.get('workspace.directoryUrl') ?? '').trim();
    const createUrl = String(ctx.configStore.get('workspace.createUrl') ?? '').trim();
    const response: CapabilitiesResponse = {
      voice: {
        stt: ctx.voice.stt !== null,
        tts: ctx.voice.tts !== null,
        // Not "voice is on" — "the registered STT provider can stream". A
        // buffered-only provider reports stt:true / sttStreaming:false and the
        // client falls back to record-then-transcribe instead of opening a
        // socket that would 404.
        sttStreaming: typeof ctx.voice.stt?.stream === 'function',
      },
      // The email medium's on/off. This unauthenticated route — not a `404` from
      // `/me/email/*` — is where a client learns a medium exists.
      email: emailMediumOn(ctx),
      // Whether an automatic reviewer exists here. Independent of the medium:
      // a `judge` policy without one degrades to approve, and an org admin is
      // told that plainly rather than the UI guessing (SPEC *Web UI → Org admin*).
      emailReviewer: ctx.email.judge !== null,
      orgHostSuffix: ctx.config.orgHostSuffix ?? null,
      workspaceSwitcher: directoryUrl
        ? { directoryUrl, createUrl: createUrl || null }
        : null,
    };
    return reply.send(response);
  });

  /* ------------------------------- Transcriptions -------------------- */
  app.post('/api/v1/voice/transcriptions', async (request, reply) => {
    // Principal-scoped (session or agent key); audio is not room data.
    resolvePrincipal(ctx, request);
    const body = parse(TranscriptionRequestSchema, request.body);
    const audio = Buffer.from(body.audioBase64, 'base64');
    if (audio.length > MAX_TRANSCRIPTION_AUDIO_BYTES) {
      throw payloadTooLarge('Audio payload is too large');
    }
    const provider = ctx.voice.stt;
    if (!provider) throw notFound('No speech-to-text provider');
    let result: { text: string; language?: string };
    try {
      result = await provider.transcribe(audio, body.contentType, { language: body.language });
    } catch {
      throw badGateway('voice vendor request failed');
    }
    const response: TranscriptionResponse = {
      text: result.text,
      ...(result.language !== undefined ? { language: result.language } : {}),
    };
    return reply.send(response);
  });

  /* --------------------- Streaming transcription --------------------- */
  // The hands-free transport: audio UP as binary frames, words DOWN as JSON.
  // A WebSocket rather than SSE because the exchange is bidirectional and the
  // vendor side is itself a socket — SSE would need a second POST channel per
  // audio chunk. Principal-scoped like the one-shot route: the server hands the
  // words back to the caller and never sends them anywhere.
  //
  // Declared inside its own `register` on purpose: @fastify/websocket does its
  // work in an `onRoute` hook, and those run SYNCHRONOUSLY as each route is
  // declared — while the plugin itself only loads at `ready()`. A route
  // declared straight onto `app` here would therefore never be wrapped, and
  // would be handed `(request, reply)` instead of a socket. Deferring it one
  // `register` puts it after the plugin in avvio's queue.
  void app.register(async (scope) => {
    scope.get<{ Querystring: { token?: string; language?: string } }>(
      '/api/v1/voice/transcriptions/stream',
      {
        websocket: true,
        // Refuse BEFORE the upgrade, so a client sees an honest HTTP status
        // instead of a socket that opens and immediately dies.
        preValidation: async (request) => {
          resolveStreamPrincipal(ctx, request, request.query.token);
          const provider = ctx.voice.stt;
          if (!provider || typeof provider.stream !== 'function') {
            throw notFound('No streaming speech-to-text provider');
          }
        },
      },
      (socket, request) => {
        const stream = ctx.voice.stt!.stream!({ language: request.query.language });
        const maxBytes = ctx.config.voiceStreamMaxAudioBytes ?? VOICE_STREAM_MAX_AUDIO_BYTES;
        const maxMs = (ctx.config.voiceStreamMaxSeconds ?? VOICE_STREAM_MAX_SECONDS) * 1000;
        let bytes = 0;
        let over = false;

        const send = (frame: VoiceStreamFrame): void => {
          if (socket.readyState !== socket.OPEN) return;
          try {
            socket.send(JSON.stringify(frame));
          } catch {
            /* client vanished mid-write */
          }
        };

        /** End the session once: release the vendor stream, then close the socket. */
        const end = (code: number, message?: string): void => {
          if (over) return;
          over = true;
          clearTimeout(deadline);
          if (message !== undefined) send({ type: 'error', message });
          stream.close();
          try {
            socket.close(code);
          } catch {
            /* already gone */
          }
        };

        const deadline = setTimeout(
          () => end(1011, 'transcription session time limit reached'),
          maxMs,
        );
        (deadline as { unref?: () => void }).unref?.();

        stream.on('partial', (text) => send({ type: 'partial', text }));
        stream.on('committed', (text) => send({ type: 'committed', text }));
        // Every provider failure arrives here already flattened to a
        // VoiceVendorError — the vendor's own words never reach the client.
        stream.on('error', () => end(1011, 'voice vendor request failed'));

        socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
          if (over) return;
          if (isBinary) {
            const chunk = Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.isBuffer(data)
                ? data
                : Buffer.from(data);
            bytes += chunk.length;
            if (bytes > maxBytes) {
              end(1011, 'transcription session audio limit reached');
              return;
            }
            stream.push(chunk);
            return;
          }
          // Text frames are control, not audio. Anything we cannot read is
          // ignored: a stray frame must not cost the speaker their utterance.
          let control: { type?: string };
          try {
            control = JSON.parse(data.toString()) as { type?: string };
          } catch {
            return;
          }
          if (control.type === 'commit') stream.commit();
          else if (control.type === 'close') end(1000);
        });

        // A client that hangs up — cleanly or by vanishing — must not leave a
        // vendor socket (and its meter) running.
        socket.on('close', () => end(1000));
        socket.on('error', () => end(1011));
      },
    );
  });

  /* ------------------------------- Speech ---------------------------- */
  app.get<{ Params: { roomId: string; id: string } }>(
    '/api/v1/rooms/:roomId/messages/:id/speech',
    async (request, reply) => {
      const principal = principalIdent(resolvePrincipal(ctx, request));
      const caller = requireRoomMember(ctx, request, request.params.roomId, principal);
      // Read-only route: no archived-room guard (archived rooms still speak).
      const row = messageInRoom(ctx, caller.room.id, request.params.id);
      if (!row || !memberCanReadMessage(ctx, caller.member.id, row)) {
        throw notFound('No such message');
      }
      const provider = ctx.voice.tts;
      if (!provider) throw notFound('No text-to-speech provider');

      const cachePath = path.join(ctx.handle.ttsDir, row.id);
      // Progressive path: a provider that can stream gets to, so playback starts
      // on the first chunk instead of after the last one. The cache is written
      // by a TEE — same file, same bytes, so a second listen is still free.
      if (!existsSync(cachePath) && typeof provider.synthesizeStream === 'function') {
        let source: ReadableStream<Uint8Array> | NodeJS.ReadableStream;
        try {
          source = await provider.synthesizeStream(speechText(row));
        } catch {
          throw badGateway('voice vendor request failed');
        }
        return reply
          .header('content-type', 'audio/mpeg')
          .header('content-disposition', 'inline')
          .send(teeToCache(toNodeStream(source), cachePath));
      }
      let audio: Buffer;
      if (existsSync(cachePath)) {
        audio = readFileSync(cachePath);
      } else {
        let result: { audio: Buffer; contentType: string };
        try {
          result = await provider.synthesize(speechText(row));
        } catch {
          throw badGateway('voice vendor request failed');
        }
        audio = result.audio;
        publishCache(cachePath, audio);
      }
      return reply
        .header('content-type', 'audio/mpeg')
        .header('content-disposition', 'inline')
        .send(audio);
    },
  );
}
