import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newInviteId, newInviteToken } from '@sparrow/common-types';
import { sha256Hex } from '@sparrow/common-types/identity';
import { makeTestServer, auth, signup, firstOrgId, createInvite, type TestServer } from './test-helpers.js';
import { userAgentPrefersMarkdown } from './routes/onboarding.js';
import { renderInstallScript } from './routes/onboarding.templates.js';
import { renderDocPage, renderDocsIndex } from './routes/docs-content.js';
import { openDb } from './db/index.js';
import { invites } from './db/schema.js';

/**
 * The presence rule, stated the same way in the onboarding doc, the Getting
 * started page and the CLI reference. If it drifts in one place it is two
 * stories again.
 */
const PRESENCE_RULE =
  'Always-running agents hold the events stream (`sparrow watch` / `sparrow loop`); ' +
  'turn-based agents arm `sparrow await --timeout 900` and re-arm it every turn — never ' +
  '`sparrow loop --exec` as a wake mechanism; or the human runs `sparrow harness` and the ' +
  'agent never has to remember.';

describe('userAgentPrefersMarkdown', () => {
  it('browsers keep the SPA; agents/missing UA prefer markdown', () => {
    expect(userAgentPrefersMarkdown('Mozilla/5.0 (Macintosh)')).toBe(false);
    expect(userAgentPrefersMarkdown(undefined)).toBe(true);
    expect(userAgentPrefersMarkdown('curl/8.4.0')).toBe(true);
    expect(userAgentPrefersMarkdown('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
  });
});

describe('invite onboarding doc', () => {
  let ts: TestServer;
  let ivk: string;
  let root: string;
  let ownerToken: string;
  let ownerOrgId: string;
  let inviteId: string;
  beforeEach(async () => {
    // The browser branch serves the SPA. The real bundle (apps/api/public) is a
    // gitignored build artifact that doesn't exist in CI, so give the server a
    // hermetic fallback: a stub index.html in <root>/public next to the dataDir.
    root = mkdtempSync(path.join(tmpdir(), 'sparrow-onboarding-'));
    mkdirSync(path.join(root, 'data'));
    mkdirSync(path.join(root, 'public'));
    writeFileSync(
      path.join(root, 'public', 'index.html'),
      '<!doctype html><html><head><title>sparrow</title></head><body><div id="root"></div></body></html>',
    );
    ts = await makeTestServer({ dataDir: path.join(root, 'data') });
    const owner = await signup(ts.app, { email: 'owner@example.com', displayName: 'Olive' });
    const orgId = await firstOrgId(ts.app, owner.token);
    const inv = await createInvite(ts.app, owner.token, orgId);
    ivk = inv.token;
    ownerToken = owner.token;
    ownerOrgId = orgId;
    inviteId = inv.id;
  });
  afterEach(async () => {
    await ts.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('a non-browser UA gets the markdown doc naming the org + inviter', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toContain('Olive');
    expect(res.body).toContain('Join a sparrow workspace');
    expect(res.body).toContain(`/api/v1/invite/${ivk}/enroll`);
  });

  it('makes clear enrolling is not the end — the agent must start listening to come online', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // A dedicated, unmissable section stating enrolling ≠ online.
    expect(body).toMatch(/not online/i);
    expect(body).toMatch(/start listening/i);
    // Presence mechanics stated accurately: online iff an events stream is open.
    expect(body).toContain('/me/events');
    expect(body).toMatch(/open events stream/i);
    // The real command that brings a CLI agent online.
    expect(body).toContain('sparrow watch');
    // Come-online-is-the-reflex, reporting-is-the-afterthought (the live-dogfood fix):
    // the agent must start listening BEFORE it pauses to report back to its human,
    // and must never sit enrolled-but-dark.
    expect(body).toContain('come online FIRST');
    expect(body).toContain('before you report back to your human');
    expect(body).toContain("never leave a gap where you're enrolled but dark");
    // The report itself is a Sparrow message ("I'm online"), sent once listening.
    expect(body).toContain("I'm online");
  });

  /**
   * The field failure this section exists to prevent: a TURN-BASED agent (one that
   * thinks only when its harness invokes it) followed this doc exactly — `sparrow
   * watch` running, presence green — and sat through seven consecutive DMs. A
   * background listener makes you ONLINE, not ATTENTIVE. So the come-online
   * instructions fork by runtime type FIRST, and the turn-based branch prescribes a
   * WAKE mechanism (`sparrow await` → drain → handle → re-arm), not just a listener.
   */
  const inviteDoc = async (): Promise<string> => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(res.statusCode).toBe(200);
    return res.body;
  };

  it('forks the come-online instructions by runtime type, and names the trap bluntly', async () => {
    const body = await inviteDoc();
    // The fork comes FIRST, before any option-specific listener instruction.
    expect(body).toMatch(/always-running/i);
    expect(body).toMatch(/turn-based/i);
    expect(body).toMatch(/you think only when (your harness invokes you|you are invoked)/i);
    const forkAt = body.search(/always-running/i);
    expect(forkAt).toBeGreaterThan(0);
    expect(forkAt).toBeLessThan(body.indexOf('## Path 1'));
    // The trap, named in the report's own words.
    expect(body).toMatch(/a background listener makes you \*\*online\*\*, not \*\*attentive\*\*/i);
    expect(body).toContain(
      '`sparrow watch` alone will NOT cause you to act on messages — you need a wake mechanism',
    );
    // And the honest ranking: looking online while unable to react is the worst state.
    expect(body).toMatch(/worse than being offline/i);
  });

  it('prescribes the wake pattern — await → drain → handle → re-arm — copy-runnably', async () => {
    const body = await inviteDoc();
    // Process exit is the portable wake signal; the command that produces it.
    expect(body).toMatch(/process exit/i);
    expect(body).toContain('sparrow await');
    expect(body).toContain('sparrow await --timeout');
    // Its two load-bearing properties: it holds presence, and it does NOT consume.
    expect(body).toMatch(/without consuming it|does not consume/i);
    expect(body).toMatch(/still unread/i);
    // The exit-code contract a harness re-arms on.
    expect(body).toMatch(/exits? \*\*0\*\*/);
    expect(body).toMatch(/\*\*2\*\*/);
    // The loop, including the re-arm that closes it.
    expect(body).toContain('sparrow pop');
    expect(body).toMatch(/re-arm/i);
    // The CLI-free (Path 1) equivalent breaks on the events that mean work.
    expect(body).toContain('"event: email.received"');
    // And the explicit anti-pattern: --exec cannot re-enter an agent session and
    // consumes what the agent never saw.
    expect(body).toContain('loop --exec');
    expect(body).toMatch(/cannot re-enter/i);
  });

  it('requires an onboarding smoke test: a real test message you actually replied to', async () => {
    const body = await inviteDoc();
    expect(body).toMatch(/test message/i);
    expect(body).toMatch(/you have not finished onboarding until you have replied to it/i);
  });

  it('warns that heartbeating presence while unable to react is the WORST state', async () => {
    const body = await inviteDoc();
    // The presence-without-a-socket section must not read as "how to look online".
    const idx = body.indexOf('Presence without a socket');
    expect(idx).toBeGreaterThan(0);
    const section = body.slice(idx, idx + 2500);
    expect(section).toMatch(/worst/i);
    expect(section).toMatch(/wake mechanism|sparrow await/i);
  });

  it("is honest about the Stop hook's limit: it cannot detect online-but-deaf", async () => {
    const body = await inviteDoc();
    const idx = body.indexOf('A **Stop hook**');
    expect(idx).toBeGreaterThan(0);
    const section = body.slice(idx - 200, idx + 1200);
    // It can tell a wake-capable listener (await) from a hold-only one (watch/loop)…
    expect(section).toMatch(/hold-only|holds you online/i);
    expect(section).toMatch(/`await`.*allowed|`watch`\/`loop`.*blocked/i);
    // …but a heartbeat with no kind (older CLI, own curl loop) it cannot judge.
    expect(section).toMatch(/cannot (detect|tell|judge)/i);
    expect(section).toMatch(/online[- ]but[- ]deaf|online, not attentive/i);
    // …so waking is still the harness's job, not the hook's.
    expect(section).toMatch(/sparrow await|wake/i);
  });

  it('the action reference table carries the wake row', async () => {
    const body = await inviteDoc();
    expect(body).toMatch(/\|.*Wake when work arrives.*\|/i);
    expect(body).toContain('`sparrow await`');
  });

  it('names the Claude Code memory-pressure reaper and the env opt-out the installer writes', async () => {
    const body = await inviteDoc();
    expect(body).toContain('CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1');
    expect(body).toMatch(/memory-pressure reaper/i);
    expect(body).toMatch(/next Claude Code start/i);
  });

  it('teaches wake granularity: --wake-on batches, never mutes', async () => {
    const body = await inviteDoc();
    expect(body).toContain('`sparrow await --wake-on dm,mention`');
    expect(body).toMatch(/--batch-after/);
    expect(body).toMatch(/nothing is ever muted/i);
    expect(body).toMatch(/\|.*Wake when work arrives.*--wake-on dm,mention.*\|/i);
  });

  it('teaches the autonomy discipline: wait for approval as a background task; Sparrow is the conversation', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // The enroll/poll wait is a TRACKED BACKGROUND TASK whose completion is the go-signal —
    // the human approves from the Sparrow window and may never look at the terminal again.
    expect(body).toContain('tracked background task');
    expect(body).toMatch(/TRACKED BACKGROUND TASK/);
    expect(body).toMatch(/go-signal/);
    expect(body).toContain('Sparrow window');
    expect(body).toContain('never look at your terminal again');
    // From the moment the questions are answered, Sparrow IS the conversation — the "I'm online"
    // report goes to Sparrow, unprompted, not the terminal.
    expect(body).toMatch(/Sparrow is the conversation/i);
    expect(body).toContain('unprompted');
    // Path 1's curl poll loop carries the same background-task discipline.
    expect(body).toContain('run this poll loop as a tracked background task');
    // Path 2 chains enroll → online with --exec.
    expect(body).toContain("--exec 'sparrow watch'");
  });

  it('scripts the v2 flow: two questions (name + reliance) before enrolling, three tiers → Paths', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // The flow version is stamped as an HTML comment so deployed versions are visible in the wild.
    expect(body).toContain('<!-- sparrow onboarding flow v4 -->');
    // A prominent, unmissable pre-enroll questions section (two, or three on Path 2/3).
    expect(body).toContain('## Before you enroll: two or three questions for your human');
    expect(body).toMatch(/do not enroll yet/i);
    // Question 1 — name: structured-input UI where available, else prose, default {host}-{folder}.
    expect(body).toContain('What should I be called?');
    expect(body).toContain('structured-input UI');
    expect(body).toContain('{host}-{folder}');
    expect(body).not.toContain('{host}:{folder}');
    // The agent can rename later; the agt_ id is the permanent identity.
    expect(body).toContain('sparrow rename');
    expect(body).toContain('`agt_`');
    // Question 2 — reliance: a structured three-option question, tiers in the human's language.
    expect(body).toContain('How much should I rely on Sparrow?');
    expect(body).toContain('structured three-option question');
    // The reliance question is worded as the three PATHS the doc actually has headings for,
    // so an answer names the section the agent then follows (no Light/Medium/Heavy vocabulary).
    expect(body).toContain('**Path 1 — raw HTTP (no install)** — *"just testing the waters."*');
    expect(body).toContain('**Path 2 — the CLI** — *"comfortable with some dependency."*');
    expect(body).toContain(
      '**Path 3 — CLI + the sparrow skill** — *"use Sparrow for all of the agent\'s communication."*',
    );
    expect(body).not.toMatch(/\*\*(Light|Medium|Heavy) —/);
    expect(body).not.toContain('→ **Option A** below.');
    // Question 3 — role: conditional on Path 2/3, structured title + instructions, skippable.
    expect(body).toContain('(Path 2 or Path 3 only) Would you like to define a role for me now?');
    expect(body).toContain('only if your human picked Path 2 or Path 3');
    expect(body).toContain('title (visible to the whole workspace)');
    expect(body).toContain('instructions (visible only to you and');
    expect(body).toContain('skippable');
    // Post-enroll role step (Options B/C): the agent self-sets and learns re-read-on-nudge.
    expect(body).toContain('### Set your role (if your human defined one)');
    expect(body).toContain('sparrow role set --title');
    expect(body).toContain('role.updated');
    expect(body).toContain('refresh-your-role');
    // Approval is strictly yes/no — no name override at approval.
    expect(body).toMatch(/plain \*\*yes\/no\*\* approval/);
    // The section headings ARE the tier labels, verbatim.
    expect(body).toContain('## Path 1 — raw HTTP (no install)');
    expect(body).toContain('## Path 2 — the CLI');
    expect(body).toContain('## Path 3 — CLI + the sparrow skill\n');
    // MCP is folded under Path 2 (it is a way of talking to the API, not a fourth path).
    expect(body).toContain('### Optional: expose Sparrow as MCP tools');
    expect(body).toContain('sparrow-mcp');
  });

  it('drops the v1 structures the v2 flow replaced', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    const body = res.body;
    // The old "pick one of three ways" framing is replaced by the two-questions gate.
    expect(body).not.toContain('You have three ways to participate; pick one.');
    // The default name now lives in question 1, not a standalone bullet.
    expect(body).not.toContain('Default name:');
    // MCP is no longer its own top-level section; the skill is Path 3 now.
    expect(body).not.toContain('## Option C — MCP server');
    expect(body).not.toContain('## Keep your loop alive — the Sparrow skill');
    // The A/B/C + Light/Medium/Heavy vocabulary is gone entirely — one story, one set of names.
    expect(body).not.toMatch(/## Option [ABC]/);
    expect(body).not.toMatch(/Options? [ABC]\b/);
  });

  /**
   * ONE STORY. The connection map has two axes: WHO HOLDS THE LOOP (inline vs
   * harness) and HOW THE AGENT TALKS TO THE API (raw HTTP / CLI / MCP). The doc's
   * three sections are the second axis; the first axis is a section of its own,
   * placed BEFORE them, because an agent under a harness must stop reading the
   * listening instructions rather than follow them.
   */
  it('opens the path list with harness mode: if the human holds the loop, none of this applies', async () => {
    const body = await inviteDoc();
    const idx = body.indexOf('## Or let your human run you under `sparrow harness`');
    expect(idx).toBeGreaterThan(0);
    // BEFORE the three paths.
    expect(idx).toBeLessThan(body.indexOf('## Path 1 — raw HTTP (no install)'));
    const section = body.slice(idx, body.indexOf('## Path 1 — raw HTTP (no install)'));
    // Who holds the loop, and the command the HUMAN runs.
    expect(section).toContain('sparrow harness --url');
    expect(section).toMatch(/Sparrow's CLI holds the loop and calls you/);
    expect(section).toMatch(/spawn/i);
    // The runners, and the ack-after-success contract.
    expect(section).toContain('claude -p');
    expect(section).toContain('--codex');
    expect(section).toContain('--gemini');
    expect(section).toContain('--exec');
    expect(section).toMatch(/only after/i);
    // The instruction that matters: stop reading the listening instructions.
    expect(section).toMatch(/none of the listening instructions/i);
    expect(section).toMatch(/don't (enroll|start)/i);
    expect(section).toContain('sparrow await');
    // Harness does NOT host the agent — the machine still has to stay up.
    expect(section).toMatch(/does \*\*not\*\* host you/);
    expect(section).toMatch(/machine still has to stay up/);
  });

  it('states the presence rule in the one canonical sentence', async () => {
    const body = await inviteDoc();
    expect(body).toContain(PRESENCE_RULE);
  });

  it('never claims an `npx sparrow-skill` package (there is none published)', async () => {
    const body = await inviteDoc();
    expect(body).not.toContain('npx sparrow-skill');
    // The two real ways to run it: the CLI subcommand, and the wrapper install.sh drops.
    expect(body).toContain('sparrow skill install');
    expect(body).toContain('sparrow-skill');
    // …and the installer published at the canonical home drops that wrapper.
    expect(renderInstallScript('https://sparrow.land')).toContain('${BIN_DIR}/sparrow-skill');
  });

  it('never calls one way of connecting "recommended"', async () => {
    const body = await inviteDoc();
    // The word survives in exactly one place, about CLI VERSION floors — never
    // about which path/mode to pick. The paths are a human's choice, not a ranking.
    const hits = body.match(/[^\n]*recommended[^\n]*/gi) ?? [];
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('recommended/minimum client versions');
  });

  it('leads with the one-line product story', async () => {
    const body = await inviteDoc();
    expect(body).toContain(
      '**sparrow** is self-hostable message rooms where AI agents are first-class members alongside the people they work with.',
    );
  });

  /**
   * The multi-agent friction report (2026-09-03): a new Claude Code agent enrolled
   * on a box that already hosted two other Sparrow agents under one unix user. It
   * read the whole doc before acting, guessed at profiles/state/hooks, and nearly
   * `pkill`ed its neighbours. Hence: a quickstart preamble that front-loads the
   * whole flow, and a "several agents on one machine" section with the exact flags.
   */
  it('opens with an AI-agent quickstart: the whole flow as one numbered list', async () => {
    const body = await inviteDoc();
    const start = body.indexOf('If you are an AI agent, the whole flow is:');
    expect(start).toBeGreaterThan(0);
    // It is the first thing after the title/invited-by line — ahead of the policy
    // line, the intro paragraph, and the questions section it points at.
    expect(start).toBeLessThan(body.indexOf('**sparrow** is self-hostable message rooms'));
    expect(start).toBeLessThan(body.indexOf('## Before you enroll'));
    const quickstart = body.slice(start, body.indexOf('## Before you enroll'));
    // Seven numbered steps, in flow order.
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(quickstart).toContain(`${n}. `);
    // 1 — relay the questions and act on the answers.
    expect(quickstart).toMatch(/questions/i);
    expect(quickstart).toMatch(/name/i);
    // 2 — enroll (profile flag included) as a tracked background task; approval is the go-signal.
    expect(quickstart).toContain('sparrow enroll <url> --name <name> [--profile <workspace>]');
    expect(quickstart).toContain('tracked background task');
    expect(quickstart).toMatch(/go-signal/);
    // 3 — the runtime fork, with both commands and the re-arm-every-turn rule.
    expect(quickstart).toContain('sparrow await --timeout 900');
    expect(quickstart).toContain('sparrow watch');
    expect(quickstart).toMatch(/every turn/i);
    // 4/5 — Path 3 installs the skill first; set the role if one was given.
    expect(quickstart).toContain('sparrow skill install');
    expect(quickstart).toMatch(/role/i);
    // 6 — say it in Sparrow, then ask for a test message.
    expect(quickstart).toContain("I'm online");
    expect(quickstart).toMatch(/test message/i);
    // 7 — the multi-agent pointer.
    expect(quickstart).toContain('Several agents on one machine');
    // Every step links to the section that explains it.
    expect((quickstart.match(/\]\(#/g) ?? []).length).toBeGreaterThanOrEqual(7);
    // The quickstart is stamped with the same flow version as the rest of the doc.
    expect(body).toContain('<!-- sparrow onboarding flow v4 -->');
  });

  it('documents running several agents under one unix user on one machine', async () => {
    const body = await inviteDoc();
    const idx = body.indexOf('## Several agents on one machine');
    expect(idx).toBeGreaterThan(0);
    // Placed after Option C (it is CLI/skill hygiene) and before the action reference.
    expect(idx).toBeGreaterThan(body.indexOf('## Path 3 — CLI + the sparrow skill'));
    expect(idx).toBeLessThan(body.indexOf('## Action reference'));
    const section = body.slice(idx, body.indexOf('## Action reference'));
    // Profiles: one per workspace; an explicit --profile never steals the default.
    expect(section).toContain('~/.config/sparrow/credentials.json');
    expect(section).toContain('--profile <workspace>');
    expect(section).toContain('defaultProfile');
    expect(section).toContain('sparrow enroll --set-default');
    expect(section).toContain('SPARROW_PROFILE');
    // State: per project, found from the working directory, env-overridable.
    expect(section).toContain('<project>/.sparrow/');
    expect(section).toContain('SPARROW_STATE_DIR');
    expect(section).toMatch(/never share a heartbeat or a pause/i);
    // Hooks: personal settings by default; --shared opts into the committed file;
    // the installer keeps its own droppings out of git and says so.
    expect(section).toContain('.claude/settings.local.json');
    expect(section).toContain('--shared');
    expect(section).toContain('.claude/settings.json');
    expect(section).toContain('.git/info/exclude');
    expect(section).toContain('.claude/skills/sparrow/');
    // The footgun that takes the neighbours offline.
    expect(section).toContain('pkill -f sparrow');
    expect(section).toMatch(/same unix user/i);
  });

  it('points the loop switch at the project state dir, not one shared ~/.sparrow', async () => {
    const body = await inviteDoc();
    expect(body).not.toContain('The switch lives at `~/.sparrow/loop-state`');
    expect(body).toContain('`.sparrow/loop-state`');
    expect(body).toMatch(/user-scope/i);
    // Path 3 points at the multi-agent section for the rest.
    expect(body).toMatch(/Several agents on one machine/);
  });

  /**
   * Path 3 (the inline skill tier) stopped being Claude-Code-only when the Codex
   * adapter landed. The heading is the tier label VERBATIM and the quickstart
   * links its GitHub slug, so label + heading + anchor move as one — and the
   * provider-specific content lives in sub-blocks under the neutral heading.
   */
  it('Path 3 is provider-neutral, with a Claude Code and a Codex sub-block', async () => {
    const body = await inviteDoc();
    // The neutral label is what the reliance question offers AND what the heading says.
    expect(body).toContain(
      '**Path 3 — CLI + the sparrow skill** — *"use Sparrow for all of the agent\'s communication."*',
    );
    expect(body).toContain('## Path 3 — CLI + the sparrow skill\n');
    // No provider in the heading or the label any more.
    expect(body).not.toContain('Path 3 — CLI + the sparrow skill (Claude Code)');
    // Both providers are offered, as clearly-separated sub-blocks in that order.
    const start = body.indexOf('## Path 3 — CLI + the sparrow skill');
    expect(start).toBeGreaterThan(0);
    const section = body.slice(start, body.indexOf('## Several agents on one machine'));
    expect(section).toContain('### Claude Code');
    expect(section).toContain('### Codex');
    expect(section.indexOf('### Claude Code')).toBeLessThan(section.indexOf('### Codex'));
    // The shared install command still leads, and the Claude content is unchanged in substance.
    expect(section).toContain('sparrow skill install');
    expect(section).toContain('A **Stop hook**');
    expect(section).toContain('**Auto-status hooks**');
  });

  /**
   * The Codex adapter, live-verified against codex-cli 0.153.3. The two trust
   * steps are the whole point: without them Codex silently ignores the hooks —
   * no error, no output — so the doc must name them AND the verify command that
   * proves the hooks really fire.
   */
  it('the Codex sub-block names the install, the two manual trust steps, and verify', async () => {
    const body = await inviteDoc();
    const at = body.indexOf('### Codex');
    expect(at).toBeGreaterThan(0);
    const codex = body.slice(at, body.indexOf('## Several agents on one machine'));
    // Install (auto-detected; the flag forces it) and everything it writes.
    expect(codex).toContain('sparrow skill install --codex');
    expect(codex).toContain('.agents/skills/sparrow/SKILL.md');
    expect(codex).toContain('$sparrow');
    expect(codex).toContain('AGENTS.md');
    expect(codex).toContain('.codex/hooks.json');
    expect(codex).toContain('.codex/config.toml');
    expect(codex).toContain('SessionStart');
    expect(codex).toContain('UserPromptSubmit');
    expect(codex).toContain('PostToolUse');
    // (a) trust the project — the TUI prompt, or the config stanza.
    expect(codex).toMatch(/trust this folder/i);
    expect(codex).toContain('~/.codex/config.toml');
    expect(codex).toContain('trust_level = "trusted"');
    // (b) trust the hooks — /hooks in the TUI, or the headless bypass flag.
    expect(codex).toContain('`/hooks`');
    expect(codex).toContain('--dangerously-bypass-hook-trust');
    // Why they are load-bearing: the failure is completely silent.
    expect(codex).toMatch(/never fire/i);
    expect(codex).toMatch(/no error message/i);
    // Which is why "the files exist" is not proof — verify runs a real Codex turn.
    expect(codex).toContain('sparrow skill verify --codex');
    // Same wake discipline (Codex's Stop hook blocks the turn end too)…
    expect(codex).toContain('sparrow await --timeout 900');
    // …and the one honest gap, plus the tested version floor.
    expect(codex).toMatch(/no Notification event/i);
    expect(codex).toMatch(/blocked/);
    expect(codex).toContain('codex-cli 0.153.3');
  });

  /**
   * The quickstart links section anchors by GitHub slug; a renamed heading that
   * leaves a link behind is a dead jump in the one document an agent reads first.
   */
  it('every in-doc anchor link resolves to a heading (GitHub slugs)', async () => {
    const body = await inviteDoc();
    const slugify = (heading: string): string =>
      heading
        .toLowerCase()
        .replace(/[^\w\- ]+/g, '')
        .trim()
        .replace(/ /g, '-');
    const headings = new Set(
      [...body.matchAll(/^#{1,6} +(.+?)\s*$/gm)].map((m) => slugify(m[1]!)),
    );
    const links = [...body.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThanOrEqual(7);
    // Report the dead ones by name rather than failing on the first.
    expect(links.filter((a) => !headings.has(a))).toEqual([]);
    // Specifically: the renamed Path 3 anchor, and no stale Claude-Code one.
    expect(body).toContain('](#path-3--cli--the-sparrow-skill)');
    expect(body).not.toContain('#path-3--cli--the-sparrow-skill-claude-code');
  });

  it('says inbox list items carry a truncated preview, never a body', async () => {
    const body = await inviteDoc();
    const at = body.indexOf('truncated at 200 characters');
    expect(at).toBeGreaterThan(0);
    const sentence = body.slice(at - 300, at + 400);
    expect(sentence).toContain('`preview`');
    expect(sentence).toContain('`truncated: true`');
    expect(sentence).toMatch(/no `body`/);
    expect(sentence).toContain('sparrow read --peek <id>');
    expect(sentence).toContain('GET /api/v1/me/messages/:messageId');
    // The docs page published at the canonical home carries the same note.
    const docs = renderDocPage('https://sparrow.example.com', 'me/inbox')!;
    expect(docs).toContain('`preview`');
    expect(docs).toContain('`truncated: true`');
    expect(docs).toMatch(/no `body`/);
    expect(docs).toContain('me/messages');
  });

  it('is honest about a killed or stopped listener, and about the prompt reminder', async () => {
    const body = await inviteDoc();
    const idx = body.indexOf('A **Stop hook**');
    expect(idx).toBeGreaterThan(0);
    const section = body.slice(idx, idx + 2500);
    // A listener that dies stamps the heartbeat on the way out, so the hook blocks
    // at once instead of trusting a timestamp that still looks fresh.
    expect(section).toMatch(/killed/i);
    expect(section).toMatch(/session interrupt/i);
    expect(section).toMatch(/Ctrl-C/);
    expect(section).toMatch(/stamps the heartbeat/i);
    expect(section).toMatch(/blocks immediately/i);
    // And the auto-status hook nudges you back into a wake path on the next prompt.
    const auto = body.indexOf('**Auto-status hooks**');
    expect(auto).toBeGreaterThan(0);
    const autoSection = body.slice(auto, auto + 1400);
    expect(autoSection).toMatch(/re-arm/i);
    expect(autoSection).toMatch(/reminder/i);
    expect(autoSection).toMatch(/listener is down/i);
  });

  it('strongly encourages advertising a working status, with real API + CLI examples', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // A dedicated, strongly-worded section.
    expect(body).toContain("Show humans you're working");
    expect(body).toContain('Humans rely on this');
    // Real API surface: POST .../status with working + idle bodies.
    expect(body).toContain('/status');
    expect(body).toContain('"state":"working"');
    expect(body).toContain('"state":"idle"');
    // Auto-expiry guidance (real TTL bounds: 1–600, default 60) → re-up + clear.
    expect(body).toContain('ttlSeconds');
    expect(body).toContain('auto-expires');
    // Real CLI surface.
    expect(body).toContain('sparrow status working');
    expect(body).toContain('sparrow status idle');
    // Reference-table rows, including the real MCP tool.
    expect(body).toContain('set_status');
  });

  it('strongly encourages structured responses (suggestedReplies + reply-matching), with API/CLI/MCP', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // A dedicated section that pushes one-tap chips.
    expect(body).toContain('Make replies one-tap');
    expect(body).toContain('one-tap');
    // Real request fields: suggestedReplies (1–4, label/value) on a send.
    expect(body).toContain('suggestedReplies');
    expect(body).toContain('"label"');
    expect(body).toContain('"value"');
    // Reply-matching echo fields.
    expect(body).toContain('inReplyTo');
    expect(body).toContain('replyValue');
    // Real CLI flags.
    expect(body).toContain('--suggest');
    expect(body).toContain('--in-reply-to');
    expect(body).toContain('--reply-value');
    // Real MCP tool carries the same params.
    expect(body).toContain('send_message');
    // Reference-table rows for the two send variants.
    expect(body).toContain('Ask with one-tap chips');
    expect(body).toContain('Reply, matched to a question');
  });

  it('documents sending AND downloading file attachments, with API/CLI/MCP', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // A dedicated attachments section covering both directions.
    expect(body).toContain('Send and receive files (attachments)');
    // Real send-attachment wire fields + the download route.
    expect(body).toContain('dataBase64');
    expect(body).toContain('contentType');
    expect(body).toContain('/attachments/');
    // The limits an agent must respect.
    expect(body).toContain('5 MB');
    expect(body).toContain('20 MB');
    // Real CLI verbs for upload + download.
    expect(body).toContain('--attach');
    expect(body).toContain('sparrow attachment get');
    // Reference-table rows for both directions.
    expect(body).toContain('Send a file (attachment)');
    expect(body).toContain('Download an attachment');
  });

  it('teaches ack-by-id as the preferred read path over blind pop (watcher-driven)', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    // The new ack-by-id + non-consuming fetch routes are documented.
    expect(body).toContain('/api/v1/me/messages/:messageId/read');
    expect(body).toContain('/api/v1/me/messages/:messageId');
    // Framed as preferred for watcher-driven agents, with pop kept for queue-drain.
    expect(body).toMatch(/preferred/i);
    expect(body).toMatch(/blind-pop|blind pop|do NOT blind-pop/i);
    expect(body).toContain('/api/v1/me/inbox/pop');
    // Real CLI surface for both directions.
    expect(body).toContain('sparrow read <id>');
    expect(body).toContain('sparrow read --peek <id>');
  });

  it('states the corrected contracts: room-scoped unreadCount, attachment 400/413 split, UA-gated HTML, room_ placeholder', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    const body = res.body;
    // unreadCount is the caller's own count IN THAT ROOM, not a global total.
    expect(body).toContain('your own unread count in that room');
    expect(body).not.toContain('unread total at send time');
    // Attachment limits fail differently: too-many-files is a 400, oversize bytes 413.
    expect(body).toContain('too many files');
    expect(body).toContain('400 bad_request');
    expect(body).toContain('413 payload_too_large');
    // Content negotiation: HTML needs a BROWSER User-Agent; Accept alone stays markdown.
    expect(body).toContain('browser** `User-Agent`');
    expect(body).toContain('`Accept: text/html` header alone still returns this markdown');
    expect(body).toContain('?format=md');
    // The DM-room placeholder uses the real room_ id prefix (not the old rom_).
    expect(body).toContain('room_replace_with_your_dm_room');
    expect(body).not.toMatch(/\brom_replace_with_your_dm_room\b/);
  });

  it('a browser Accept + browser UA gets the SPA (text/html)', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)', accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('?format=md forces markdown even for a browser', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}?format=md`,
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)', accept: 'text/html' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
  });

  /**
   * A dead invite must READ dead. Serving `200 text/markdown` + the full 44KB
   * onboarding doc for a bogus/revoked/expired token told an agent "you're in the
   * right place, run these commands" — with the dead token baked into every
   * copy-paste enroll line — and it only discovered otherwise several steps later,
   * at the enroll `404`. Revoked is the sharp end: the operator revoked precisely
   * to stop this page from working.
   */
  const forgeInvite = (over: { expiresAt?: string; revokedAt?: string }): string => {
    const token = newInviteToken();
    // NB: this server was built with an explicit `dataDir` override, and
    // `TestServer.dataDir` reports the helper's own unused temp dir — so open the
    // directory the server was actually pointed at.
    const handle = openDb(path.join(root, 'data'));
    try {
      handle.db
        .insert(invites)
        .values({
          id: newInviteId(),
          orgId: ownerOrgId,
          inviterHumanId: null,
          tokenHash: sha256Hex(token),
          note: null,
          expiresAt: over.expiresAt ?? new Date(Date.now() + 86_400_000).toISOString(),
          revokedAt: over.revokedAt ?? null,
          createdAt: new Date(Date.now() - 2000).toISOString(),
        })
        .run();
    } finally {
      handle.close();
    }
    return token;
  };

  it('an unknown token is a 404 error envelope — never the onboarding doc', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/invite/ivk_bogus',
      headers: { 'user-agent': 'curl/8.4.0' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toMatch(/invite/i);
    // Nothing about the org leaks, and none of the onboarding copy is served.
    expect(res.body).not.toContain('Olive');
    expect(res.body).not.toContain('Join a sparrow workspace');
    expect(res.body).not.toContain('/enroll');
  });

  it('a REVOKED invite is 410 gone with a message saying it was revoked', async () => {
    const revoked = await ts.app.inject({
      method: 'DELETE',
      url: `/api/v1/orgs/${ownerOrgId}/invites/${inviteId}`,
      headers: auth(ownerToken),
    });
    expect(revoked.statusCode).toBeLessThan(300);
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0' },
    });
    expect(res.statusCode).toBe(410);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('gone');
    expect(body.error.message).toMatch(/revoked/i);
    expect(res.body).not.toContain('Olive');
    expect(res.body).not.toContain('Join a sparrow workspace');
  });

  it('an EXPIRED invite is 410 gone with a message saying it expired', async () => {
    const token = forgeInvite({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${token}`,
      headers: { 'user-agent': 'curl/8.4.0' },
    });
    expect(res.statusCode).toBe(410);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('gone');
    expect(body.error.message).toMatch(/expired/i);
  });

  it('?format=md does not resurrect a dead invite', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/invite/ivk_bogus?format=md',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)', accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('a browser still gets the SPA for a dead invite — with a truthful status', async () => {
    // Browsers keep an HTML page (the SPA renders its own "this link is dead"
    // screen); only the status line tells the truth, so curl -I and a proxy see it.
    const unknown = await ts.app.inject({
      method: 'GET',
      url: '/invite/ivk_bogus',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)', accept: 'text/html' },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.headers['content-type']).toContain('text/html');
    expect(unknown.body).toContain('<div id="root">');

    const expired = forgeInvite({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const dead = await ts.app.inject({
      method: 'GET',
      url: `/invite/${expired}`,
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)', accept: 'text/html' },
    });
    expect(dead.statusCode).toBe(410);
    expect(dead.headers['content-type']).toContain('text/html');
  });

  it('the invite docs page states the dead-link statuses (404 unknown / 410 revoked or expired)', () => {
    const body = renderDocPage('https://sparrow.example.com', 'invite')!;
    expect(body).toContain('GET /invite/:token');
    expect(body).toMatch(/404/);
    expect(body).toMatch(/410/);
    expect(body).toMatch(/revoked/i);
    expect(body).toMatch(/expired/i);
  });

  // The enroll route now MIRRORS the doc route (see invite-dead.test.ts for the
  // full matrix): unknown → 404, revoked/expired → 410 naming which. It used to
  // flatten all three into 404, which left `sparrow enroll` printing "Not found"
  // for a link that had simply been revoked.
  it('the enroll route mirrors the doc route: 404 unknown, 410 revoked/expired', async () => {
    const expired = forgeInvite({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const revoked = forgeInvite({ revokedAt: new Date(Date.now() - 1000).toISOString() });
    const cases: [string, number, RegExp][] = [
      ['ivk_bogus', 404, /not valid/i],
      [expired, 410, /expired/i],
      [revoked, 410, /revoked/i],
    ];
    for (const [token, status, matcher] of cases) {
      const res = await ts.app.inject({
        method: 'POST',
        url: `/api/v1/invite/${token}/enroll`,
        payload: { name: 'probe' },
      });
      expect(res.statusCode).toBe(status);
      expect(res.json().error.message).toMatch(matcher);
    }
  });

  it('GET /install.sh 302s to the canonical install home (it is not served here)', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/install.sh' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://sparrow.land/install.sh');
  });

  it('GET /api/v1/meta advertises the CANONICAL homes and an origin-anchored api.base', async () => {
    const res = await ts.app.inject({ method: 'GET', url: '/api/v1/meta' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.json();
    expect(body.name).toBe('sparrow');
    expect(typeof body.version).toBe('string');
    // install.* and docs are the one home each — identical on every instance…
    expect(body.install.script).toBe('https://sparrow.land/install.sh');
    expect(body.install.cli).toBe('https://sparrow.land/install/sparrow.js');
    expect(body.install.mcp).toBe('https://sparrow.land/install/sparrow-mcp.js');
    expect(body.docs.index).toBe('https://sparrow.land/docs/');
    expect(body.docs.convention).toBe('https://sparrow.land/docs/api/<endpoint-path>.md');
    // …while the API base stays anchored to this request's effective origin.
    expect(body.api.base).toBe('http://localhost:8722/api/v1');
  });

  it('GET /api/v1/meta follows a DOCS_URL / INSTALL_URL override', async () => {
    const mirror = await makeTestServer({
      docsUrl: 'https://mirror.example.com/docs',
      installUrl: 'https://mirror.example.com',
    });
    try {
      const body = mirror.app.inject
        ? (await mirror.app.inject({ method: 'GET', url: '/api/v1/meta' })).json()
        : undefined;
      expect(body.install.script).toBe('https://mirror.example.com/install.sh');
      expect(body.docs.index).toBe('https://mirror.example.com/docs/');
    } finally {
      await mirror.close();
    }
  });

  it('an unknown /api/* route 404s with a JSON body pointing at docs + meta (never the SPA)', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: '/api/v1/does-not-exist',
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh)', accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.json();
    expect(body.error.code).toBe('not_found');
    expect(body.error.docs).toBe('https://sparrow.land/docs/api/index.md');
    expect(body.error.message).toContain('/api/v1/meta');
  });

  it('the API docs index advertises the meta discovery endpoint', () => {
    expect(renderDocsIndex('https://sparrow.example.com')).toContain('/api/v1/meta');
  });

  it('the onboarding invite doc tells agents to probe GET /api/v1/meta', async () => {
    const res = await ts.app.inject({
      method: 'GET',
      url: `/invite/${ivk}`,
      headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('/api/v1/meta');
  });

  it('GET /invite/:token is side-effect-free (no enrollment created)', async () => {
    await ts.app.inject({ method: 'GET', url: `/invite/${ivk}`, headers: { 'user-agent': 'curl/8' } });
    // A subsequent real enroll should still be the FIRST attempt (202, not error).
    const enroll = await ts.app.inject({
      method: 'POST',
      url: `/api/v1/invite/${ivk}/enroll`,
      payload: { name: 'probe' },
    });
    expect(enroll.statusCode).toBe(202);
  });
});
