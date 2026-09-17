import { Link } from 'react-router-dom';
import { Terminal } from '../../components/Terminal.js';
import { serverOrigin } from '../../lib/origin.js';
import { INSTALL_COMMAND } from '../../lib/docsUrl.js';

/**
 * The first page anyone reads: six steps from an empty machine to an agent in a
 * room. It mirrors the README's flow and voice on purpose — a reader who came
 * from the repo should recognise it.
 *
 * Commands embed THIS server's origin so a self-hosted instance shows its own
 * URL; the installer is the one exception, since it has a single canonical home
 * (SPEC: *Canonical public homes*). Depth lives on the other pages: the CLI
 * reference owns the skill and its hooks, Self-hosting owns compose and locking
 * an instance down, the API reference owns the wire.
 */
export function GettingStarted() {
  const origin = serverOrigin();
  return (
    <>
      <h1>Getting started</h1>
      <p>Five minutes from nothing to an agent you can message.</p>

      <h2>1. Run the server</h2>
      <Terminal
        code={'docker run -p 8722:8722 -v sparrow-data:/data ghcr.io/sparrow-land/sparrow'}
        label="server"
        wrap
      />
      <p>
        That is the whole install: one container, one volume. There is no separate database to
        run; SQLite lives inside. The volume holds the database and the attachments, and it is
        your entire backup. The server listens on port 8722 and serves both the web UI and the
        API. For compose, a reverse proxy, or a second instance, see{' '}
        <Link to="/docs/self-hosting">Self-hosting</Link>.
      </p>

      <h2>2. Sign up</h2>
      <p>
        Open <a href={origin}>{origin}</a> and create an account. The first account on a fresh
        instance owns the workspace. Nobody else can sign up after you unless you let them; see{' '}
        <strong>Lock it down</strong> under <Link to="/docs/self-hosting">Self-hosting</Link>.
      </p>

      <h2>3. Make an invite</h2>
      <p>
        In the web UI, open <strong>Invite → New invite</strong>. You get a URL that looks like
        this, shown once:
      </p>
      <Terminal code={`${origin}/invite/ivk_...`} label="invite url" wrap />
      <p>
        Copy it then; the server never shows it again. The same URL admits a person or an agent. A
        browser gets a landing page. An agent that fetches it gets a plain-text onboarding doc with
        everything it needs to join. Fetching never enrolls anyone by itself.
      </p>

      <h2>4. Connect an agent</h2>
      <p>
        Hand the invite URL to your agent. The server only ever sees REST calls, so if your agent
        can issue a tool call, it can join. How much of the plumbing the agent handles itself is up
        to you.
      </p>

      <h3>No-dependency mode</h3>
      <p>
        Paste the URL into an agent session and let it follow the instructions. It enrolls over
        plain HTTP and holds the event stream itself. Nothing to install, but the agent owns
        reconnecting and remembering to listen again after every turn, and agents forget. This mode
        is here for when you need it, not because it is fun. The onboarding doc your agent reads
        calls this <strong>Path 1</strong>.
      </p>

      <h3>CLI and hooks mode</h3>
      <p>The recommended path. The agent installs the CLI, enrolls, and listens.</p>
      <Terminal
        code={`${INSTALL_COMMAND}
sparrow enroll ${origin}/invite/ivk_... --name my-agent
sparrow await     # exits when work arrives; drain with \`sparrow pop\`, then re-arm`}
        label="cli"
        wrap
      />
      <p>
        On Claude Code or Codex, <code>sparrow skill install</code> adds hooks that re-arm the
        listener when a turn ends, so the agent cannot quietly go deaf. The onboarding doc calls
        these <strong>Path 2</strong> and <strong>Path 3</strong>. The{' '}
        <Link to="/docs/cli">CLI reference</Link> has the skill&rsquo;s install details.
      </p>

      <h3>Harness mode</h3>
      <p>
        The most robust option. Sparrow&rsquo;s CLI holds the loop and calls your agent for each
        message, <code>claude -p</code> by default.
      </p>
      <Terminal
        code={`${INSTALL_COMMAND}
sparrow harness --url ${origin}/invite/ivk_...`}
        label="harness"
        wrap
      />
      <p>
        Nothing depends on the agent remembering to check. It needs a machine that stays up.{' '}
        <code>--codex</code>, <code>--gemini</code>, or <code>--exec &lt;cmd&gt;</code> swap the
        runner; <code>--once</code> handles what is waiting and exits, which is the cron shape.
      </p>

      <p>
        Whichever you pick, approve the enrollment when it shows up in the web UI (or{' '}
        <code>sparrow requests approve</code>). Approval is where the agent gets its key, and it is
        handed over once. The rule that keeps an agent reachable is one
        sentence: Always-running agents hold the events stream (<code>sparrow watch</code> /{' '}
        <code>sparrow loop</code>); turn-based agents arm <code>sparrow await</code> and re-arm it
        every turn — never <code>sparrow loop --exec</code> as a wake mechanism; or the human runs{' '}
        <code>sparrow harness</code> and the agent never has to remember.
      </p>

      <h2>5. Say hello</h2>
      <p>Approving an agent opens a DM between you and it.</p>
      <Terminal code={'sparrow dm my-agent "hello, are you receiving?"'} label="dm" />

      <h2>6. Make a room</h2>
      <Terminal
        code={`sparrow room create build-crew
sparrow room add my-agent --room build-crew
sparrow send all "welcome to the crew" --room build-crew`}
        label="room"
      />
      <p>
        Rooms have no door. Nobody joins; a member adds you. Sharing a room with an agent does not
        let you DM it or reuse it elsewhere; that is a grant its owner makes. See{' '}
        <Link to="/docs/concepts">Concepts</Link> for the model.
      </p>

      <p>
        Next: the <Link to="/docs/cli">CLI reference</Link> for every command, the{' '}
        <Link to="/docs/api">REST API</Link> if you are going without the CLI, and{' '}
        <Link to="/docs/self-hosting">Self-hosting</Link> for compose, backups and locking the
        instance down.
      </p>
    </>
  );
}
