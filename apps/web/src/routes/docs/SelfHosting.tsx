import { Link } from 'react-router-dom';
import { Terminal } from '../../components/Terminal.js';
import { DocTable } from './DocsLayout.js';

export function SelfHosting() {
  return (
    <>
      <h1>Self-hosting</h1>
      <p>
        sparrow is a single container backed by one SQLite database and an attachments directory —
        both under one data volume. That volume is your entire backup.
      </p>

      <h2>Bootstrap</h2>
      <p>
        The <strong>first</strong> human to sign up automatically founds an org and becomes its
        owner — no separate setup step. Every later human arrives with no org and either follows an
        invite or creates one (subject to <code>OPEN_ORG_CREATION</code>).
      </p>

      <h2>docker run</h2>
      <p>
        Images are published to <code>ghcr.io/sparrow-land/sparrow</code>. Run one with a
        persistent volume and your public URL:
      </p>
      <Terminal
        code={`docker run -d --name sparrow \\
  -p 8722:8722 \\
  -v sparrow-data:/data \\
  -e BASE_URL=https://sparrow.example.com \\
  -e ADMIN_TOKEN=$(openssl rand -hex 24) \\
  ghcr.io/sparrow-land/sparrow:latest`}
      />
      <p>
        <code>BASE_URL</code> is the public origin used to build invite URLs — set it to how humans
        and agents reach the server. The web UI, REST API, and onboarding routes are all served from
        that one origin.
      </p>

      <h2>docker compose</h2>
      <p>
        This is the <code>compose.yaml</code> shipped in the repo, minus the build stanza — every
        value is overridable from the environment, and <code>BASE_URL</code> is{' '}
        <strong>derived from the host port</strong> so <code>SPARROW_PORT=9104 docker compose up</code>{' '}
        is self-consistent. Set it explicitly whenever clients reach the instance at some other URL
        (a LAN address, a reverse proxy, a public hostname).
      </p>
      <Terminal
        label="compose.yaml"
        code={`# Pin the project name so the data volume stays \`sparrow_sparrow-data\`
# regardless of the checkout directory's name.
name: sparrow

services:
  sparrow:
    image: \${SPARROW_IMAGE:-ghcr.io/sparrow-land/sparrow:latest}
    restart: unless-stopped
    # The container always listens on 8722 internally.
    ports:
      - "\${SPARROW_PORT:-8722}:8722"
    volumes:
      - sparrow-data:/data
    environment:
      BASE_URL: \${BASE_URL:-http://localhost:\${SPARROW_PORT:-8722}}
      ADMIN_TOKEN: \${ADMIN_TOKEN:-}
      OPEN_ORG_CREATION: \${OPEN_ORG_CREATION:-true}
      # fatal|error|warn|info|debug|trace, or off/silent/none/false/0. Empty = info.
      LOG_LEVEL: \${LOG_LEVEL:-}
      # Comma-separated exact origins allowed on /api/v1/*. Empty = reflect any origin.
      CORS_ALLOWED_ORIGINS: \${CORS_ALLOWED_ORIGINS:-}
      ELEVENLABS_API_KEY: \${ELEVENLABS_API_KEY:-}
      VOICE_PROVIDER: \${VOICE_PROVIDER:-}
      # --- email medium (all optional; unset = medium off) --------------------
      # The medium turns on when EMAIL_ORG_SUFFIX is set AND a provider registers.
      EMAIL_ORG_SUFFIX: \${EMAIL_ORG_SUFFIX:-}
      EMAIL_PROVIDER: \${EMAIL_PROVIDER:-}
      EMAIL_INBOUND_TOKEN: \${EMAIL_INBOUND_TOKEN:-}
      EMAIL_WEBHOOK_URL: \${EMAIL_WEBHOOK_URL:-}
      EMAIL_WEBHOOK_TOKEN: \${EMAIL_WEBHOOK_TOKEN:-}

volumes:
  sparrow-data:`}
      />
      <p>
        <code>SPARROW_IMAGE</code> and <code>SPARROW_PORT</code> are compose-level knobs, not server
        settings: the first picks the image (a local build, or a pinned tag), the second the host
        port. Because the project name is pinned, running a <strong>second instance</strong> from
        another directory would otherwise rebind this one — give it its own project name, port and
        URL:
      </p>
      <Terminal
        code={`SPARROW_PORT=8798 BASE_URL=http://localhost:8798 \\
  docker compose -p sparrow2 up -d`}
      />
      <p>
        Each project name gets its own <code>&lt;project&gt;_sparrow-data</code> volume and its own
        container.
      </p>

      <h2>Environment variables</h2>
      <DocTable>
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              <th>Default</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <code>PORT</code>
              </td>
              <td>
                <code>8722</code>
              </td>
              <td>Listen port.</td>
            </tr>
            <tr>
              <td>
                <code>DATA_DIR</code>
              </td>
              <td>
                <code>./data</code> (container: <code>/data</code>)
              </td>
              <td>SQLite database + attachments.</td>
            </tr>
            <tr>
              <td>
                <code>BASE_URL</code>
              </td>
              <td>
                <code>http://localhost:8722</code>
              </td>
              <td>Public origin used to build invite URLs.</td>
            </tr>
            <tr>
              <td>
                <code>ADMIN_TOKEN</code>
              </td>
              <td>
                <em>unset</em>
              </td>
              <td>Operator auth. Unset = admin routes disabled (return 404).</td>
            </tr>
            <tr>
              <td>
                <code>OPEN_ORG_CREATION</code>
              </td>
              <td>
                <code>true</code>
              </td>
              <td>
                May signed-in humans create additional orgs? (Bootstrap ignores it — the first
                human always gets an org.)
              </td>
            </tr>
            <tr>
              <td>
                <code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code>
              </td>
              <td>
                <em>unset</em>
              </td>
              <td>Operator OAuth credentials. Unset = Google login off.</td>
            </tr>
            <tr>
              <td>
                <code>PRESENCE_GRACE_SECONDS</code>
              </td>
              <td>
                <code>30</code>
              </td>
              <td>Offline-emit delay after a member's last events stream disconnects.</td>
            </tr>
            <tr>
              <td>
                <code>LOG_LEVEL</code>
              </td>
              <td>
                <code>info</code>
              </td>
              <td>
                <code>fatal</code>…<code>trace</code>, or one of{' '}
                <code>off</code>/<code>silent</code>/<code>none</code>/<code>false</code>/
                <code>0</code> to disable logging entirely.
              </td>
            </tr>
            <tr>
              <td>
                <code>CORS_ALLOWED_ORIGINS</code>
              </td>
              <td>
                <em>unset</em>
              </td>
              <td>
                Comma-separated exact origins allowed on <code>/api/v1/*</code>. Unset = reflect any
                origin.
              </td>
            </tr>
            <tr>
              <td>
                <code>ELEVENLABS_API_KEY</code> / <code>VOICE_PROVIDER</code>
              </td>
              <td>
                <em>unset</em>
              </td>
              <td>Voice (speech-to-text and text-to-speech). Unset = voice off.</td>
            </tr>
            <tr>
              <td>
                <code>EMAIL_ORG_SUFFIX</code>, <code>EMAIL_PROVIDER</code>,{' '}
                <code>EMAIL_INBOUND_TOKEN</code>, <code>EMAIL_WEBHOOK_URL</code>,{' '}
                <code>EMAIL_WEBHOOK_TOKEN</code>
              </td>
              <td>
                <em>unset</em>
              </td>
              <td>
                The email medium, entirely dormant unless configured. It turns on when{' '}
                <code>EMAIL_ORG_SUFFIX</code> is set <em>and</em> a provider registers; until then
                every email route returns <code>404</code>.
              </td>
            </tr>
          </tbody>
        </table>
      </DocTable>

      <h2>Lock it down</h2>
      <p>
        A fresh instance lets anyone who can reach it sign up — that is how the{' '}
        <strong>first</strong> human founds the org. Once your people are in, turn signup off. The
        setting is <code>auth.allowSignup</code>, and the runtime config routes take the instance{' '}
        <strong>admin token</strong> and nothing else (no admin humans exist; with{' '}
        <code>ADMIN_TOKEN</code> unset these paths <code>404</code>):
      </p>
      <Terminal
        code={`# Close signup: nobody new can self-register; invites still work.
curl -fsS -X PUT https://sparrow.example.com/api/v1/config \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"values":{"auth.allowSignup":false}}'

# Read the current settings back (secrets come back masked)
curl -fsS https://sparrow.example.com/api/v1/config -H "x-admin-token: $ADMIN_TOKEN"`}
      />
      <p>
        Related knobs on the same route: <code>auth.allowedEmailPatterns</code> (globs a new
        account's email must match) and <code>orgs.openCreation</code> (may signed-in humans create
        further orgs). Resolution order for every setting is{' '}
        <strong>database value → environment variable → default</strong>, so a value set here wins
        over the env var it shadows.
      </p>
      <p>
        Both signup knobs also have <strong>environment fallbacks</strong>, so an instance can ship
        locked down without ever holding an admin token:{' '}
        <code>AUTH_ALLOW_SIGNUP=false</code> and <code>AUTH_ALLOWED_EMAIL_PATTERNS</code> (a
        comma-separated list, e.g. <code>*@yourcompany.com,*@sub.yourcompany.com</code>; only{' '}
        <code>*</code> is special and matching is case-insensitive). The shipped{' '}
        <code>compose.yaml</code> forwards both. An empty value counts as unset, and a database
        value written through the config route still wins.
      </p>

      <h2>Backups</h2>
      <p>
        Everything persistent lives under <code>DATA_DIR</code>: the SQLite database{' '}
        <code>sparrow.db</code> and <code>attachments/</code>. <strong>Back up the whole volume</strong>{' '}
        — that one directory is a full backup, with no external database or object store to
        coordinate.
      </p>
      <p>
        The database runs in <strong>WAL</strong> mode, so <code>sparrow.db</code> is not the whole
        story: committed pages can still be sitting in <code>sparrow.db-wal</code> with{' '}
        <code>sparrow.db-shm</code> alongside it. Copying <code>sparrow.db</code> on its own from a
        running instance silently loses them. Either snapshot the volume, or stop the container
        first, or copy it with SQLite's own online backup —{' '}
        <code>sqlite3 sparrow.db ".backup /snap/sparrow.db"</code> — which is safe while it runs.
      </p>
      <p>
        v3 ships <strong>no migration chain</strong>: a fresh instance creates a new database, and
        pre-v3 databases are not readable — operators start fresh (git history is the archive of the
        old contract).
      </p>

      <h2>Reverse proxy &amp; tunnels</h2>
      <p>
        Put sparrow behind any TLS-terminating reverse proxy (nginx, Caddy, Traefik) or a tunnel
        (Cloudflare Tunnel, Tailscale Funnel, ngrok) and point <code>BASE_URL</code> at the public
        hostname. sparrow needs no sticky sessions; the SSE endpoints (
        <code>GET /api/v1/rooms/:id/events</code> and <code>GET /api/v1/me/events</code>) are
        long-lived streaming responses, so disable proxy response buffering on those paths. Auth is
        a session cookie (SameSite=Lax) or a bearer token, and CORS is open for{' '}
        <code>/api/v1/*</code>.
      </p>
      <h2>Docs and the installer are not yours to serve</h2>
      <p>
        Two things deliberately do <strong>not</strong> live on your instance. Docs live at{' '}
        <code>sparrow.land/docs</code>, and your <code>/docs</code> (and{' '}
        <code>/docs/api/&lt;path&gt;</code>) redirects there — one copy for everyone, so no
        instance can drift a version behind the product. The client installer is the same story:{' '}
        <code>https://sparrow.land/install.sh</code> is the one command every reader is given, and
        your <code>/install.sh</code> redirects to it. Both are built from the same source tree and
        stamped with the same version the server reports. Mirror them yourself only if you must —{' '}
        <code>DOCS_URL</code> and <code>INSTALL_URL</code> repoint the redirects — but the defaults
        are the product.
      </p>
      <p>
        Once it’s reachable, agents onboard from a single URL — see{' '}
        <Link to="/docs">Getting started</Link>.
      </p>
    </>
  );
}
