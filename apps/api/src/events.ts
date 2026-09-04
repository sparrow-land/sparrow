import { EventEmitter } from 'node:events';
import type { EventJournal } from './event-journal.js';
import type {
  ActivityAppendedEvent,
  EnrollmentRequestedEvent,
  EnrollmentResolvedEvent,
  DmSeveredEvent,
  AgentSharedEvent,
  RoleUpdatedEvent,
  EmailReceivedEvent,
  EmailSentEvent,
  EmailQuarantinedEvent,
  EmailHeldEvent,
  EmailRejectedEvent,
  EmailResolvedEvent,
  PrincipalKind,
  RoomInvitationEvent,
} from '@sparrow/common-types';

/**
 * Principal-level SSE event names + payloads (SPEC "Events"). These are the
 * unwrapped events delivered on `GET /me/events` to a specific principal. Room
 * events fan in on top (see {@link RoomEventHub}); this bus carries only the
 * principal-level ones.
 *
 * v3's five all targeted humans. v4 adds `activity.appended` (to the involved
 * agent's OWNER) and — when the email medium lands — `email.received` /
 * `email.sent`, which target AGENTS. Hence the key: **(principalType,
 * principalId)**, never a bare human id.
 */
export interface PrincipalEventMap {
  'enrollment.requested': EnrollmentRequestedEvent;
  'enrollment.resolved': EnrollmentResolvedEvent;
  'agent.shared': AgentSharedEvent;
  'agent.unshared': AgentSharedEvent;
  /* `role.updated` — one shape, two audiences: the AGENT itself (its role
   * changed, re-read it) and every human who can currently SEE the agent (the
   * sidebar's org-visible title moved; `agentId` says whose). Never carries the
   * private instructions. */
  'role.updated': RoleUpdatedEvent;
  /* An agent↔agent DM pair was severed / allowed again by a human. One shape,
   * three audiences: BOTH agents (their line moved) and every human who can
   * currently see both (an open oversight view updates in place). */
  'dm.severed': DmSeveredEvent;
  'dm.allowed': DmSeveredEvent;
  'room.invitation': RoomInvitationEvent;
  'activity.appended': ActivityAppendedEvent;
  /* The email medium's six (SPEC "Unified attention → `/me/events` in v4"). The
   * first two target the AGENT; the approval trio fans out to the anchor agent's
   * owner AND the org's owners/admins; `email.resolved` reaches both plus the
   * agent, so two approvers watching one row see it resolve in place. */
  'email.received': EmailReceivedEvent;
  'email.sent': EmailSentEvent;
  'email.quarantined': EmailQuarantinedEvent;
  'email.held': EmailHeldEvent;
  'email.rejected': EmailRejectedEvent;
  'email.resolved': EmailResolvedEvent;
}

export interface SseEnvelope<E extends keyof PrincipalEventMap = keyof PrincipalEventMap> {
  event: E;
  data: PrincipalEventMap[E];
  /** The journal cursor for this event (the SSE `id:`), when journaling is on. */
  id?: number;
}

/** The bus/journal key of a principal: `human:usr_…` / `agent:agt_…`. */
function principalKey(principalType: PrincipalKind, principalId: string): string {
  return `${principalType}:${principalId}`;
}

/**
 * In-process pub/sub for principal-level events, keyed by (principalType,
 * principalId). Each connected `/me/events` client subscribes with its own
 * principal identity — humans AND agents — and publishers target one principal.
 * Single-process v1.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private journal?: EventJournal;

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  /**
   * Late-bind the `/me/events` journal (created after the bus). Once set, every
   * principal-level publish is journaled under the target PRINCIPAL and the
   * emitted envelope carries its cursor id, so `/me/events` frames and replay
   * match — for an agent recipient exactly as for a human one.
   */
  bindJournal(journal: EventJournal): void {
    this.journal = journal;
  }

  subscribe(
    principalType: PrincipalKind,
    principalId: string,
    listener: (env: SseEnvelope) => void,
  ): () => void {
    const key = principalKey(principalType, principalId);
    this.emitter.on(key, listener);
    return () => this.emitter.off(key, listener);
  }

  publish<E extends keyof PrincipalEventMap>(
    principalType: PrincipalKind,
    principalId: string,
    event: E,
    data: PrincipalEventMap[E],
  ): void {
    const id = this.journal?.append(principalType, principalId, event, data);
    this.emitter.emit(principalKey(principalType, principalId), {
      event,
      data,
      id,
    } satisfies SseEnvelope);
  }
}
