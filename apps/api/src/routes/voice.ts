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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  TranscriptionRequestSchema,
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  type CapabilitiesResponse,
  type TranscriptionResponse,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { resolvePrincipal, principalIdent } from '../context.js';
import { parse } from '../validate.js';
import { badGateway, notFound, payloadTooLarge } from '../errors.js';
import { requireRoomMember } from '../room-helpers.js';
import { messageInRoom, memberCanReadMessage } from '../message-helpers.js';
import { emailMediumOn } from '../email/addresses.js';
import type { MessageRow } from '../db/schema.js';

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

export function registerVoiceRoutes(app: FastifyInstance, ctx: AppContext): void {
  /* ------------------------------- Capabilities ---------------------- */
  app.get('/api/v1/capabilities', (_request, reply) => {
    // A workspace directory URL turns the leftnav org header into a switcher; the
    // create URL is optional (only offered when both are configured). Unset
    // directory URL → `null` → the SPA shows a plain org label.
    const directoryUrl = String(ctx.configStore.get('workspace.directoryUrl') ?? '').trim();
    const createUrl = String(ctx.configStore.get('workspace.createUrl') ?? '').trim();
    const response: CapabilitiesResponse = {
      voice: { stt: ctx.voice.stt !== null, tts: ctx.voice.tts !== null },
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
        writeFileSync(cachePath, audio);
      }
      return reply
        .header('content-type', 'audio/mpeg')
        .header('content-disposition', 'inline')
        .send(audio);
    },
  );
}
