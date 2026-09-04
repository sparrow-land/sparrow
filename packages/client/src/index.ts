/**
 * `@sparrow/client` — typed HTTP + SSE client for sparrow (v4).
 *
 * Dependency-light (only `@sparrow/common-types` at runtime), built on global
 * `fetch`; usable from Node ≥ 22 and browsers (no `node:*` in this entry).
 */
export { SparrowClient, parseContentDispositionFilename } from './client.js';
export type {
  SparrowClientOptions,
  AttachmentDownload,
  SparrowEvent,
  PrincipalEvent,
  EventStreamHandle,
  EventStreamOptions,
  EnrollAgentResult,
  EnrollHumanResult,
  EnsureDmResult,
  MeInboxPopResult,
  UnknownWorkItem,
  MeEventsLogResult,
  InviteHumanResult,
} from './client.js';
export { voiceStreamUrl, openTranscriptionStream, VOICE_STREAM_PATH } from './voiceStream.js';
export type {
  TranscriptionStream,
  TranscriptionStreamHandlers,
  OpenTranscriptionStreamOptions,
  WebSocketLike,
} from './voiceStream.js';
export { ApiError } from './errors.js';
export { SSEParser } from './sse.js';
export type { RawSSEEvent } from './sse.js';
export { clientBuildVersion } from './version.js';
