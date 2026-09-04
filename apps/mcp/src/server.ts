/**
 * The sparrow MCP server: thin, agent-friendly wrappers over `@sparrow/client`,
 * exposed as MCP tools over stdio.
 *
 * `createMcpServer` builds an `McpServer` bound to a mutable client + a default
 * room/org. Every tool returns concise JSON in `content[0].text`; API errors
 * (`ApiError`) become MCP tool errors (`isError: true`) rather than crashes.
 *
 * Addressing: an agent key (`agk_`) spans all of the agent's room memberships,
 * so room-scoped tools take a `roomId` — the configured `SPARROW_ROOM` by default,
 * overridable per call (e.g. the DM room `ensure_dm` just returned).
 */
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SparrowClient, ApiError, clientBuildVersion } from '@sparrow/client';
import { deriveDefaultAgentName } from '@sparrow/common-types/identity';
import {
  EMAIL_REGISTER_NOTE,
  VOICE_REGISTER_NOTE,
  type AttachmentInput,
  type Email,
} from '@sparrow/common-types';
import { upsertDefaultProfile, defaultProfileNote, type Profile } from './credentials.js';

export type Env = Record<string, string | undefined>;

export interface McpServerDeps {
  /** Initial server origin, e.g. `http://localhost:8722`. */
  server: string;
  /** Initial credential: an `agk_` agent key (or a `ses_` session token). */
  token?: string;
  /** Default room id for room-scoped tools (from `SPARROW_ROOM`). */
  roomId?: string;
  /** Default org id for org-scoped tools (from `SPARROW_ORG`). */
  orgId?: string;
  /** Environment used for credential-store reads/writes (defaults to process.env). */
  env?: Env;
  /** Working directory for name derivation and attachment saving. */
  cwd?: string;
}

/**
 * The email medium's tools, in the spec's order: the six agent surfaces, then
 * the three approval tools that are the OWNING HUMAN's. Registered
 * UNCONDITIONALLY — an instance without the medium still lists them and reports
 * {@link EMAIL_OFF_MESSAGE} when one is called, so an agent learns the truth
 * from an answer rather than from a `404`.
 */
export const EMAIL_TOOL_NAMES = [
  'get_email_address',
  'list_email_threads',
  'read_email',
  'reply_email',
  'send_email',
  'get_email_attachment',
  'list_email_approvals',
  'approve_email',
  'deny_email',
] as const;

/** Every tool this server exposes (stable order for `tools/list`). */
export const TOOL_NAMES = [
  'enroll',
  'list_members',
  'get_member',
  'send_message',
  'list_inbox',
  'pop_next_work_item',
  'list_activity',
  'pop_next_message',
  'read_message',
  'list_outbox',
  'get_message_status',
  'get_attachment',
  'set_status',
  'ensure_dm',
  ...EMAIL_TOOL_NAMES,
] as const;

/* ---------------------------- email descriptions -------------------------- */

/**
 * What every email tool answers on an instance running without the medium. The
 * routes `404`, but a bare "not found" reads as a missing thread — this says
 * the medium itself is absent.
 */
export const EMAIL_OFF_MESSAGE = 'email is not enabled on this server';

/**
 * Compose an email tool's description: the canonical register paragraph
 * (imported from `@sparrow/common-types`, never retyped, so the MCP
 * descriptions, the onboarding doc and the hint cannot drift) followed by the
 * tool's own paragraph.
 */
function emailDescription(own: string): string {
  return `${EMAIL_REGISTER_NOTE}\n\n${own}`;
}

/**
 * The voice-register sentence every tool that can HAND BACK A MESSAGE carries,
 * verbatim from `@sparrow/common-types` — the same words the CLI prints under a
 * `[voice]` item, the `/docs/api/voice` page serves, SKILL.md states, and the
 * `voice-is-a-different-register` hint delivers. A message with
 * `origin: 'voice'` came out of hands-free mode: the sender dictated it and is
 * listening, so the reply is read back to them by a speech voice.
 *
 * Only the message-returning tools get it. On a listing or a read-receipt tool
 * it would be noise in a description the model has to parse on every call.
 */
const VOICE_NOTE = `When a message carries origin 'voice': ${VOICE_REGISTER_NOTE}`;

/** The shared paragraph on all three approval tools (SPEC, MCP chapter). */
const APPROVAL_NOTE =
  "The owning human's queue: inbound mail from senders the org does not recognize " +
  '(quarantined) and outbound mail to recipients it does not recognize (held). Approving ' +
  'is DURABLE — it trusts the thread and, unless `trustSender:false`, the other party for ' +
  'good; denying can block that contact permanently. Human credentials only.';

/* ---------------------------- content-type helpers ------------------------ */

const CONTENT_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.js': 'text/javascript',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

/** Minimal content-type inference from a filename extension. */
function inferContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Whether attachment bytes of this content type are safe to inline as text. */
function isTextual(contentType: string): boolean {
  const ct = contentType.split(';')[0]!.trim().toLowerCase();
  return ct.startsWith('text/') || ct === 'application/json' || ct.endsWith('+json');
}

/* ---------------------------- result helpers ------------------------------ */

function ok(data: unknown): CallToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}

function fail(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }, null, 2) }],
    isError: true,
  };
}

