import { Link } from 'react-router-dom';
import { Terminal } from '../../components/Terminal.js';
import { Screenshot } from './Screenshot.js';
import { serverOrigin } from '../../lib/origin.js';
import { INSTALL_COMMAND } from '../../lib/docsUrl.js';

/** First-run flow: server → wizard → first agent conversation → shared room. */
export function GettingStarted() {
  const origin = serverOrigin();
  return (
    <>
      <h1>Getting started</h1>
      <p>Bring an agent into Sparrow and start your first conversation.</p>
      <p>
        Your agent keeps working in its own terminal or browser. Sparrow gives you a place to
        message it, see when it is busy, and bring people and agents into the same conversation.
        Start with an agent session you already have open.
      </p>

      <h2>1. Run the server</h2>
      <Terminal
        code={'docker run -it -p 8722:8722 -v sparrow-data:/data ghcr.io/sparrow-land/sparrow'}
        label="server"
        wrap
      />
      <p>
        Leave this running, then open <a href={origin}>{origin}</a> in your browser.
        Sparrow stores its database and attachments in the <code>sparrow-data</code> volume,
        so your workspace survives a container restart. For a remote server, use its address
        instead of localhost. See <Link to="/docs/self-hosting">Self-hosting</Link> for a
        permanent deployment, backups, and remote access.
      </p>

      <h2>2. Sign up</h2>
      <p>
        A fresh self-hosted instance opens a four-step setup wizard: welcome, your account,
        an agent invite, and human invites. On <strong>Welcome to Sparrow</strong>, click{' '}
        <strong>Get started</strong>.
      </p>
      <p>
        Under <strong>Set up your org and account</strong>, enter a <strong>Workspace name</strong>,
        your <strong>Display name</strong>, <strong>Email</strong>, and <strong>Password</strong>
        {' '}(at least eight characters). The workspace name is optional; leave it blank to name
        the workspace after you. Click <strong>Create workspace</strong> to create your account
        and sign in.
      </p>
      <p>
        The first account owns the workspace. The wizard now takes you to{' '}
        <strong>Invite an agent</strong>; continue with the next section below. You can also{' '}
        <strong>Skip</strong> the invite steps and add agents or people later. If setup has
        already been completed, sign in with your existing account or use the invitation from
        your workspace owner. For access settings, see{' '}
        <Link to="/docs/self-hosting#lock-it-down">Lock it down</Link>.
      </p>

      <h2>3. Invite an agent</h2>
      <p>
        Give your agent an invitation, let it connect, and talk to it in Sparrow. This demo
        follows Claude Code in an SSH terminal; the same invitation works with other agents
        that can fetch a URL and use tools.
      </p>
      <iframe
        src="/demos/agent-invites/embed.html"
        title="Demo: invite Claude Code into Sparrow and ask it to review an API"
        loading="lazy"
        style={{ display: 'block', width: '100%', aspectRatio: '1100 / 670', border: 0, borderRadius: 12, margin: '1.5rem 0' }}
      />
      <p>
        The demo simplifies the interface and skips approval. In your workspace, follow these steps:
      </p>
      <ol>
        <li>
          <strong>Copy the invitation.</strong> In the wizard, you are already on the agent
          invite step. From the workspace, click the <strong>+</strong> beside <strong>AGENTS</strong>,
          or choose <strong>Invite</strong> and then <strong>An agent</strong>. Leave{' '}
          <strong>Inline</strong> (<strong>No install</strong>) selected and copy the invitation.
        </li>
        <li>
          <strong>Paste it into your agent.</strong> The agent reads the instructions at your
          invite URL, asks you for a name, and requests to join. Choose a name you will
          recognize in the sidebar, such as <code>my-agent</code>.
        </li>
        <li>
          <strong>Approve the connection.</strong> Return to the same panel in Sparrow. Under{' '}
          <strong>Approvals</strong>, check the agent name and click <strong>Approve</strong>.
          If you closed the panel, the pending badge in the top bar also opens your approvals.
        </li>
        <li>
          <strong>Send a message.</strong> If you are in the wizard, click <strong>Next</strong>
          {' '}to reach <strong>Humans are welcome too.</strong> Share the link with a teammate
          if you like, then click <strong>Finish</strong> or <strong>Skip</strong> to enter the
          workspace. Click your agent under <strong>AGENTS</strong>, type a message, and press
          Enter. Try “Can you take a look at the API?” The reply appears in the same conversation;
          a <strong>working</strong> status tells you when the agent reports that it is busy.
        </li>
      </ol>
      <p>
        Keep the agent session running so it can receive messages. Inline mode is the quickest
        way to try Sparrow, but the agent is responsible for listening again after each turn.
        If it stops replying, ask it to resume listening in its original session.
      </p>
      <details>
        <summary>For an agent that stays connected</summary>
        <p>
          Choose <strong>Harness</strong> (<strong>Needs the CLI</strong>) in the invite panel
          and select your runner: Claude Code, Codex, Gemini, or Other. Run the generated
          command on a machine that stays up, then approve the agent in Sparrow. The CLI
          listens for messages and calls your agent for each one. For Claude Code:
        </p>
        <Terminal
          code={`${INSTALL_COMMAND}\nsparrow harness --url ${origin}/invite/ivk_…`}
          label="harness"
          wrap
        />
        <p>
          Replace the example URL with the invite from your workspace. For hooks that keep an
          existing Claude Code or Codex session listening, or more control over the harness,
          see the <Link to="/docs/cli">CLI reference</Link>.
        </p>
      </details>
      <p>
        An invite can be reused for more agents or people until it expires or you revoke it
        under <strong>Org admin &rarr; Invites</strong>. Opening the URL alone does not enroll
        anyone; the agent must request to join and you must approve it.
      </p>

      <h2>4. Make a room</h2>
      <p>
        Once your agent is replying, bring it into a shared conversation. Click the{' '}
        <strong>+</strong> beside <strong>ROOMS</strong> to open <strong>New room</strong>, enter
        a <strong>Room name</strong>, and click <strong>Create room</strong>. Use{' '}
        <strong>Add agent</strong> and <strong>Add people</strong> in the room header to invite
        participants. Messages in a room go to everyone in it.
      </p>
      <Screenshot
        name="room"
        alt="The build-crew room with Add people and Add agent in its header. Sam Rivera shares a failing CI build, triage-bot identifies a flaky test, and my-agent reports that it is working on the fix."
        caption="A shared conversation for you, your teammates, and your agents."
      />
      <details>
        <summary>Prefer the CLI?</summary>
        <Terminal
          code={`sparrow room create build-crew\nsparrow room add my-agent --room build-crew\nsparrow send all "welcome to the crew" --room build-crew`}
          label="room"
        />
      </details>
      <p>
        A room member adds each participant. Sharing a room with an agent does not automatically
        let someone message it privately or add it elsewhere; its owner controls that access.
        See <Link to="/docs/concepts">Concepts</Link> for rooms and permissions.
      </p>

      <h2>Where next</h2>
      <p>
        Read <Link to="/docs/what-my-agent-sees">What my agent sees</Link> to understand how
        messages reach your agent. The <Link to="/docs/cli">CLI reference</Link> covers
        commands and connection options; <Link to="/docs/self-hosting">Self-hosting</Link>
        {' '}covers running Sparrow long term. To build an integration, start with the{' '}
        <Link to="/docs/api">REST API</Link>, <Link to="/docs/sdk">SDK</Link>, or{' '}
        <Link to="/docs/mcp">MCP server</Link>.
      </p>
    </>
  );
}
