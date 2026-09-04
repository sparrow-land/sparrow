/**
 * The prompt `sparrow harness` hands a spawned runner.
 *
 * Harness mode inverts inline mode: the agent is a FUNCTION, invoked once per
 * burst of work, with no memory of the harness and no idea why it woke up. So
 * the framing has to do three jobs in the first paragraph — say who the agent
 * is, say where it is, and say what its output MEANS. The third is the one that
 * bites: a coding agent's default register is "report to the developer who ran
 * me", and its default reflex on being told about a chat message is to go send
 * one. Both are wrong here. Its final text is posted verbatim, exactly once, by
 * the harness — so it must write a chat message, and must not send anything.
 *
 * Pure: no clock, no network, no environment. The orchestrator resolves the
 * bodies and hands them over already fetched.
 */

/** The exact sentinel an agent replies with when there is nothing worth posting. */
export const NO_REPLY = '(no reply)';

/** One rendered message — a transcript line or a new item, already resolved to text. */
export interface PromptMessage {
  /** Display name of the sender (`Jake Quist`, `Kim <kim@outside.example>`). */
  from: string;
  /** ISO timestamp, shown verbatim so the agent can reason about gaps. */
  at: string;
  subject?: string | null;
  body: string;
}

/** The conversation the run is about. */
export interface PromptGroup {
  kind: 'chat' | 'email';
  /** `#Product`, `@Jake Quist (dm)`, `“Invoice question”`. */
  label: string;
  /** `project` | `dm` — chat only. */
  roomKind?: string;
  /** The thread subject — email only. */
  subject?: string;
}

export interface BuildPromptInput {
  agent: { name: string; orgName: string };
  group: PromptGroup;
  /** Recent history, oldest first. Empty when `--context 0` or a resumed session. */
  transcript: PromptMessage[];
  /** The items this run must handle, arrival order. */
  messages: PromptMessage[];
}

export interface BuiltPrompt {
  /** The system framing (claude gets this via `--append-system-prompt`). */
  system: string;
  /** Transcript + new messages (every runner gets this as its prompt body). */
  user: string;
  /** `system` then `user` — one blob for runners with no system-prompt channel. */
  combined: string;
}

function where(group: PromptGroup): string {
  if (group.kind === 'email') return `the email thread ${group.label}`;
  if (group.roomKind === 'dm') return `a direct message conversation (${group.label})`;
  return `the room ${group.label}`;
}

function renderMessage(m: PromptMessage): string {
  const head = `[${m.at}] ${m.from}`;
  const subject = m.subject ? `\nSubject: ${m.subject}` : '';
  return `${head}${subject}\n${m.body}`;
}

/** Build the system framing + prompt body for one runner invocation. */
export function buildPrompt(input: BuildPromptInput): BuiltPrompt {
  const { agent, group, transcript, messages } = input;
  const destination =
    group.kind === 'email'
      ? `as a reply in the email thread “${group.subject ?? group.label}”`
      : `into ${group.label}`;

  const system = [
    `You are ${agent.name}, an agent in the ${agent.orgName} organisation on Sparrow.`,
    ``,
    `You are running under \`sparrow harness\`: the Sparrow CLI holds your events stream`,
    `(which is why you are online), and it spawned you just now to handle new work in`,
    `${where(group)}. You are not a resident process — this invocation exists to answer`,
    `the message(s) below, and then it ends.`,
    ``,
    `YOUR FINAL TEXT RESPONSE IS YOUR REPLY. The harness posts it verbatim ${destination},`,
    group.kind === 'email'
      ? `as a message from you. Write it as an email to the sender, who is OUTSIDE ${agent.orgName}:`
      : `as a message from you. Write it as a chat message to the people in that conversation:`,
    group.kind === 'email'
      ? `whole, self-contained, and free of internal shorthand.`
      : `speak to them directly, not about them, and skip the "here is what I did" preamble.`,
    ``,
    `Do not run any \`sparrow\` command to send it — no \`sparrow send\`, no \`sparrow reply\`,`,
    `no MCP send tool. The harness does the sending, so anything you send yourself is posted`,
    `TWICE. If there is nothing worth saying, reply with exactly ${NO_REPLY} and the harness`,
    `posts nothing.`,
    ``,
    `You may use your tools freely to answer well — read the repo, run commands, make the`,
    `change that was asked for — but finish with the message you want the humans to read.`,
  ].join('\n');

  const parts: string[] = [];
  if (transcript.length > 0) {
    parts.push(
      `## Recent conversation in ${group.label} (oldest first, for context)`,
      ``,
      transcript.map(renderMessage).join('\n\n'),
      ``,
    );
  }
  const count = messages.length;
  const heading =
    group.kind === 'email'
      ? `## ${count} new email${count === 1 ? '' : 's'} in ${group.label} — answer ${count === 1 ? 'it' : 'them'}`
      : `## ${count} new message${count === 1 ? '' : 's'} in ${group.label} — answer ${count === 1 ? 'it' : 'them'}`;
  parts.push(heading, ``, messages.map(renderMessage).join('\n\n'));

  const user = parts.join('\n');
  return { system, user, combined: `${system}\n\n${user}` };
}
