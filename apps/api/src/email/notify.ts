/**
 * The email medium's layer-3 hand-offs: the six `email.*` events and the six
 * typed activity entries (SPEC v4 "Unified attention → `/me/events` in v4" and
 * "→ Entry types registry" — those tables are normative).
 *
 * Both are REFS, never bodies: an event carries an `EmailPreview` and an entry
 * carries `{ emailThreadId, emailId }`. The stream nudges, the client fetches.
 * The approval events fan out to the org's owners/admins as well as the owning
 * human, mirroring `enrollment.requested`, so the org-wide approvals list is
 * live for whoever can act on it.
 */
import { eq } from 'drizzle-orm';
import type {
  ActivityActorKind,
  EmailResolution,
  EmailReason,
  Party,
} from '@sparrow/common-types';
import type { AppContext } from '../context.js';
import { appendActivity } from '../activity.js';
import { agents, humans, orgMemberships } from '../db/schema.js';
import type { AgentRow, EmailRow, EmailThreadRow } from '../db/schema.js';
import { parseParticipants, toEmailPreview, toThreadRef } from './store.js';

/** The humans who may act on an org's email approvals: its owners and admins. */
export function orgEmailApprovers(ctx: AppContext, orgId: string): string[] {
  return ctx.db
    .select()
    .from(orgMemberships)
    .where(eq(orgMemberships.orgId, orgId))
    .all()
    .filter((m) => m.role === 'owner' || m.role === 'admin')
    .map((m) => m.humanId);
}

/** The approval audience: the anchor agent's owner + the org's owners/admins. */
function approverAudience(ctx: AppContext, agent: AgentRow): string[] {
  return [...new Set([agent.ownerHumanId, ...orgEmailApprovers(ctx, agent.orgId)])];
}

/** The actor for an email's sender party — a contact, or the principal it resolved to. */
export function partyActor(
  ctx: AppContext,
  party: Party,
): { kind: ActivityActorKind; principalId?: string | null; contactId?: string | null; label: string } {
  const id = party.principalId ?? null;
  if (id?.startsWith('usr_')) {
    const human = ctx.db.select().from(humans).where(eq(humans.id, id)).get();
    return { kind: 'human', principalId: id, label: human?.displayName ?? party.email };
  }
  if (id?.startsWith('agt_')) {
    const agent = ctx.db.select().from(agents).where(eq(agents.id, id)).get();
    return { kind: 'agent', principalId: id, label: agent?.name ?? party.email };
  }
  return {
    kind: 'contact',
    contactId: party.contactId ?? null,
    label: party.name || party.email,
  };
}

/** The agent itself as an actor (outbound entries). */
function agentActor(agent: AgentRow): {
  kind: ActivityActorKind;
  principalId: string;
  label: string;
} {
  return { kind: 'agent', principalId: agent.id, label: agent.name };
}

/**
 * Record ONE email outcome: the activity entry its disposition calls for, plus
 * the `/me/events` fan-out. Called by the inbound pipeline, the outbound
 * pipeline, and the approve/deny verbs — one place, so an outcome can never
 * journal an entry without emitting its event (or the reverse).
 */
export function announceEmail(
  ctx: AppContext,
  input: {
    agent: AgentRow;
    thread: EmailThreadRow;
    email: EmailRow;
    /** An explicit resolution turns this into an `email.resolved` announcement too. */
    resolution?: EmailResolution;
    /** The human who resolved it; null for a judge verdict or a send failure. */
    by?: { id: string; displayName: string } | null;
  },
): void {
  const { agent, thread, email } = input;
  const preview = toEmailPreview(ctx, email);
  const threadRef = toThreadRef(thread);
  const participants = parseParticipants(email.participants);
  const inbound = email.direction === 'in';
  const sender = inbound ? partyActor(ctx, participants.from) : agentActor(agent);
  // UNTRUSTED sender (quarantined/rejected inbound): freeze the raw ADDRESS as
  // the label, never the self-chosen display name — an attacker could name
  // themselves after the org's owner (Jake's ruling, 2026-09-02). A sender that
  // resolved to a workspace principal keeps its principal label (ours, safe).
  const untrustedSender =
    sender.kind === 'contact' ? { ...sender, label: participants.from.email } : sender;
  const reason = (email.reason as EmailReason | null) ?? null;
  const refs = { emailThreadId: thread.id, emailId: email.id };
  const base = {
    orgId: agent.orgId,
    agentId: agent.id,
    medium: 'email' as const,
    summary: email.subject,
    refs,
  };

  switch (email.disposition) {
    case 'delivered':
      appendActivity(ctx, { ...base, type: 'email.received', actor: sender });
      ctx.bus.publish('agent', agent.id, 'email.received', {
        email: preview,
        thread: threadRef,
      });
      break;
    case 'sent':
      appendActivity(ctx, { ...base, type: 'email.sent', actor: agentActor(agent) });
      ctx.bus.publish('agent', agent.id, 'email.sent', { email: preview, thread: threadRef });
      break;
    case 'quarantined':
      appendActivity(ctx, { ...base, type: 'email.quarantined', actor: untrustedSender });
      for (const humanId of approverAudience(ctx, agent)) {
        ctx.bus.publish('human', humanId, 'email.quarantined', {
          email: preview,
          thread: threadRef,
          agent: { id: agent.id, name: agent.name },
          reason: reason ?? 'unrecognized-sender',
        });
      }
      break;
    case 'held':
      appendActivity(ctx, { ...base, type: 'email.held', actor: agentActor(agent) });
      for (const humanId of approverAudience(ctx, agent)) {
        ctx.bus.publish('human', humanId, 'email.held', {
          email: preview,
          thread: threadRef,
          agent: { id: agent.id, name: agent.name },
          reason: reason ?? 'unrecognized-recipient',
        });
      }
      break;
    case 'rejected':
      // `email.rejected` covers refusals only — virus, blocked, spoof, spam,
      // policy, judge, deny. A relay that failed is a `send-failed` resolution,
      // not a refusal, and journals `email.resolved` alone (Entry types registry).
      appendActivity(ctx, { ...base, type: 'email.rejected', actor: untrustedSender });
      // A refusal is a security record: no body, no preview — it is read
      // deliberately, never pushed.
      for (const humanId of approverAudience(ctx, agent)) {
        ctx.bus.publish('human', humanId, 'email.rejected', {
          agentId: agent.id,
          from: participants.from,
          direction: inbound ? 'in' : 'out',
          reason: reason ?? 'unrecognized-sender',
        });
      }
      break;
  }

  if (input.resolution) {
    const by = input.by ?? null;
    appendActivity(ctx, {
      ...base,
      type: 'email.resolved',
      actor: by
        ? { kind: 'human', principalId: by.id, label: by.displayName }
        : { kind: 'system', label: 'sparrow' },
    });
    const payload = {
      email: preview,
      thread: threadRef,
      resolution: input.resolution,
      by,
    };
    for (const humanId of approverAudience(ctx, agent)) {
      ctx.bus.publish('human', humanId, 'email.resolved', payload);
    }
    // The agent hears a resolution only for mail it can SEE: its own outbound
    // rows (whatever their fate) and inbound that ended `delivered`. A DENIED
    // inbound email never existed for the agent — the preview's subject/sender
    // must not reach its journal through the resolution side door.
    if (!inbound || email.disposition === 'delivered') {
      ctx.bus.publish('agent', agent.id, 'email.resolved', payload);
    }
  }
}