/** Run a tool body, mapping ApiError (and any throw) to an isError result. */
async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApiError) return fail(String(e.code), e.message);
    return fail('internal', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Parse an invite target: a full invite URL (`{BASE_URL}/invite/<token>`, the
 * server origin taken from it) or a bare `ivk_` token with the configured
 * server.
 */
function parseInviteTarget(input: {
  url: string;
  fallbackServer: string;
}): { token: string; server: string } {
  const raw = input.url.trim();
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    const m = url.pathname.match(/\/invite\/([^/]+)\/?$/);
    if (!m) {
      throw new ApiError({
        code: 'bad_request',
        status: 400,
        message: `Not an invite URL (expected {host}/invite/<token>): ${input.url}`,
      });
    }
    return { token: decodeURIComponent(m[1]!), server: url.origin };
  }
  // A bare token — must have a configured server to enroll against.
  return { token: raw, server: input.fallbackServer };
}

/* ---------------------------- server factory ------------------------------ */

/** The MCP server's `X-Sparrow-Client` self-identification (e.g. `sparrow-mcp/0.1.0+…`). */
const MCP_CLIENT_IDENT = `sparrow-mcp/${clientBuildVersion()}`;

export function createMcpServer(deps: McpServerDeps): McpServer {
  const env: Env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();

  // Mutable state so `enroll` can switch the live server/token and adopt the
  // owner DM room + org that approval delivers.
  const state = {
    client: new SparrowClient({
      server: deps.server,
      token: deps.token,
      clientIdent: MCP_CLIENT_IDENT,
    }),
    roomId: deps.roomId,
    orgId: deps.orgId,
  };

  /** Resolve the room for a room-scoped tool: an explicit arg, else the default. */
  function resolveRoom(roomId?: string): string {
    const room = (roomId && roomId.trim() !== '' ? roomId : undefined) ?? state.roomId;
    if (!room) {
      throw new ApiError({
        code: 'bad_request',
        status: 400,
        message:
          'No room selected. Set SPARROW_ROOM for this MCP server, or pass `roomId` ' +
          '(e.g. the DM room id from ensure_dm).',
      });
    }
    return room;
  }

  /**
   * Servers already observed to have the email medium ON. Only the positive
   * answer is cached: a medium that gets configured mid-session must be able to
   * come alive, while one already alive never goes back off in practice.
   */
  const emailOn = new Set<string>();

  /**
   * Gate every email tool on `GET /capabilities` rather than on a route's
   * `404`, so "the medium is absent" and "that thread does not exist" stay
   * distinguishable: this throws {@link EMAIL_OFF_MESSAGE}, a genuine 404 still
   * surfaces as `not_found`.
   */
  async function requireEmail(): Promise<void> {
    const origin = state.client.server;
    if (emailOn.has(origin)) return;
    const caps = await state.client.getCapabilities();
    if (!caps.email) {
      throw new ApiError({ code: 'email_disabled', status: 404, message: EMAIL_OFF_MESSAGE });
    }
    emailOn.add(origin);
  }

  /**
   * The approval tools are the OWNING HUMAN's surface. An `agk_` credential is
   * an agent — refused here rather than at the API, so the message can say why.
   */
  function requireHumanCredential(): void {
    if ((state.client.token ?? '').startsWith('agk_')) {
      throw new ApiError({
        code: 'forbidden',
        status: 403,
        message:
          'The email approvals queue is the owning human\'s surface and needs a human session ' +
          'credential (ses_…): an agent never approves the mail addressed to it. Ask your owner ' +
          'to decide, or run this MCP server with a human session token.',
      });
    }
  }

  /** Resolve the org for an org-scoped email tool: an explicit arg, else SPARROW_ORG. */
  function resolveOrg(orgId?: string): string {
    const org = (orgId && orgId.trim() !== '' ? orgId : undefined) ?? state.orgId;
    if (!org) {
      throw new ApiError({
        code: 'bad_request',
        status: 400,
        message:
          'The email approvals queue is an org surface and no org is selected. Set SPARROW_ORG ' +
          'for this MCP server, or pass `orgId`.',
      });
    }
    return org;
  }

  /** Read `{ path }` entries off disk into base64 attachment inputs. */
  function readAttachments(
    inputs?: { path: string }[],
  ): AttachmentInput[] | undefined {
    if (!inputs || inputs.length === 0) return undefined;
    return inputs.map((a) => {
      const abs = path.resolve(cwd, a.path);
      const bytes = fs.readFileSync(abs);
      const filename = path.basename(abs);
      return {
        filename,
        contentType: inferContentType(filename),
        dataBase64: bytes.toString('base64'),
      };
    });
  }

  const server = new McpServer(
    { name: 'sparrow', version: clientBuildVersion() },
    { capabilities: { tools: {} } },
  );

  const attachmentsArg = z
    .array(z.object({ path: z.string().describe('Path to a file on disk to attach.') }))
    .optional()
    .describe('Files to attach (read from disk, up to 8, 5 MB each, 20 MB total).');

  const roomIdArg = z
    .string()
    .optional()
    .describe('Room id to act in; defaults to the configured room (SPARROW_ROOM).');

  /* -------- enroll -------- */
  server.registerTool(
    'enroll',
    {
      title: 'Enroll into an org by invite (become an agent)',
      description:
        'Follow a sparrow invite URL ({host}/invite/<token>) to enroll as a new agent in the ' +
        "inviter's org. If the org admits agents instantly you are minted right away; " +
        'otherwise your request is held for a human to approve, and this tool polls for up to ' +
        '`waitSeconds` (default 60). On approval it SAVES the issued agent key as a named ' +
        'credential profile (~/.config/sparrow/credentials.json), switches this MCP session to ' +
        'the new key, and adopts the owner DM room + org so you can immediately message your ' +
        'owner. One machine can host several agents under one unix user sharing that one ' +
        'credentials file, so `defaultProfile` is NOT moved by default: it changes only when ' +
        'there is no default yet, when you pass `set_default`, when the name already IS the ' +
        'default, or when the stored default is dangling. The result carries `profile`, ' +
        '`defaultProfile`, `defaultProfileChanged` and a `note` saying what happened. If still pending when the wait elapses it returns `status:"pending"` — approval ' +
        'can take minutes to hours; call enroll again with the same URL later to keep waiting ' +
        '(the request persists on the server). `name` defaults to `{host}-{folder}` for this ' +
        'working directory (lowercased and slugified — a sparrow name is email-safe by ' +
        'construction, so it can become your address when the email medium is enabled).',
      inputSchema: {
        url: z.string().describe('The invite URL like https://host/invite/<token> (or a bare ivk_ token).'),
        name: z
          .string()
          .optional()
          .describe('Proposed agent name; defaults to {host}-{folder} for this working dir.'),
        note: z.string().optional().describe('A note shown to approvers with your request.'),
        waitSeconds: z
          .number()
          .int()
          .min(0)
          .max(600)
          .optional()
          .describe('Max seconds to poll for approval before returning pending (default 60).'),
        set_default: z
          .boolean()
          .optional()
          .describe(
            'Also make the saved profile the default for bare commands (default false). ' +
              'Leave it off on a machine shared with other agents: an existing default is ' +
              'kept, and you address this profile with --profile/SPARROW_PROFILE.',
          ),
      },
    },
    (args) =>
      guard(async () => {
        const { token: inviteToken, server: targetServer } = parseInviteTarget({
          url: args.url,
          fallbackServer: state.client.server,
        });
        const name = args.name ?? deriveDefaultAgentName(cwd);
        const client = new SparrowClient({ server: targetServer, clientIdent: MCP_CLIENT_IDENT });

        // Persist the minted key + switch the live client to the new agent.
        const admit = (
          agent: { id: string; name: string; orgId: string },
          key: string,
          org: { id: string; name: string },
          dmRoomId: string,
        ) => {
          const profile: Profile = { server: targetServer, token: key, kind: 'agent' };
          const saved = upsertDefaultProfile(env, agent.name, profile, {
            setDefault: args.set_default === true,
          });
          client.setToken(key);
          state.client = client;
          state.roomId = dmRoomId;
          state.orgId = org.id;
          return ok({
            status: 'approved',
            agent: { id: agent.id, name: agent.name, orgId: agent.orgId },
            org,
            dmRoomId,
            profile: saved.name,
            defaultProfile: saved.defaultProfile,
            defaultProfileChanged: saved.changed,
            note: defaultProfileNote(saved),
          });
        };

        const enrolled = await client.enrollAgent(inviteToken, { name, note: args.note });
        if (enrolled.status === 'admitted') {
          return admit(enrolled.agent, enrolled.key, enrolled.org, enrolled.dmRoomId);
        }

        // Held: poll up to waitSeconds (honoring retryAfterSeconds), then report.
        const waitMs = (args.waitSeconds ?? 60) * 1000;
        const deadline = Date.now() + waitMs;
        for (;;) {
          const poll = await client.pollEnrollment(inviteToken, enrolled.enrollment.id, {
            enrollmentToken: enrolled.enrollmentToken,
          });
          if (poll.status === 'approved') {
            // An agent enrollment always carries key/org/dmRoomId on first approval.
            if ('key' in poll && poll.key) {
              return admit(poll.agent, poll.key, poll.org, poll.dmRoomId);
            }
            return ok({
              status: 'approved',
              message:
                'Enrollment approved but the one-time key was already delivered. Reuse the ' +
                'saved credential profile.',
            });
          }
          if (poll.status === 'denied') {
            return ok({ status: 'denied', enrollmentId: enrolled.enrollment.id });
          }
          if (Date.now() >= deadline) {
            return ok({
              status: 'pending',
              enrollment: { id: enrolled.enrollment.id, status: 'pending' },
              message:
                'Still awaiting approval. Call enroll again with the same URL later to keep ' +
                'waiting; the request persists on the server.',
            });
          }
          const overrideMs = env.SPARROW_POLL_INTERVAL_MS
            ? Number.parseInt(env.SPARROW_POLL_INTERVAL_MS, 10)
            : undefined;
          const stepMs = overrideMs ?? poll.retryAfterSeconds * 1000;
          const remaining = deadline - Date.now();
          await new Promise((r) => setTimeout(r, Math.max(Math.min(stepMs, remaining), 10)));
        }
      }),
  );

  /* -------- list_members -------- */
  server.registerTool(
    'list_members',
    {
      title: 'List room members',
      description:
        'List the members (humans and agents) of a room, including yourself. Use this to ' +
        'discover who you can message and their member ids.',
      inputSchema: {
        roomId: roomIdArg,
        limit: z.number().int().positive().max(100).optional().describe('Max members to return.'),
      },
    },
    (args) =>
      guard(async () => {
        const res = await state.client.listMembers(resolveRoom(args.roomId), { limit: args.limit });
        return ok(res.items);
      }),
  );

  /* -------- get_member -------- */
  server.registerTool(
    'get_member',
    {
      title: 'Get one member',
      description:
        'Fetch a single room member by member id (mem_…) or by principal id (agt_…/usr_…). ' +
        'Use this to resolve or confirm a recipient before messaging.',
      inputSchema: {
        roomId: roomIdArg,
        id: z.string().describe('A member id (mem_…) or a principal id (agt_…/usr_…).'),
      },
    },
    (args) =>
      guard(async () => {
        const member = await state.client.getMember(resolveRoom(args.roomId), args.id);
        return ok(member);
      }),
  );

  /* -------- send_message -------- */
  server.registerTool(
    'send_message',
    {
      title: 'Send a message',
      description:
        'Send a direct message (to a member id or principal id) or a broadcast (to = "all") in ' +
        'a room. Optionally attach files from disk by path; each is read, base64-encoded, and ' +
        'its content type inferred from the extension. You cannot send to yourself.\n\n' +
        'When you ask a human a question that has a small set of closable answers (yes/no, ' +
        'pick-one, approve/reject), offer 1–4 `suggestedReplies` so they can answer with one ' +
        'tap: each is a `{ label, value? }` where `label` is shown to the human and `value` is ' +
        'the machine-readable answer (defaults to the label). Suggestions accelerate but never ' +
        'constrain — a freeform reply is always possible.\n\n' +
        'When you are ANSWERING a message that asked such a question, set `inReplyTo` to that ' +
        "message's id and `replyValue` to the chosen value, so the asker can match your answer " +
        'structurally instead of parsing your prose. You may only reply to a message you can read.',
      inputSchema: {
        roomId: roomIdArg,
        to: z
          .string()
          .describe('Recipient: a member id, a principal id (agt_…/usr_…), or "all" to broadcast.'),
        body: z.string().describe('Message body text.'),
        subject: z.string().optional().describe('Optional subject line.'),
        attachments: attachmentsArg,
        suggestedReplies: z
          .array(
            z.object({
              label: z.string().min(1).max(60).describe('Shown to the human (1–60 chars).'),
              value: z
                .string()
                .max(200)
                .optional()
                .describe('Machine-readable answer (≤200 chars; defaults to the label).'),
            }),
          )
          .min(1)
          .max(4)
          .optional()
          .describe('1–4 one-tap reply options offered when you ask a closable question.'),
        inReplyTo: z
          .string()
          .optional()
          .describe('When answering a question, the message id you are replying to (must be readable).'),
        replyValue: z
          .string()
          .optional()
          .describe('The chosen answer value; only valid alongside inReplyTo.'),
      },
    },
    (args) =>
      guard(async () => {
        const attachments = readAttachments(args.attachments);
        const res = await state.client.sendMessage(resolveRoom(args.roomId), {
          to: args.to,
          subject: args.subject,
          body: args.body,
          attachments,
          suggestedReplies: args.suggestedReplies,
          inReplyTo: args.inReplyTo,
          replyValue: args.replyValue,
        });
        return ok(res);
      }),
  );

  /* -------- list_inbox -------- */
  server.registerTool(
    'list_inbox',
    {
      title: 'List inbox (triage previews across mediums)',
      description:
        'List your waiting work as truncated previews for triage, oldest first — unread only ' +
        'by default, or everything with all=true. This is NOT room-scoped: it is the list ' +
        'counterpart of pop_next_work_item and spans every room you are in and (once the ' +
        'medium is enabled) your email, so items are a union discriminated by `type`: a ' +
        '`chat.message` item carries its `room`, an `email` item its `thread`. Switch on ' +
        '`type` and IGNORE any type you do not recognize. Previews are the first ~200 chars; ' +
        'use read_message / read_email for full bodies and attachment ids, and note that ' +
        'listing never marks anything read.',
      inputSchema: {
        medium: z
          .enum(['chat', 'email'])
          .optional()
          .describe('Narrow to one medium; omit for everything.'),
        org: z.string().optional().describe('Restrict to one org (org_…); omit for all of them.'),
        all: z.boolean().optional().describe('Include already-read items (default false).'),
        limit: z.number().int().positive().max(100).optional().describe('Max items to return.'),
      },
    },
    (args) =>
      guard(async () => {
        const res = await state.client.meInbox({
          medium: args.medium,
          org: args.org ?? state.orgId,
          all: args.all,
          limit: args.limit,
        });
        return ok(res.items);
      }),
  );

  /* -------- pop_next_work_item -------- */
  server.registerTool(
    'pop_next_work_item',
    {
      title: 'Pop the next work item (any medium)',
      description:
        'Atomically take the oldest unread WORK ITEM across every medium and every room you ' +
        'belong to, marking it read. This is the ONE queue an agent runtime drains — do not ' +
        'poll a chat inbox and a mail inbox separately. Returns ' +
        '{ item: { type: "chat.message", message, room } | { type: "email", email, thread } | ' +
        'null }; `item` is null when nothing is waiting (not an error). ' +
        'SWITCH ON `type`: the payload shape differs per medium, and a `type` you do not ' +
        'recognize is a medium newer than you — leave it alone and carry on, never treat an ' +
        'unknown type as an error. Pass ack=true to advertise a "working" status scoped to a ' +
        "chat sender (it auto-expires; `note` sets its text); on an email item ack does " +
        'nothing at all — there is no room to scope to, and the honest way to acknowledge mail ' +
        'is to answer it. Use pop_next_message instead only if you work exactly one room. ' +
        VOICE_NOTE,
      inputSchema: {
        ack: z
          .boolean()
          .optional()
          .describe('For a chat item, advertise "working" scoped to the sender (auto-expires).'),
        note: z.string().optional().describe('Note for the ack status (default: reading your message).'),
      },
    },
    (args) =>
      guard(async () => {
        const res = await state.client.meInboxPop(
          args.ack ? { ack: true, note: args.note } : undefined,
        );
        // An unrecognized medium is data, not a failure: hand it back verbatim so
        // the caller can log and leave it.
        if (res.unknownItem) return ok({ item: res.unknownItem, unrecognizedType: true });
        return ok(res.hints ? { item: res.item, hints: res.hints } : { item: res.item });
      }),
  );

  /* -------- list_activity -------- */
  server.registerTool(
    'list_activity',
    {
      title: 'The interleaved activity timeline',
      description:
        'The interleaved timeline of everything involving you across both mediums, newest ' +
        'first — chat messages and email in one chronological list, so you can see that the ' +
        'room question and the customer\'s email are about the same thing. Entries are typed ' +
        'REFERENCES, not bodies: fetch bodies with read_message / read_email (and tolerate a ' +
        '404 there — render from `summary` alone). Ignore any entry whose `type` or `medium` ' +
        'you do not recognize. Reading a timeline changes nothing: entries are never marked ' +
        'read and never popped. Pass an `agentId` (owners and org admins only) to watch one ' +
        'agent.',
      inputSchema: {
        agentId: z
          .string()
          .optional()
          .describe("Watch one agent's timeline (agt_…); owners and org admins only."),
        orgId: z
          .string()
          .optional()
          .describe('Org for the agent lookup / scope (defaults to SPARROW_ORG).'),
        medium: z.enum(['chat', 'email', 'voice']).optional().describe('Narrow to one medium.'),
        limit: z.number().int().positive().max(100).optional().describe('Max entries to return.'),
        before: z
          .string()
          .optional()
          .describe('Read older entries: an entry id (act_…); only entries strictly older come back.'),
      },
    },
    (args) =>
      guard(async () => {
        if (args.agentId) {
          const orgId = args.orgId ?? state.orgId;
          if (!orgId) {
            throw new ApiError({
              code: 'bad_request',
              status: 400,
              message:
                "Reading another agent's timeline needs an org. Set SPARROW_ORG for this MCP " +
                'server, or pass `orgId`.',
            });
          }
          const res = await state.client.agentActivity(orgId, args.agentId, {
            medium: args.medium,
            limit: args.limit,
            before: args.before,
          });
          // Envelope, not a bare array: nextBefore is the only way a caller can
          // page — matching list_email_threads.
          return ok({ items: res.items, nextBefore: res.nextBefore ?? null });
        }
        const res = await state.client.meActivity({
          org: args.orgId ?? state.orgId,
          medium: args.medium,
          limit: args.limit,
          before: args.before,
        });
        return ok({ items: res.items, nextBefore: res.nextBefore ?? null });
      }),
  );

  /* -------- pop_next_message -------- */
  server.registerTool(
    'pop_next_message',
    {
      title: 'Pop next unread message (one room)',
      description:
        'Atomically take the oldest unread message IN ONE ROOM, returning its full content and ' +
        'marking it read. Returns null when that room has no unread messages. Room-scoped by ' +
        'design, for an agent that works exactly one room; an agent runtime that should see ' +
        'every room (and, once enabled, its mail) drains pop_next_work_item instead. ' +
        'Pass ack=true to immediately advertise a "working" status scoped to that message\'s ' +
        "sender (so they see you're on their reply); it auto-expires. `note` sets that status " +
        'note (defaults to "reading your message"). ' +
        VOICE_NOTE,
      inputSchema: {
        roomId: roomIdArg,
        ack: z
          .boolean()
          .optional()
          .describe('After popping, advertise "working" scoped to the sender (auto-expires).'),
        note: z.string().optional().describe('Note for the ack status (default: reading your message).'),
      },
    },
    (args) =>
      guard(async () => {
        const msg = await state.client.popNextMessage(
          resolveRoom(args.roomId),
          args.ack ? { ack: true, note: args.note } : undefined,
        );
        return ok({ message: msg });
      }),
  );

  /* -------- read_message -------- */
  server.registerTool(
    'read_message',
    {
      title: 'Read a message by id',
      description:
        'Fetch the full content of a message by id. By default this marks it read for you; ' +
        'pass peek=true to read without changing its read state. ' +
        VOICE_NOTE,
      inputSchema: {
        roomId: roomIdArg,
        messageId: z.string().describe('The message id (msg_…).'),
        peek: z.boolean().optional().describe('Do not mark the message read (default false).'),
      },
    },
    (args) =>
      guard(async () => {
        const msg = await state.client.readMessage(resolveRoom(args.roomId), args.messageId, {
          peek: args.peek,
        });
        return ok(msg);
      }),
  );

  /* -------- list_outbox -------- */
  server.registerTool(
    'list_outbox',
    {
      title: 'List sent messages',
      description:
        'List full messages you have sent in a room, oldest first. Use get_message_status to ' +
        'see per-recipient read receipts.',
      inputSchema: {
        roomId: roomIdArg,
        limit: z.number().int().positive().max(100).optional().describe('Max items to return.'),
      },
    },
    (args) =>
      guard(async () => {
        const res = await state.client.listOutbox(resolveRoom(args.roomId), { limit: args.limit });
        return ok(res.items);
      }),
  );

  /* -------- get_message_status -------- */
  server.registerTool(
    'get_message_status',
    {
      title: 'Get message read status',
      description:
        'Show per-recipient read status (read/unread + timestamps) for a message you sent or ' +
        'received. Use this to check whether a recipient has read your message.',
      inputSchema: {
        roomId: roomIdArg,
        messageId: z.string().describe('The message id (msg_…).'),
      },
    },
    (args) =>
      guard(async () => {
        const status = await state.client.getMessageStatus(resolveRoom(args.roomId), args.messageId);
        return ok(status);
      }),
  );

  /* -------- get_attachment -------- */
  server.registerTool(
    'get_attachment',
    {
      title: 'Download an attachment',
      description:
        'Download a message attachment by id. If it is textual (text/* or JSON) and no ' +
        'savePath is given, the content is returned inline as text. Otherwise (binary, or when ' +
        'savePath is set) the bytes are written to disk and the absolute file path is returned. ' +
        'Default save location is the original filename in the working directory.',
      inputSchema: {
        roomId: roomIdArg,
        attachmentId: z.string().describe('The attachment id (att_…).'),
        savePath: z
          .string()
          .optional()
          .describe('Where to write the bytes; forces saving even for text.'),
      },
    },
    (args) =>
      guard(async () => {
        const dl = await state.client.getAttachment(resolveRoom(args.roomId), args.attachmentId);
        const inline = isTextual(dl.contentType) && !args.savePath;
        if (inline) {
          return ok({
            attachmentId: args.attachmentId,
            filename: dl.filename,
            contentType: dl.contentType,
            sizeBytes: dl.bytes.length,
            content: Buffer.from(dl.bytes).toString('utf8'),
          });
        }
        const outPath = args.savePath
          ? path.resolve(cwd, args.savePath)
          : path.resolve(cwd, dl.filename);
        fs.writeFileSync(outPath, dl.bytes);
        return ok({
          attachmentId: args.attachmentId,
          filename: dl.filename,
          contentType: dl.contentType,
          sizeBytes: dl.bytes.length,
          savedTo: outPath,
        });
      }),
  );

  /* -------- set_status -------- */
  server.registerTool(
    'set_status',
    {
      title: 'Set your working status',
      description:
        'Advertise a transient status so humans (and other agents) know a reply is in progress. ' +
        "Call with state='working' before starting a long task so the human sees you're on it; " +
        'it auto-expires (default 60s, max 600), so refresh it for long work. Add a short `note` ' +
        '(≤140 chars) describing what you are doing. Scope it to one recipient with `to` (a ' +
        'member id or principal id) to mean "working on a reply to you"; omit `to` for room-wide ' +
        "presence. Call with state='idle' to clear it when done (optionally narrowing to one `to`).",
      inputSchema: {
        roomId: roomIdArg,
        state: z.enum(['working', 'idle']).describe("'working' to advertise, 'idle' to clear."),
        note: z.string().max(140).optional().describe('Short note shown with the indicator (≤140 chars).'),
        to: z
          .string()
          .optional()
          .describe('Scope to one recipient (member id or principal id); omit for room-wide.'),
        ttlSeconds: z
          .number()
          .int()
          .min(1)
          .max(600)
          .optional()
          .describe('Seconds until it auto-expires (1-600, default 60).'),
      },
    },
    (args) =>
      guard(async () => {
        const status = await state.client.setStatus(resolveRoom(args.roomId), {
          state: args.state,
          note: args.note,
          to: args.to,
          ttlSeconds: args.ttlSeconds,
        });
        return ok({ status });
      }),
  );

  /* -------- ensure_dm -------- */
  server.registerTool(
    'ensure_dm',
    {
      title: 'Ensure a direct-message room with a principal',
      description:
        'Ensure (create-or-fetch) the direct-message room between you and another principal — a ' +
        'human (usr_…) or an agent (agt_…), e.g. your owner. Idempotent: it returns the same DM ' +
        'room every time. Use the returned room id as `roomId` for send_message / pop_next_message ' +
        'to hold a private conversation. `orgId` is only needed when you and the principal share ' +
        'more than one org (defaults to the configured SPARROW_ORG).',
      inputSchema: {
        principal: z.string().describe('The other principal: a human id (usr_…) or agent id (agt_…).'),
        orgId: z
          .string()
          .optional()
          .describe('Org id when the pair shares more than one org (defaults to SPARROW_ORG).'),
      },
    },
    (args) =>
      guard(async () => {
        const res = await state.client.ensureDm({
          principal: args.principal,
          orgId: args.orgId ?? state.orgId,
        });
        return ok(res);
      }),
  );

  /* ======================================================================== *
   * The email medium
   *
   * Registered unconditionally (SPEC, MCP chapter): an instance without the
   * medium still lists these and answers EMAIL_OFF_MESSAGE. Every description
   * OPENS with the canonical register paragraph, because the single most
   * expensive mistake an agent makes here is writing chat into a mail client.
   * ======================================================================== */

  /* -------- get_email_address -------- */
  server.registerTool(
    'get_email_address',
    {
      title: 'Get your own email address',
      description: emailDescription(
        'Return your own email address and whether the email medium is enabled on this ' +
          'instance. Your address is `<your-name>@<org-slug><suffix>`; it is derived from your ' +
          'name, so renaming yourself CHANGES your address and the old one stops working — tell ' +
          'anyone who writes to you before you rename.',
      ),
      inputSchema: {},
    },
    () =>
      guard(async () => {
        await requireEmail();
        const res = await state.client.meEmailAddress();
        return ok({ ...res, enabled: true });
      }),
  );

  /* -------- list_email_threads -------- */
  server.registerTool(
    'list_email_threads',
    {
      title: 'List your email threads',
      description: emailDescription(
        'List your email threads, newest first, with subject, the other parties, and when each ' +
          'last moved. This is a triage list, not the mail: use `read_email` for bodies. Threads ' +
          'you have never answered are the ones a human is most likely waiting on.',
      ),
      inputSchema: {
        limit: z.number().int().positive().max(100).optional().describe('Max threads to return.'),
        before: z
          .string()
          .optional()
          .describe(
            'Read older threads: the `nextBefore` of a previous call (a thread id, eth_…); ' +
              'only threads strictly older come back.',
          ),
      },
    },
    (args) =>
      guard(async () => {
        await requireEmail();
        const res = await state.client.listEmailThreads({ limit: args.limit, before: args.before });
        // `nextBefore` is ALWAYS present (null when the list is exhausted): an
        // undefined key would vanish in JSON and strand the caller mid-page.
        return ok({ items: res.items, nextBefore: res.nextBefore });
      }),
  );

  /* -------- read_email -------- */
  server.registerTool(
    'read_email',
    {
      title: 'Read a thread or one email',
      description: emailDescription(
        'Read a whole thread (`eth_…`) as a transcript, or one email (`eml_…`) in full: ' +
          "headers, the sender's authentication result (SPF/DKIM/DMARC), body, and attachment " +
          'ids. Read the WHOLE thread before replying — the sender expects you to remember what ' +
          'they already told you, and quoting the wrong turn reads as carelessness.',
      ),
      inputSchema: {
        id: z.string().describe('A thread id (eth_…) for the transcript, or an email id (eml_…).'),
        peek: z
          .boolean()
          .optional()
          .describe('For an eml_ id: read without marking it read (a thread read is always a peek).'),
        limit: z.number().int().positive().max(100).optional().describe('For an eth_ id: max emails.'),
        cursor: z.string().optional().describe('For an eth_ id: opaque page cursor.'),
      },
    },
    (args) =>
      guard(async () => {
        await requireEmail();
        const id = args.id.trim();
        if (id.startsWith('eth_')) {
          // A thread read is a peek by contract — it writes no read state.
          const res = await state.client.getEmailThread(id, {
            limit: args.limit,
            cursor: args.cursor,
          });
          return ok({ thread: res.thread, emails: res.items, nextCursor: res.nextCursor });
        }
        if (id.startsWith('eml_')) {
          const email = await state.client.readEmail(id, { peek: args.peek });
          return ok({ email });
        }
        throw new ApiError({
          code: 'bad_request',
          status: 400,
          message:
            `Not an email id: ${args.id}. Pass a thread id (eth_…) to read the whole ` +
            'transcript, or an email id (eml_…) to read one message.',
        });
      }),
  );

  /* -------- reply_email -------- */
  server.registerTool(
    'reply_email',
    {
      title: 'Reply inside an email thread',
      description: emailDescription(
        'Reply inside an existing thread. The subject and the recipient set come from the ' +
          'thread; you write the body (`cc` adds people, and everyone already on the thread ' +
          'stays on it). Reply in the register above — full sentences, restated context, no ' +
          'chips. If you need time, say so in a sentence: there is no working status in email, ' +
          'so silence is the only thing the recipient can see.',
      ),
      inputSchema: {
        threadId: z.string().describe('The thread to answer in (eth_…).'),
        text: z.string().describe('The body of your reply — full paragraphs, with a sign-off.'),
        cc: z.array(z.string()).optional().describe('Extra addresses to add to the thread.'),
        attachments: attachmentsArg,
      },
    },
    (args) =>
      guard(async () => {
        await requireEmail();
        const email = await state.client.replyEmail(args.threadId, {
          text: args.text,
          cc: args.cc,
          attachments: readAttachments(args.attachments),
        });
        return ok(emailDispositionResult(email));
      }),
  );

  /* -------- send_email -------- */
  server.registerTool(
    'send_email',
    {
      title: 'Start a new email thread',
      description: emailDescription(
        'Start a NEW email thread: `to` (one or more addresses), `subject`, and a body. ' +
          'Recipients MAY be outside your org — this is the one surface where you can reach a ' +
          'stranger, so write for one: introduce yourself, name the human you work for, and ' +
          'state what you want in the first paragraph. Choose the subject as if it is the only ' +
          'thing that will be read. If any recipient is not already trusted by your org, the ' +
          'mail is HELD for your owning human to approve and the result says so — that is not a ' +
          'failure and must not be retried; you will get an `email.resolved` event when they ' +
          'decide.',
      ),
      inputSchema: {
        to: z.array(z.string()).min(1).describe('One or more recipient addresses.'),
        cc: z.array(z.string()).optional().describe('Addresses to copy.'),
        subject: z.string().describe('The subject line — accurate, and stable for the thread.'),
        text: z.string().describe('The body — greeting, full paragraphs, sign-off.'),
        attachments: attachmentsArg,
      },
    },
    (args) =>
      guard(async () => {
        await requireEmail();
        const res = await state.client.sendEmail({
          to: args.to,
          cc: args.cc,
          subject: args.subject,
          text: args.text,
          attachments: readAttachments(args.attachments),
        });
        return ok({ ...emailDispositionResult(res.email), thread: res.thread });
      }),
  );

  /* -------- get_email_attachment -------- */
  server.registerTool(
    'get_email_attachment',
    {
      title: 'Download an email attachment',
      description: emailDescription(
        'Download an attachment off one of your emails by id (the ids come from `read_email`). ' +
          'If it is textual (text/* or JSON) and no savePath is given, the content is returned ' +
          'inline as text. Otherwise (binary, or when savePath is set) the bytes are written to ' +
          'disk and the absolute file path is returned; the default save location is the ' +
          "original filename in the working directory. The attachment must hang off an email in " +
          'one of your own threads.',
      ),
      inputSchema: {
        attachmentId: z.string().describe('The attachment id (att_…) from read_email.'),
        savePath: z
          .string()
          .optional()
          .describe('Where to write the bytes; forces saving even for text.'),
      },
    },
    (args) =>
      guard(async () => {
        await requireEmail();
        const dl = await state.client.getEmailAttachment(args.attachmentId);
        if (isTextual(dl.contentType) && !args.savePath) {
          return ok({
            attachmentId: args.attachmentId,
            filename: dl.filename,
            contentType: dl.contentType,
            sizeBytes: dl.bytes.length,
            content: Buffer.from(dl.bytes).toString('utf8'),
          });
        }
        const outPath = args.savePath
          ? path.resolve(cwd, args.savePath)
          : path.resolve(cwd, dl.filename);
        fs.writeFileSync(outPath, dl.bytes);
        return ok({
          attachmentId: args.attachmentId,
          filename: dl.filename,
          contentType: dl.contentType,
          sizeBytes: dl.bytes.length,
          savedTo: outPath,
        });
      }),
  );

  /* -------- list_email_approvals -------- */
  server.registerTool(
    'list_email_approvals',
    {
      title: "The owning human's email approvals queue",
      description: emailDescription(
        `${APPROVAL_NOTE} This tool lists the queue for one org, oldest first; filter with ` +
          '`agent` or `direction`, then decide with approve_email / deny_email.',
      ),
      inputSchema: {
        orgId: z.string().optional().describe('Org whose queue to read (defaults to SPARROW_ORG).'),
        agent: z.string().optional().describe("Only one agent's mail (agt_…)."),
        direction: z
          .enum(['in', 'out'])
          .optional()
          .describe("'in' for quarantined inbound, 'out' for held outbound."),
        limit: z.number().int().positive().max(100).optional().describe('Max items to return.'),
        cursor: z.string().optional().describe('Opaque page cursor from a previous call.'),
      },
    },
    (args) =>
      guard(async () => {
        await requireEmail();
        requireHumanCredential();
        const res = await state.client.listEmailApprovals(resolveOrg(args.orgId), {
          agent: args.agent,
          direction: args.direction,
          limit: args.limit,
          cursor: args.cursor,
        });
        return ok({ items: res.items, nextCursor: res.nextCursor });
      }),
  );

  /* -------- approve_email -------- */
  server.registerTool(
    'approve_email',
    {
      title: 'Approve a pending email',
      description: emailDescription(
        `${APPROVAL_NOTE} This tool approves ONE pending email: a quarantined inbound one is ` +
          'delivered, a held outbound one is relayed. Pass `trustSender:false` to let this one ' +
          'email through without trusting the other party for good. An email that is no longer ' +
          'pending is a conflict, not a retry.',
      ),
      inputSchema: {
        emailId: z.string().describe('The pending email to approve (eml_…).'),
        orgId: z.string().optional().describe('Org the email belongs to (defaults to SPARROW_ORG).'),
        trustSender: z
          .boolean()
          .optional()
          .describe('Default true: also trust the other party durably. False = this email only.'),
      },
    },
    (args) =>
      guard(async () => {
        await requireEmail();
        requireHumanCredential();
        const email = await state.client.approveEmail(resolveOrg(args.orgId), args.emailId, {
          trustSender: args.trustSender,
        });
        return ok({ email });
      }),
  );

  /* -------- deny_email -------- */
  server.registerTool(
    'deny_email',
    {
      title: 'Deny a pending email',
      description: emailDescription(
        `${APPROVAL_NOTE} This tool denies ONE pending email: it is dropped (disposition ` +
          '`rejected`, reason `denied`) and never delivered or relayed. Pass `blockSender:true` ' +
          'to block that contact for the org from then on, in both directions. An email that is ' +
          'no longer pending is a conflict, not a retry.',
      ),
      inputSchema: {
        emailId: z.string().describe('The pending email to deny (eml_…).'),
        orgId: z.string().optional().describe('Org the email belongs to (defaults to SPARROW_ORG).'),
        blockSender: z
          .boolean()
          .optional()
          .describe('Block that contact for the org permanently (default false).'),
      },
    },
    (args) =>
      guard(async () => {
        await requireEmail();
        requireHumanCredential();
        const email = await state.client.denyEmail(resolveOrg(args.orgId), args.emailId, {
          blockSender: args.blockSender,
        });
        return ok({ email });
      }),
  );

  return server;
}

/* ---------------------------- email result shaping ------------------------ */

/**
 * Wrap an outbound email so a `held` disposition is impossible to miss. Held is
 * the one outcome an agent is likely to misread as a failure and retry in a
 * loop — so it gets an explicit `held: true` and a sentence saying what to do
 * instead (nothing: wait for `email.resolved`).
 */
function emailDispositionResult(email: Email): Record<string, unknown> {
  const held = email.disposition === 'held';
  return {
    email,
    held,
    ...(held
      ? {
          message:
            'HELD for your owning human to approve, because a recipient is not yet trusted by ' +
            'your org. This is NOT a failure and must not be retried — sending again just adds ' +
            'another held copy. Do not retry; wait for the `email.resolved` event (or a message ' +
            'from your owner) telling you what they decided.',
        }
      : {}),
  };
}
