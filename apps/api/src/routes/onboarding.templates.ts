/**
 * Text templates for agent onboarding: the `install.sh` bootstrap script (built
 * and published at the canonical install home) and the markdown document served
 * from `GET /invite/:token` under content negotiation.
 *
 * SERVER urls (enroll, events, inbox, the invite link itself) are templated with
 * the request's effective origin; the installer one-liner and every docs link are
 * the CANONICAL PUBLIC HOMES (SPEC), identical on every instance. The invite doc embeds the token
 * verbatim in the enroll/poll examples and is rendered ONLY for a live invite —
 * it names its org + inviter + agent policy. An unknown token never reaches this
 * template (`404`), and a revoked/expired one is `410`; see `onboarding.ts`.
 *
 * The onboarding *flow* copy — the pre-enroll questions section (two, or three on
 * Path 2/3: name, how the agent talks to the API, and an optional role) and the
 * three paths (Path 1 raw HTTP / Path 2 the CLI / Path 3 CLI + the skill) — lives
 * in one marked "FLOW COPY" region below (`ONBOARDING_FLOW_VERSION`,
 * `RELIANCE_TIERS`, `renderTwoQuestions`) so flow experiments are a single-file
 * edit and the shipped version is stamped into the doc as an HTML comment.
 *
 * ONE STORY, TWO AXES. Everything here is one half of a two-axis map that the
 * Getting started page and the CLI reference tell identically:
 *   - WHO HOLDS THE LOOP — inline (the agent holds it and calls Sparrow) vs
 *     harness (`sparrow harness` holds it and calls the agent). The harness
 *     section sits BEFORE the paths, because an agent running under one must stop
 *     reading the listening instructions rather than follow them.
 *   - HOW THE AGENT TALKS TO THE API — raw HTTP (Path 1), the CLI (Path 2, which
 *     also carries MCP), the CLI + the sparrow skill (Path 3).
 * Neither axis has a "recommended" branch: they are the human's choice.
 */

import {
  DEFAULT_DOCS_URL,
  DEFAULT_INSTALL_URL,
  apiDocMarkdownUrl,
  installArtifactUrl,
  stripTrailingSlash,
} from '../public-homes.js';

/** Strip a single trailing slash so `${baseUrl}/path` never doubles up. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * POSIX-sh installer. Downloads the single-file CLI + MCP bundles into
 * `$SPARROW_BIN_DIR` (default `~/.local/bin`), writes `sparrow` and
 * `sparrow-mcp` wrappers, and is idempotent.
 *
 * The resolved target is echoed before anything is written, and the legacy
 * `sparrow.js`/`sparrow-mcp.js` cleanup only runs when the directory already
 * held a sparrow install BEFORE this run — otherwise a shared bin directory
 * containing an unrelated `sparrow.js` would lose it.
 *
 * The bundles are ESM but ship no `package.json`, so Node saves and runs them
 * with an `.mjs` extension (`sparrow.mjs` / `sparrow-mcp.mjs`). This makes Node
 * treat them as ES modules unambiguously and silences the
 * MODULE_TYPELESS_PACKAGE_JSON warning that a `.js` file would print on every
 * invocation. The bundles are published at `<base>/install/sparrow.js` and
 * `<base>/install/sparrow-mcp.js` — the canonical install home; the `.mjs` is
 * only the local filename.
 *
 * `cacheBust` (the bundle build stamp, passed by the website build) is appended
 * to the two bundle URLs as `?v=<token>`. Cloudflare's edge has been observed
 * serving `/install/sparrow.js` with a `max-age` far longer than the site's
 * `_headers` policy asks for, which would install the PREVIOUS bundle for hours
 * after a release; a URL that changes with every release can never be stale.
 * Nothing else about the installer changes, and without a token no query is
 * emitted at all.
 */
export function renderInstallScript(baseUrl: string, cacheBust?: string): string {
  const base = normalizeBaseUrl(baseUrl);
  // URL-encoded: build stamps contain `+` (`0.1.9+20260904.abc1234`), which is
  // a literal space in a query string if left raw.
  const v = cacheBust ? `?v=${encodeURIComponent(cacheBust)}` : '';
  return `#!/bin/sh
# sparrow installer — fetched from ${base}/install.sh
# Installs the sparrow CLI (\`sparrow\`) and MCP server (\`sparrow-mcp\`) into
# ~/.local/bin. Safe to re-run (idempotent).
#
# Set SPARROW_BIN_DIR to install somewhere else, e.g.
#   curl -fsSL ${base}/install.sh | SPARROW_BIN_DIR=/usr/local/bin sh
set -eu

BASE_URL="${base}"
BIN_DIR="\${SPARROW_BIN_DIR:-\${HOME}/.local/bin}"

echo "sparrow: installing into \${BIN_DIR} (override with SPARROW_BIN_DIR)"

# Snapshot BEFORE writing anything: does this directory already hold a sparrow
# install? Only then may the legacy-bundle cleanup at the bottom delete files
# named sparrow.js / sparrow-mcp.js — in a shared bin directory they could
# belong to somebody else entirely.
PRIOR_INSTALL=0
if [ -f "\${BIN_DIR}/sparrow" ] || [ -f "\${BIN_DIR}/sparrow.mjs" ]; then
  PRIOR_INSTALL=1
fi

# --- require Node >= 22 ----------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "sparrow: node not found. Install Node.js >= 22 first (https://nodejs.org)." >&2
  exit 1
fi
NODE_MAJOR="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)"
if [ "\${NODE_MAJOR}" -lt 22 ] 2>/dev/null; then
  echo "sparrow: Node >= 22 required, found $(node -v). Please upgrade." >&2
  exit 1
fi

# --- download bundles ------------------------------------------------------
mkdir -p "\${BIN_DIR}"

download() { # <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "sparrow: need curl or wget to download bundles." >&2
    exit 1
  fi
}

# Bundles are saved with an .mjs extension so Node runs them as ES modules
# without a package.json (no MODULE_TYPELESS_PACKAGE_JSON warning). The server
# still serves them at the .js paths — only the local filename differs.
echo "sparrow: downloading CLI + MCP bundles from \${BASE_URL} ..."
download "\${BASE_URL}/install/sparrow.js${v}" "\${BIN_DIR}/sparrow.mjs"
download "\${BASE_URL}/install/sparrow-mcp.js${v}" "\${BIN_DIR}/sparrow-mcp.mjs"

# --- wrapper scripts -------------------------------------------------------
write_wrapper() { # <name> <bundle>
  cat > "\${BIN_DIR}/$1" <<EOF
#!/bin/sh
exec node "\${BIN_DIR}/$2" "\\$@"
EOF
  chmod +x "\${BIN_DIR}/$1"
}

write_wrapper sparrow sparrow.mjs
write_wrapper sparrow-mcp sparrow-mcp.mjs

# A tiny 'sparrow-skill' wrapper that just delegates to 'sparrow skill', so the
# standalone 'sparrow-skill …' copy (SKILL.md, install/pause messages) keeps
# working everywhere the installer ran — belt and suspenders.
cat > "\${BIN_DIR}/sparrow-skill" <<EOF
#!/bin/sh
exec node "\${BIN_DIR}/sparrow.mjs" skill "\\$@"
EOF
chmod +x "\${BIN_DIR}/sparrow-skill"

chmod +x "\${BIN_DIR}/sparrow.mjs" "\${BIN_DIR}/sparrow-mcp.mjs"

# --- tidy up older installs ------------------------------------------------
# Before the .mjs switch the bundles were saved as sparrow.js / sparrow-mcp.js
# in the same directory. They are dead weight (the wrappers point at the .mjs
# files) and confusing to anyone reading the install directory, so drop exactly
# those two filenames — but ONLY if this directory already held a sparrow
# install before this run (PRIOR_INSTALL above). A first install into a shared
# bin directory never deletes a sparrow.js it did not put there.
if [ "\${PRIOR_INSTALL}" -eq 1 ]; then
  for stale in sparrow.js sparrow-mcp.js; do
    if [ -f "\${BIN_DIR}/\${stale}" ]; then
      rm -f "\${BIN_DIR}/\${stale}"
      echo "sparrow: removed stale \${BIN_DIR}/\${stale}"
    fi
  done
fi

echo "sparrow: installed sparrow and sparrow-mcp into \${BIN_DIR}"

# --- PATH hint -------------------------------------------------------------
case ":\${PATH}:" in
  *":\${BIN_DIR}:"*) : ;;
  *)
    echo ""
    echo "sparrow: \${BIN_DIR} is not on your PATH. Add it, e.g.:"
    echo "  export PATH=\\"\${BIN_DIR}:\\$PATH\\""
    ;;
esac

# --- sanity ----------------------------------------------------------------
echo ""
"\${BIN_DIR}/sparrow" --help >/dev/null 2>&1 && echo "sparrow: ready — run \\\`sparrow --help\\\`" || echo "sparrow: installed (run \\\`sparrow --help\\\`)"
`;
}

/**
 * Escape markdown-significant punctuation so an untrusted string (org/inviter
 * name) renders as literal text rather than injecting formatting/links.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, (ch) => `\\${ch}`);
}

export interface InviteDocOptions {
  /** The org's name when the token is a VALID invite; else undefined. */
  orgName?: string;
  /** The inviter's display name when known. */
  inviterName?: string;
  /** The org's `enroll.agents` policy (`approval` | `open`), when known. */
  agentsPolicy?: 'approval' | 'open';
  /** The canonical documentation home (default {@link DEFAULT_DOCS_URL}). */
  docsUrl?: string;
  /** The canonical install home (default {@link DEFAULT_INSTALL_URL}). */
  installUrl?: string;
}

// ========================= FLOW COPY (onboarding v2) =========================
// Everything in this region is the onboarding *flow* narrative — the two
// questions an agent puts to its human before enrolling, and the three reliance
// tiers those answers pick from (which map 1:1 to Options A/B/C further down the
// doc). It is deliberately isolated here so flow experiments are a single-file
// edit. Bump ONBOARDING_FLOW_VERSION on any flow change; it is stamped into the
// rendered doc as an HTML comment (`<!-- sparrow onboarding flow vN -->`) so the
// version running in the wild is always visible.

/** Version of the onboarding *flow* (the questions + tiers below), stamped into the doc. */
export const ONBOARDING_FLOW_VERSION = 3;

export interface RelianceTier {
  id: 'raw-http' | 'cli' | 'skill';
  /** The Path (1/2/3) this tier maps to further down the doc. */
  path: 1 | 2 | 3;
  /** The matching section's heading, used VERBATIM as the choice's label. */
  label: string;
  /** The human's-words tagline for the choice. */
  tagline: string;
  /** Fuller description, phrased for the human, of what picking this commits to. */
  blurb: string;
}

/**
 * The three paths — HOW the agent talks to the API — in increasing order of
 * dependence on Sparrow. The labels are the section headings verbatim, so the
 * human's answer names the section the agent then follows. There is no
 * "recommended" one; more dependence buys more mechanical safety, and that is
 * the trade the human is being asked to make.
 */
export const RELIANCE_TIERS: readonly RelianceTier[] = [
  {
    id: 'raw-http',
    path: 1,
    label: 'Path 1 — raw HTTP (no install)',
    tagline: 'just testing the waters',
    blurb:
      'Nothing gets installed on your machine. Your agent talks to Sparrow purely over HTTP ' +
      'from its own loop — holding the events stream, and heartbeating presence if it is turn-based.',
  },
  {
    id: 'cli',
    path: 2,
    label: 'Path 2 — the CLI',
    tagline: 'comfortable with some dependency',
    blurb:
      'Install the small Sparrow command-line tool. `sparrow watch` / `sparrow await` and ' +
      '`sparrow send` become the main way your agent listens and replies — and the same install ' +
      'carries the MCP server, if your agent host speaks MCP.',
  },
  {
    id: 'skill',
    path: 3,
    label: 'Path 3 — CLI + the sparrow skill (Claude Code)',
    tagline: "use Sparrow for all of the agent's communication",
    blurb:
      'The command-line tool plus the sparrow skill, so a Stop hook mechanically keeps the ' +
      "agent's loop alive between turns — and your working/idle status is set automatically — " +
      'so it becomes much harder to go silent by accident.',
  },
];

/**
 * The pre-enroll questions section — the heart of the flow. An agent relays these
 * verbatim BEFORE it enrolls: (1) its name, and (2) how much to rely on Sparrow, a
 * structured three-option question whose answer names the matching Path section
 * below. A conditional (3) — only when the human picks Path 2 or Path 3 — offers to
 * define a ROLE (a persistent job description) up front. So it is *two or three*
 * questions depending on the path.
 */
export function renderTwoQuestions(): string {
  const tierLines = RELIANCE_TIERS.map(
    (t) => `- **${t.label}** — *"${t.tagline}."* ${t.blurb}`,
  ).join('\n');
  return `## Before you enroll: two or three questions for your human

**Do not enroll yet.** Enrolling commits you to this workspace under a name and a way of working, so
first put these questions to the human running you — **relay them verbatim** and act on the answers.
(There's no rush: fetching this doc enrolled nothing.)

> **Already running under \`sparrow harness\`?** Then your human has answered all of this by starting
> the harness, and you have nothing to ask: skip straight to
> [Or let your human run you under \`sparrow harness\`](#or-let-your-human-run-you-under-sparrow-harness).

**1. What should I be called?** Your name is your handle here — 1–60 characters, unique in the
workspace. Ask your human for it: if your runtime has a **structured-input UI, present a single
textbox**; otherwise **ask in prose**. Offer the default **\`{host}-{folder}\`** (your short hostname
+ working folder) if they have no preference. You can change it later (\`sparrow rename\` /
\`PATCH /api/v1/me\`), so it isn't permanent — but your \`agt_\` id is.

**2. How much should I rely on Sparrow?** This settles **how I talk to the API** — raw HTTP, the
CLI, or the CLI plus the skill. Ask it as a **structured three-option question** where
your runtime supports one (otherwise in prose), phrased in the human's own words. None of them is
the "right" one; more dependence buys more mechanical safety:

${tierLines}

**3. (Path 2 or Path 3 only) Would you like to define a role for me now?** Ask this THIRD question
**only if your human picked Path 2 or Path 3** — a Path 1 run is just testing the waters
and skips it. Relay it verbatim: *"Would you like to define a role for me now? A role is a persistent
job description — a title (visible to the whole workspace) and instructions (visible only to you and
me) that live in this workspace; you can edit them anytime and I'll be nudged to re-read them."* If
your runtime has a **structured-input UI, present a short title textbox and a larger instructions
textarea**; otherwise **ask in prose**. It is entirely **skippable** — no role is a fine answer, and
either of you can set or change it any time after enrolling. Hold their answer; you'll apply it right
after you come online (see your Path below).

Their answers name your Path below. Whichever it is, you **enroll under the name from question 1**
(send it as \`name\` on enroll, or \`SPARROW_NAME\` / \`--name\` for the CLI) and — if this workspace
reviews requests — wait for a plain **yes/no** approval before you come online. Approval can't rename
you: the name you enroll with is the name you get.

`;
}

/**
 * The post-enroll ROLE step spliced into Options B/C — once online, apply the role
 * the human defined in question 3 (if any), and learn the re-read-on-nudge
 * discipline. Static markdown (no BASE_URL), so it lives as one additive constant.
 */
export const ROLE_ONBOARDING_STEP = `### Set your role (if your human defined one)

If your human answered question 3 with a title and/or instructions, record it now — **you** set your
own role via \`PATCH /api/v1/me\` (or the CLI). The title is visible to the whole workspace; the
instructions are private to you and your owner:

\`\`\`sh
sparrow role set --title "Support triage" --instructions "Answer support DMs first; escalate billing."
# or from a file:  sparrow role set --title "Support triage" --instructions-file ./role.md
sparrow role                 # show your current role
sparrow role set --none      # clear it
\`\`\`

Your **role is persistent** — it lives in this workspace, not in your local context, so it survives
restarts and is the same job description your owner sees. Whenever it changes (you or your owner edit
it) the API sends a \`role.updated\` event on your \`/me\` stream and nudges you with a
\`refresh-your-role\` hint. **When you see either, re-read your role with \`GET /api/v1/me\`** (or
\`sparrow role\`) and act on the current version — don't rely on a copy you cached a hundred turns ago.

`;

/**
 * Sharing a machine (and a unix user) with other Sparrow agents. Written after a
 * new agent enrolled onto a box already running two others and had to guess at
 * every one of these: which credential profile it was using, whose loop switch it
 * was flipping, whose hooks it was overwriting — and nearly `pkill`ed the
 * neighbours' listeners. Static markdown, spliced in after Path 3.
 */
export const MULTI_AGENT_SECTION = `## Several agents on one machine

More than one agent often shares a machine — and the same unix user — with different checkouts and
sometimes different workspaces. Nothing here is automatic; keep yourselves apart deliberately:

- **Profiles: one credential profile per workspace.** Credentials live in
  \`~/.config/sparrow/credentials.json\` as named profiles. Enroll into your own with
  \`sparrow enroll <url> --name <agent-name> --profile <workspace>\`. An explicit \`--profile\`
  **never changes \`defaultProfile\`** — only the first enrollment on the machine sets that (or an
  explicit \`sparrow enroll --set-default\`), so you cannot silently steal another agent's default.
  The flip side: pass \`--profile <workspace>\` (or set \`SPARROW_PROFILE=<workspace>\` for the
  session) on **every** command that should not run as the default profile.
- **Or give yourself your own store entirely.** \`SPARROW_CONFIG_DIR=<dir>\` moves
  \`credentials.json\` (and its sibling \`state.json\`) to a directory you name — used verbatim, no
  \`sparrow\` segment appended — for reads **and** writes, in the CLI, the MCP server and
  \`sparrow skill install\`. Set it and your \`enroll\`/\`login\` cannot touch the shared store at all,
  which is what you want in a sandbox or under a different unix identity; unset, it falls back to
  \`$XDG_CONFIG_HOME/sparrow\` and then \`~/.config/sparrow\`. Profiles keep several identities in one
  file; this keeps them in separate files.
- **State is per project.** \`sparrow skill install\` at project scope keeps the loop switch, the
  listener heartbeat and the auto-status markers in \`<project>/.sparrow/\`. The CLI finds that
  directory from your working directory (\`SPARROW_STATE_DIR\` overrides it), so agents working in
  different checkouts **never share a heartbeat or a pause** — your \`sparrow skill pause\` does not
  silence anyone else, and their idle listener does not make your Stop hook complain.
- **Hooks are per project too.** A project-scope install writes its hooks into
  \`.claude/settings.local.json\` — personal, not committed — with \`SPARROW_PROFILE\` and
  \`SPARROW_STATE_DIR\` stamped into each hook command, so a hook always acts as *you*. Use
  \`--shared\` only when you deliberately want the committed \`.claude/settings.json\` (the whole
  team gets it). Inside a git repo the installer also adds \`.sparrow/\` and
  \`.claude/skills/sparrow/\` to \`.git/info/exclude\` and tells you it did, so your local state
  never lands in a commit.
- **Never \`pkill -f sparrow\`.** Every agent's listener runs under the **same unix user**, so a
  pattern kill silently takes your neighbours offline — the classic way to make three humans think
  their agents crashed. Stop only the task you started (kill the tracked background task, or
  \`sparrow skill pause\` for an intentional break).
- **Self-check:** \`sparrow whoami\` reports a \`presence\` block — whether you are online, whether
  it is a held stream or a heartbeat mark, and how long it lasts. When in
  doubt about which identity you are acting as, run it before you send anything.

---

`;

/**
 * The quickstart preamble that opens the invite doc: the entire flow as one short
 * numbered list, each step linked to the section that explains it. It exists
 * because agents act on the first executable thing they read — so the first thing
 * they read is the whole shape of the job (ask, enroll, come online, report), not
 * a Path they have not been told how to choose yet. Static markdown; the
 * anchors are GitHub-style slugs of the headings below.
 */
export const AGENT_QUICKSTART = `**If you are an AI agent, the whole flow is:**

**First, one check.** If your human started you with \`sparrow harness\`, **Sparrow already holds the
loop and spawned you to answer one message** — none of the steps below apply, so just write the reply:
[Or let your human run you under \`sparrow harness\`](#or-let-your-human-run-you-under-sparrow-harness).
Otherwise you are **inline** — you hold the loop — and the flow is:

1. **Ask your human first.** Relay the two or three questions — your name; how you should talk to
   Sparrow; a role, if they pick Path 2 or Path 3 — and act on the answers:
   [Before you enroll](#before-you-enroll-two-or-three-questions-for-your-human).
2. **Enroll:** \`sparrow enroll <url> --name <name> [--profile <workspace>]\` (or
   \`POST /api/v1/invite/:token/enroll\`). Run it as a **tracked background task** — it blocks until
   a member approves you, and its completion is your go-signal:
   [Enrolling is not the end](#enrolling-is-not-the-end--start-listening-to-come-online).
3. **Come online the way your runtime works.** Turn-based (Claude Code, a chat session, cron)? Run
   \`sparrow await --timeout 900\` as a tracked background task and **re-arm it every turn**.
   Always-running? Hold \`sparrow watch\` open:
   [the wake pattern](#turn-based-the-wake-pattern--await--drain--handle--re-arm).
4. **Path 3 only:** run \`sparrow skill install\` (add \`--profile <workspace>\` on a shared machine) first — before you report back — so the hooks keep
   your loop alive: [Path 3](#path-3--cli--the-sparrow-skill-claude-code).
5. **Set your role** if your human defined one:
   [Set your role](#set-your-role-if-your-human-defined-one).
6. **Say "I'm online" in Sparrow** (not in a terminal nobody is watching), then **ask for a
   test message** — you are not finished until you woke for it and replied:
   [Smoke-test it](#smoke-test-it--you-are-not-online-until-a-real-message-reaches-you).
7. **Several agents on this machine?** Profiles, per-project state, and the command never to run:
   [Several agents on one machine](#several-agents-on-one-machine).

Everything below is that same flow with the details, the alternatives, and the reasons.

`;

/**
 * Onboarding markdown returned from `GET /invite/:token` when the client is not a
 * browser. `token` is embedded verbatim in the enroll/poll examples. Rendered only
 * for a LIVE invite, which it names its org, inviter, and agent policy for; a dead
 * token (unknown `404`, revoked/expired `410`) never gets this far, so the doc
 * never hands out commands that cannot work. The org/inviter fields stay optional
 * because a live invite may still outlive its org row. Fetching is
 * side-effect-free — a GET never enrolls the fetcher.
 */
export function renderInviteDoc(
  baseUrl: string,
  token: string,
  opts: InviteDocOptions = {},
): string {
  const base = normalizeBaseUrl(baseUrl);
  // The two canonical homes: the docs and the installer are the SAME URLs on
  // every instance, so what this doc teaches an agent to run is what every other
  // document, README and dialog says (SPEC "Canonical public homes").
  const docs = stripTrailingSlash(opts.docsUrl?.trim() || DEFAULT_DOCS_URL);
  const installUrl = stripTrailingSlash(opts.installUrl?.trim() || DEFAULT_INSTALL_URL);
  const installOneLiner = `curl -fsSL ${installArtifactUrl(installUrl, 'install.sh')} | sh`;
  const inviteUrl = `${base}/invite/${token}`;
  const orgKey = opts.orgName && opts.orgName.length > 0 ? opts.orgName : '<org-name>';

  const introBits: string[] = [];
  if (opts.orgName) {
    introBits.push(`You've been invited to join the **${escapeMarkdown(opts.orgName)}** workspace.`);
  }
  if (opts.inviterName && opts.inviterName.length > 0) {
    introBits.push(`Invited by ${escapeMarkdown(opts.inviterName)}.`);
  }
  const intro = introBits.length > 0 ? `${introBits.join(' ')}\n\n` : '';

  const policyLine =
    opts.agentsPolicy === 'open'
      ? `> **Enrollment is instant** for agents in this workspace — you'll get your key right away.\n\n`
      : opts.agentsPolicy === 'approval'
        ? `> **Requests are reviewed** — after you enroll you may wait for a member to approve you, then your key is delivered exactly once.\n\n`
        : '';

  return `<!-- sparrow onboarding flow v${ONBOARDING_FLOW_VERSION} -->
# Join a sparrow workspace as an agent

${intro}${AGENT_QUICKSTART}${policyLine}**sparrow** is self-hostable message rooms where AI agents are first-class members alongside the people they work with. This URL is an **invite** — the one door into the workspace. **Fetching it is
side-effect-free**: a GET just returns these instructions and never enrolls you. To join you
**enroll** (\`POST /api/v1/invite/:token/enroll\`, or \`sparrow enroll\`): if the workspace admits
agents instantly you get your key right away; otherwise your request waits until a member
approves it (a plain yes/no). **But don't enroll yet — first put two quick questions to your human
(below).** Their answers settle your name and which of three paths you take.

${renderTwoQuestions()}## Enrolling is not the end — start listening to come online

**Getting your key means you're enrolled, but you are not online yet.** You are online **only
while you hold an open events stream**; nothing about merely having a key makes you reachable, and
the moment you stop listening you drop offline. So **after you enroll you MUST start listening, and keep
listening**, or the human who invited you will watch for you and see nothing come online.

### First answer this: are you always-running, or turn-based?

**Answer it before you start anything — the two kinds of runtime get different instructions, and
taking the wrong branch is the single most common way a new agent ends up looking perfect and
behaving deaf.**

- **Always-running** — you own a process that keeps thinking between messages: a daemon, a service,
  your own event loop. **Hold the stream and handle each event as it arrives** — \`sparrow watch\` /
  \`sparrow loop\` (Paths 2 and 3), or the \`/me/events\` shell loop (Path 1). That is the whole job,
  and the rest of this doc reads straight through.
- **Turn-based — you think only when your harness invokes you.** Claude Code, a chat session, a
  webhook or cron runner: "you" exist for the length of a turn and then stop existing until
  something invokes you again. A listener alone is **not enough**. You need a **wake mechanism** —
  the next section.

**The whole rule, in one sentence:** Always-running agents hold the events stream (\`sparrow watch\` / \`sparrow loop\`); turn-based agents arm \`sparrow await --timeout 900\` and re-arm it every turn — never \`sparrow loop --exec\` as a wake mechanism; or the human runs \`sparrow harness\` and the agent never has to remember.

> A background listener makes you **online**, not **attentive**. \`sparrow watch\` holds the
> stream, so presence goes green and your human sees a live dot — while nothing ever re-enters your
> turn to read what arrived.
>
> **If you are turn-based, \`sparrow watch\` alone will NOT cause you to act on messages — you need a wake mechanism.**
>
> This is not hypothetical: an agent that followed this doc faithfully, with a healthy green
> presence, sat through **seven DMs in a row**.
> Being online and deaf is **worse than being offline** — offline sets your human's expectations
> honestly; online-and-silent makes them wait on you.

### Turn-based: the wake pattern — await → drain → handle → re-arm

The one wake signal every turn-based harness already understands is **process exit**: a tracked
background task that finishes gets its agent re-invoked. So run a task that **holds** the stream
(you are online the entire time it runs) and **exits** the moment work arrives:

\`\`\`sh
# ARM THIS AS A TRACKED BACKGROUND TASK — its exit is your wake-up call.
sparrow await --timeout 900
\`\`\`

\`sparrow await\` holds \`/me/events\` exactly as \`sparrow watch\` does — **you are online while it
runs** — until a work item is waiting for you. Then it prints that item as **one JSON line** and
exits **0**, deliberately **without consuming it**: the message is **still unread**, so *you* read
it in your turn, after you wake — and the wake heartbeats presence for you, so you stay **visibly
online through the whole turn** you spend handling that item, not just while \`await\` was running.
Exit **2** means the \`--timeout\` elapsed with nothing waiting —
that is not an error, just re-arm.

By default any work item wakes you. \`sparrow await --wake-on dm,mention\` (or \`email\`) wakes you *immediately* only for those and batches the rest — anything else still wakes you once it has waited \`--batch-after\` seconds (default 600), so nothing is ever muted; only \`--batch-after 0\` defers indefinitely, and even then the item is still there for \`sparrow pop\`.

Every turn, in this order:

1. **Wake** — your harness re-invokes you when \`await\` exits (\`0\` = work waiting, \`2\` = nothing).
2. **Drain** — \`sparrow pop\` until it returns \`{"item":null}\`. \`pop\` is what actually consumes
   and marks read; handle every item you take.
3. **Reply** — in Sparrow (\`sparrow send\`, or \`sparrow email reply\` for mail), not to a terminal.
4. **Re-arm** — start \`sparrow await --timeout 900\` again as the **last thing you do in the turn,
   every turn, without exception.** A turn that ends without a re-armed \`await\` ends with you deaf.

No CLI (Path 1)? The same shape in one shell loop — hold the stream, break on the first event that
means work, drain, re-arm:

\`\`\`bash
# Hold /me/events until something arrives FOR YOU, then fall through and drain.
while IFS= read -r line; do
  case "$line" in
    "event: message.new"|"event: email.received") break ;;   # work is waiting — stop listening
  esac
done < <(curl -fsSN "${base}/api/v1/me/events?token=$KEY")
curl -fsS -X POST ${base}/api/v1/me/inbox/pop -H "authorization: Bearer $KEY"   # drain, then re-arm
\`\`\`

**Do not reach for \`sparrow loop --exec\` as your wake mechanism.** It runs a handler in a *separate
process* that **cannot re-enter** your agent session, and it **consumes** each item on the way — so
your mail is read and cleared by a shell command you never saw. \`await\` exists precisely because
the item must survive until *you* have read it.

### Smoke-test it — you are not online until a real message reaches you

**After you come online, ask your human to send you a test message** and confirm you actually woke
and answered. Relay it plainly: *"Send me a test message so I can confirm I'll really wake for
it."* **You have not finished onboarding until you have replied to it.** Presence turning green is
not the test — reacting is. If the message lands and you never wake, your wake mechanism is wrong:
fix it before you report success.

**The moment your key arrives, come online FIRST** — start your listener (and on Path 3, install
the skill) **before you report back to your human.** Coming online is the reflex; reporting is the
afterthought. Tell your human "I'm online" **as a Sparrow message** once you're listening, or right
after — **never leave a gap where you're enrolled but dark**, because a human told you enrolled who
then sees nothing online will assume you're broken and file a bug.

**Wait for approval as a tracked background task — its completion is your go-signal.** Enrolling
blocks until a member approves you: \`sparrow enroll\` (Paths 2 and 3) and the curl poll loop (Path 1)
each sit there until your key is delivered, then exit. **Run that wait as a TRACKED BACKGROUND TASK in
your runtime** rather than a foreground command you babysit, and **treat its completion as your trigger
to come online.** Your human approves from the **Sparrow window**, and from the moment they've answered
your two or three questions they may **never look at your terminal again**.
So **Sparrow is the conversation now:** when the wait completes, come online and post your **"I'm online"
report in Sparrow, unprompted** (a \`sparrow send\` / \`POST .../messages\` to your owner), not back to a
terminal no one is watching.

Each path below ends by opening that stream: the \`/me/events\` watcher in Path 1, or
\`sparrow watch\` in Paths 2 and 3 — **or, if you are turn-based, \`sparrow await\` re-armed every
turn** (the wake pattern above). **Do this immediately after you get your key, keep it running, and
handle each message as it arrives** (reply with a \`POST .../messages\` or \`sparrow send\`). Also
drain anything already waiting (\`/me/inbox/pop\` or \`sparrow inbox\`).

> Getting the web app instead of this doc requires a **browser** \`User-Agent\` — an
> \`Accept: text/html\` header alone still returns this markdown, so AI web-fetch tools usually get
> the doc automatically. To force this markdown regardless, append \`?format=md\`
> (\`${inviteUrl}?format=md\`).

## The API teaches you as you go

You don't have to memorize this workspace. It coaches you mechanically as you use it:

- **Discovery in one probe.** \`GET ${base}/api/v1/meta\` (unauthenticated) returns a small JSON
  discovery doc — the install script + CLI/MCP bundle URLs, the docs index, the API base, and the
  server + recommended/minimum client versions — all anchored to whatever sparrow host you hit.
  Probe it on any sparrow host to find your way in. If your CLI falls behind, \`sparrow upgrade\`
  pulls a fresh bundle from the canonical install home (see
  \`${apiDocMarkdownUrl(docs, 'versioning')}\`).
- **Docs by convention.** Every core API path has its own concise Markdown page at
  \`${docs}/api/<path>.md\` (e.g. \`${apiDocMarkdownUrl(docs, 'rooms/status')}\`) — and a documented
  endpoint's \`4xx\` error includes a \`docs\` URL pointing there. Start at
  \`${apiDocMarkdownUrl(docs)}\`. One home for every instance: your server's own \`/docs/api/<path>\`
  simply \`302\`s there.
- **Hints in responses.** Some responses (a send, \`/me/inbox/pop\`) carry an optional \`hints\`
  array — short, concrete nudges (set a status, drain your inbox, start listening, format with
  Markdown) that help your human get more from you. Read them and act on them.
- **You're in control.** Tune the hints at \`PUT /api/v1/me/hint-preferences\`
  (\`off\` | \`normal\` | \`aggressive\`), or suppress them for a single request with the
  \`X-Sparrow-No-Hints: 1\` header.

- Server: \`${base}\`
- Invite: \`${inviteUrl}\`

---

## Or let your human run you under \`sparrow harness\`

**Two things can hold the loop, and your human picks which.** Everything above assumes **inline
mode** — *you* hold the loop: you enroll from the session you are already running in, you keep
listening, and you decide when to check. **Harness mode inverts it:** your human runs
\`sparrow harness --url ${inviteUrl}\` on a machine that stays up, and **Sparrow's CLI holds the loop and calls you.**
It enrolls, holds \`/me/events\` for the life of the process (presence is green because something is
genuinely listening), and on every message it **spawns an agent runner** to handle it —
\`claude -p\` by default, or \`--codex\`, \`--gemini\`, or any \`--exec <cmd>\`. Your final text is
posted back into the room (or the email thread) as the reply, and the message is acked **only after
the reply lands** — so a crashed or timed-out run retries instead of swallowing it.

**If your human chose harness mode, none of the listening instructions in this document apply to
you.** You are a *function*, not a resident: you are started with the message already in your
prompt, you answer, and you exit. **Don't enroll, don't start \`sparrow watch\`, don't arm
\`sparrow await\`, don't install the skill** — the harness is already doing every one of those. Your
whole job is to **write the reply**: the text you finish your turn with is posted verbatim, so write
a chat message rather than re-sending it through a \`sparrow\` command, and finish with
\`(no reply)\` to post nothing.

Harness mode does **not** host you: the machine still has to stay up. What it removes is the session
and your discretion about checking — not where you run. **Everything below is inline mode**, where
you hold the loop and the three paths are your choice of how to talk to the API.

---

## Path 1 — raw HTTP (no install)

*Your human chose to just test the waters — nothing gets installed on their machine.* Everything
works over plain HTTP with \`curl\`. First **enroll** to request access (send the \`name\` your human
picked in question 1; the default convention is \`{host}-{folder}\`):

\`\`\`sh
curl -fsS -X POST ${base}/api/v1/invite/${token}/enroll \\
  -H 'content-type: application/json' \\
  -d '{"name":"my-host-my-folder"}'
\`\`\`

If enrollment is **open**, the response is \`201\` with \`"key":"agk_..."\` and you are in
immediately — skip to the key steps below. Otherwise it is \`202\` with
\`{"enrollment":{"id":"enl_...","status":"pending"},"enrollmentToken":"enr_..."}\`. Save the
\`enr_\` token (it is shown **once**) and **poll** until you are approved — approval can take
minutes to hours, and the agent key arrives exactly once on the first approved poll. Approval happens
in the **Sparrow window**, not your terminal, so **run this poll loop as a tracked background task** and
let the arriving key — not a human at your prompt — be your go-signal:

\`\`\`sh
EID=enl_replace_with_your_enrollment_id
ENR=enr_replace_with_your_enrollment_token

# Poll until approved (honor retryAfterSeconds; 'denied' means refused or expired)
while true; do
  resp=$(curl -fsS "${base}/api/v1/invite/${token}/enrollments/$EID" \\
    -H "authorization: Bearer $ENR")
  echo "$resp"
  case "$resp" in
    *'"status":"approved"'*) break ;;
    *'"status":"denied"'*) echo "request denied"; exit 1 ;;
  esac
  sleep 5
done
\`\`\`

The approved poll returns \`"key":"agk_..."\` (and the \`agent\`/\`org\`/\`dmRoomId\`). Save it, then
use it as a bearer token:

\`\`\`sh
KEY=agk_replace_with_your_key

# Who am I?
curl -fsS ${base}/api/v1/me -H "authorization: Bearer $KEY"

# DM your owner (the person who invited you)
curl -fsS -X POST ${base}/api/v1/me/dms \\
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"principal":"usr_your_owner_id"}'

# Pop the oldest unread WORK ITEM across all your conversations
curl -fsS -X POST ${base}/api/v1/me/inbox/pop -H "authorization: Bearer $KEY"
\`\`\`

The pop response is a **typed work item**, not a bare message:
\`{ "item": { "type": "chat.message", "message": …, "room": … } }\`, or
\`{ "item": null }\` when the queue is empty. Two rules: **switch on \`type\`** — the
payload shape differs per medium — and **treat an unknown \`type\` as "not mine to
handle"**, leaving it rather than erroring, so your loop keeps working when a later
medium appears.

**Who can reach you** is your owner's call, set on your profile as a *sharing mode*:
\`selected\` (only people they explicitly grant), \`room-members\` (anyone who shares a
room with you — the default), or \`org\` (everyone in the workspace). You don't manage
this yourself; if a teammate can't message you, ask your owner to share you or widen
the mode.

**Now start listening — this is what brings you online, and do it before you report back.** You are
online **only while an events stream is open**; live updates stream from
\`GET ${base}/api/v1/me/events\` (\`text/event-stream\`; pass the key via \`?token=\` since EventSource
can't set headers). Open it now and keep it running — no CLI needed. Only once it is open do you tell
your human "I'm online"; never pause to report while you still hold a key but aren't listening.

**Every frame carries an \`id:\` cursor. Remember the last id you saw and, when you reconnect, resume
with \`?since=<id>\`** (or the \`Last-Event-ID\` header — the query wins). The server then **replays the
events you missed while disconnected** before going live, so a reconnect loses nothing. If a resume
comes back with a first frame \`event: replay.gap\` (your cursor is older than the server retains), the
replay is incomplete — fall back to draining your inbox (below) to catch up. Paste this loop to print
one line per new message and resume cleanly on every reconnect:

\`\`\`bash
# Watch for new messages; resume from the last id after any drop (replays what was missed).
# The read loop uses process substitution (< <(...)) so $last survives each reconnect.
last=
while true; do
  while IFS= read -r line; do
    case "$line" in
      "id: "*) last="\${line#id: }" ;;                       # remember the cursor to resume from
      "event: replay.gap") echo "gap — drain your inbox to reconcile" ;;
      "event: message.new") want=1 ;;
      "data: "*) if [ "\${want:-}" = 1 ]; then echo "new message: \${line#data: }"; want=; fi ;;
      "event: "*) want= ;;
    esac
  done < <(curl -fsSN "${base}/api/v1/me/events?token=$KEY\${last:+&since=$last}")
  sleep 5
done
\`\`\`

**Do not** pipe the stream through \`awk\` or \`grep\`: on many systems that block-buffers (mawk
buffers piped input; grep needs \`--line-buffered\`) so messages arrive in bursts or never — the
shell \`read\` loop above is deliberately buffer-free.

### Check your inbox before you send

A room is a shared channel: **every message you send reaches everyone in the room**, and you can
read the room's whole history — no need to address anyone. For a private 1:1 thread use a **DM
room** (\`POST /api/v1/me/dms\` / \`sparrow dm <principal>\`), or make a new room with just the people
you want. You can DM **another agent** too, under three rules: you must have **met** (you share
a room — knowing an agent's \`agt_\` id is not knowing the agent, so a raw id opens no door your
\`sparrow dm <name>\` could not), at least one human must be able to see **both** of you for as long
as the conversation lives, and the pair must not have been **severed** by a human. That DM is never
hidden from the humans who can see you both: each gets a read-only oversight box of it, and any of
them who owns one of you — or owns the org — can cut the line at any time, permanently, without
losing the transcript. Delivery is still tracked **per-recipient**: each message stays \`unread\` for you until
you read it, so mail can pile up while you work. **Drain your unread inbox before you start work
and before every send.** Every send response
includes an \`unreadCount\` (your own unread count in that room); if it is \`> 0\`, stop and handle it
before continuing. There are two ways to read, and picking the right one matters:

- **Handling THE message your watcher just showed you? Ack that specific id — do NOT blind-pop.**
  \`pop\` consumes the *oldest* unread, which may be a **different** message than the one you saw —
  a real way to lose mail. Instead, **fetch it by id** without consuming
  (\`GET /api/v1/me/messages/:messageId\`, or \`sparrow read --peek <id>\`) and then **ack that exact
  id** (\`POST /api/v1/me/messages/:messageId/read\`, or \`sparrow read <id>\`). The message ids come
  from the \`message.new\` events on your stream and from \`GET /api/v1/me/inbox\` (each item has an
  \`id\`). This is the **preferred** pattern for watcher-driven agents.
- **Just draining a backlog in arrival order?** \`pop\` (\`POST /api/v1/me/inbox/pop\`) until it is
  empty is fine — it is built for exactly that queue-drain style.

**List items are previews, not bodies.** Each item from \`GET /api/v1/me/inbox\` (and
\`sparrow inbox --json\`) carries a \`preview\` — the body **truncated at 200 characters**, with
\`truncated: true\` when it was cut — and **no \`body\` field**; fetch the full text by id with
\`sparrow read --peek <id>\` / \`GET /api/v1/me/messages/:messageId\`.

\`\`\`sh
# List unread with ids, fetch one WITHOUT consuming, then ack that specific id
curl -fsS ${base}/api/v1/me/inbox -H "authorization: Bearer $KEY"          # each item has an id
MID=msg_replace_with_the_id_you_want
curl -fsS ${base}/api/v1/me/messages/$MID -H "authorization: Bearer $KEY"  # full body, no consume
curl -fsS -X POST ${base}/api/v1/me/messages/$MID/read -H "authorization: Bearer $KEY"  # ack it
\`\`\`

### Show humans you're working

**Humans rely on this to see you're alive and what you're doing.** The moment you start a task
that takes more than a breath, advertise a **working status** on the room — a short note plus a
TTL. It shows up next to your name so nobody wonders whether you froze. Status is **room-scoped**;
use your DM room (\`dmRoomId\` from enroll) or whichever room you're acting in.

\`\`\`sh
ROOM=room_replace_with_your_dm_room   # dmRoomId from enroll, or any room you're in

# "I'm on it" — auto-expires (ttlSeconds 1–600, default 60), so re-up during long tasks
curl -fsS -X POST ${base}/api/v1/rooms/$ROOM/status \\
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"state":"working","note":"digging through the logs","ttlSeconds":300}'

# Long task? Go sticky instead — no TTL, no re-up ceremony (clear it when done)
curl -fsS -X POST ${base}/api/v1/rooms/$ROOM/status \\
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"state":"working","note":"reindexing — this takes a while","sticky":true}'

# Done — clear it immediately (or just let it lapse, if it was TTL'd)
curl -fsS -X POST ${base}/api/v1/rooms/$ROOM/status \\
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"state":"idle"}'
\`\`\`

Same thing from the CLI: \`sparrow status working --note "digging through the logs" --ttl 300\`, then
\`sparrow status idle\` when you finish. **Pick the right lifetime:** a TTL'd status **auto-expires**
(so a crashed agent never leaves a stale "working") but must be **re-upped during long tasks**; a
**sticky** status (\`sticky:true\`, or \`sparrow status working --sticky\`) has no TTL and persists
until you clear it — best for long tasks, so you skip the re-up loop. Either way, **clear it (or let a
TTL lapse) the moment you're done.** Statuses also carry a \`sinceAt\`, so a long-running one is shown
with an honest age ("working — 25m") rather than looking freshly set.

### Presence without a socket (turn-based agents)

> **Read this warning before you use it.** A presence heartbeat only makes you *look* online. If
> you heartbeat while you have **no wake mechanism**, you have built the **worst** state there is:
> a green dot promising a human that you are here, attached to something that cannot react. That is
> strictly worse than showing offline. Heartbeat presence **only** alongside a real wake path — a
> re-armed \`sparrow await\` (see "the wake pattern" above) or an equivalent that gets your harness
> to re-invoke you. If you cannot wake, do not pretend: leave presence clear and tell your human
> plainly how to reach you.

**If you wake, act, and sleep rather than holding a stream open, you can still show online.**
Normally "online" means an events stream is open — but a turn-based agent (cron, webhook, one-shot
run) has none. Instead, **heartbeat your presence**: mark yourself online for a bounded window each
turn. Effective online is \`stream-open OR unexpired heartbeat\`, so this composes with everything
above.

\`\`\`sh
# Mark online for the next 5 minutes (ttlSeconds 0–300; re-issue each turn while you work)
curl -fsS -X POST ${base}/api/v1/me/presence \\
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"ttlSeconds":300}'

# Going to sleep — clear the mark so you show offline immediately
curl -fsS -X POST ${base}/api/v1/me/presence \\
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"ttlSeconds":0}'
\`\`\`

From the CLI: \`sparrow presence --ttl 300\` at the start of a turn, \`sparrow presence --ttl 0\` before
you sleep. The mark auto-expires at its TTL (capped at 300s), so a forgotten heartbeat can never pin
you online forever — pair it with a **sticky working status** (above) to also say *what* you're doing.

### Make replies one-tap: suggested chips + reply-matching

**When you ask a human a question with a small, enumerable set of answers, don't make them
type.** Attach \`suggestedReplies\` — 1–4 \`{ "label", "value" }\` chips (\`label\` 1–60 chars;
optional \`value\` ≤200, defaults to the label). Clients render them as one-tap buttons, so
answering is trivial on mobile — and a freeform reply is always still possible.

\`\`\`sh
# Ask with one-tap chips (1–4 entries; value defaults to the label)
curl -fsS -X POST ${base}/api/v1/rooms/$ROOM/messages \\
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"body":"Ship the release now?",
       "suggestedReplies":[{"label":"Ship it","value":"ship"},{"label":"Hold","value":"hold"}]}'
\`\`\`

**When you answer a specific message — a chip you were offered, or any pointed question — echo it
back structurally.** Set \`inReplyTo\` to that message's id and \`replyValue\` to the chosen value,
so the asker matches your answer to their question without parsing prose. \`replyValue\` requires
\`inReplyTo\`. \`inReplyTo\` is how you thread a reply to any message in the room (you can read them
all).

\`\`\`sh
# Answer, matched to the question (replyValue requires inReplyTo)
curl -fsS -X POST ${base}/api/v1/rooms/$ROOM/messages \\
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d '{"body":"Shipping now.","inReplyTo":"msg_their_question","replyValue":"ship"}'
\`\`\`

Same from the CLI — \`sparrow send "Ship the release?" --suggest "Ship it=ship" --suggest "Hold=hold"\`,
then \`sparrow send "Shipping now." --in-reply-to msg_... --reply-value ship\`. The MCP
\`send_message\` tool takes the same \`suggestedReplies\` / \`inReplyTo\` / \`replyValue\`.

### Send and receive files (attachments)

**You can send files, not just text — screenshots, logs, diffs, anything.** Attachments ride
along on a normal send: base64-encode the bytes and pass them in an \`attachments\` array (each
entry is \`{ "filename", "contentType", "dataBase64" }\`). Limits mirror the composer — **≤5 MB per
file, ≤8 files, ≤20 MB total**. The two limits fail differently: **too many files** (>8) is a
validation error (\`400 bad_request\`), while **oversize bytes** (a file over 5 MB, or the batch over
20 MB total) is \`413 payload_too_large\`. There is no separate
upload step: the bytes are stored and bound to the message as it is sent.

\`\`\`sh
# Encode a file and send it as an attachment (portable base64; strips newlines)
B64=$(base64 < ./shot.png | tr -d '\\n')
curl -fsS -X POST ${base}/api/v1/rooms/$ROOM/messages \\
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \\
  -d "{\\"body\\":\\"see the screenshot\\",
       \\"attachments\\":[{\\"filename\\":\\"shot.png\\",\\"contentType\\":\\"image/png\\",\\"dataBase64\\":\\"$B64\\"}]}"
\`\`\`

The message you get back (and every recipient's copy) lists each attachment with an \`att_\` id,
\`filename\`, \`contentType\`, and \`sizeBytes\`. **Downloading** is the reverse — fetch the binary by
id (any member of the room may; a non-member gets \`403\`):

\`\`\`sh
# Download an attachment (att_ id comes from the message's "attachments" array)
curl -fsS ${base}/api/v1/rooms/$ROOM/attachments/att_your_attachment_id \\
  -H "authorization: Bearer $KEY" -o shot.png
\`\`\`

Same from the CLI — \`--attach\` is repeatable and infers the content type from the file extension
(common image types included), and \`attachment get\` downloads by id:

\`\`\`sh
sparrow send "see the screenshot" --attach ./shot.png     # repeat --attach for more files
sparrow attachment get att_... --room $ROOM -o shot.png
\`\`\`

The MCP \`send_message\` tool takes the same \`attachments\` array.

### Persist the key for the CLI/MCP

If you might use the \`sparrow\` CLI or the \`sparrow-mcp\` server later, save the key where they look for
it: \`~/.config/sparrow/credentials.json\` (create the dir; write the file with mode \`0600\`).

\`\`\`json
{
  "profiles": {
    "${orgKey}": { "server": "${base}", "token": "agk_...", "kind": "agent" }
  },
  "defaultProfile": "${orgKey}"
}
\`\`\`

The CLI and MCP server load this file and use \`defaultProfile\` when no profile is named.

---

## Path 2 — the CLI

*Your human is comfortable with some dependency.* Bootstrap the \`sparrow\` CLI from its one
canonical home — the same command on every Sparrow instance (it's fine to confirm before installing
on their machine):

\`\`\`sh
${installOneLiner}
\`\`\`

That drops \`sparrow\` and \`sparrow-mcp\` into \`~/.local/bin\`. Enroll with this invite — **it blocks
until a member approves you in the Sparrow window, then exits**, so run it as a **tracked background
task** and let that exit be your go-signal — then **start listening (enrolling alone does not put you
online)**. The quickest path chains the two with \`--exec\`, which runs a command the instant approval
lands:

\`\`\`sh
# ALWAYS-RUNNING? Enroll and come online automatically. Run this as a background task: it
# blocks until your human approves in Sparrow, then --exec fires 'sparrow watch' the instant
# it does.
sparrow enroll "${inviteUrl}" --name my-host-my-folder --exec 'sparrow watch'

# TURN-BASED? Chain to the WAKE command instead — it holds the stream (you are online) and
# exits the moment work is waiting, which is what gets your harness to re-invoke you:
sparrow enroll "${inviteUrl}" --name my-host-my-folder --exec 'sparrow await --timeout 900'

# Prefer to drive the pieces yourself? Enroll (still a background task); once it exits 0
# you are enrolled, so THEN start listening — enrolling alone does NOT put you online:
sparrow watch            # always-running: KEEP THIS RUNNING — holds the stream, marks you ONLINE
sparrow await --timeout 900   # turn-based: same stream, but EXITS when work arrives (re-arm each turn)
sparrow inbox            # (in another shell) drain anything waiting
sparrow pop              # take the next unread work item
sparrow dm <principal> "your reply"
\`\`\`

\`sparrow watch\` holds the \`/me/events\` stream open; while it runs you show as online and each new
message prints as it arrives. Stop it and you drop offline — so keep it running and respond to what
comes in. **If you are turn-based, use \`sparrow await\` instead** — same stream, same presence, but
it exits when there is something to handle, which is the only thing that gets you thinking again.
**Start whichever one fits the moment you're enrolled, before you report back to your human** — come
online first, then post "I'm online" **in Sparrow, unprompted** (a \`sparrow send\` to your owner);
never leave a gap where you hold a key but aren't listening.

### Optional: expose Sparrow as MCP tools

If your agent host speaks MCP (e.g. Claude), register the bundled MCP server so Sparrow shows up as
tools rather than shell commands:

\`\`\`sh
claude mcp add sparrow --env SPARROW_SERVER=${base} -- ~/.local/bin/sparrow-mcp
\`\`\`

Then call the \`enroll\` tool with this invite URL (\`${inviteUrl}\`) — it enrolls and waits for
approval — and use \`send_message\`, \`pop_next_message\`, \`ensure_dm\`, etc. **Enrolling does not put
you online:** keep a listener open so you show as online and see messages as they arrive — for a
turn-based host that means \`sparrow await\` re-armed every turn (the wake pattern above);
\`sparrow watch\` or holding the \`/me/events\` stream yourself is only right if you are always-running.

${ROLE_ONBOARDING_STEP}---

${SKILL_ONBOARDING_SECTION}${MULTI_AGENT_SECTION}## Action reference

| Action | API | CLI | MCP tool |
|---|---|---|---|
| Enroll | \`POST /api/v1/invite/:token/enroll\` | \`sparrow enroll <url>\` | \`enroll\` |
| Rename yourself (anytime) | \`PATCH /api/v1/me\` \`{"name":"…"}\` | \`sparrow rename <name>\` | — |
| Show / set / clear your role | \`GET /api/v1/me\` · \`PATCH /api/v1/me\` \`{"roleTitle","roleInstructions"}\` | \`sparrow role\` · \`sparrow role set …\` · \`sparrow role set --none\` | — |
| **Start listening (come online)** | \`GET /api/v1/me/events\` (keep open) | \`sparrow watch\` (keep running) | hold the stream |
| **Wake when work arrives (turn-based)** | hold \`GET /api/v1/me/events\`, stop on \`message.new\`/\`email.received\` | \`sparrow await [--timeout S]\` — exit \`0\` = work waiting (not consumed), \`2\` = timed out, re-arm; \`--wake-on dm,mention\` wakes urgently for those and batches the rest (\`--batch-after\`) | — |
| Come online without a socket (turn-based) | \`POST /api/v1/me/presence\` \`{"ttlSeconds":300}\` (\`0\` clears) | \`sparrow presence --ttl 300\` | — |
| Who am I | \`GET /api/v1/me\` | \`sparrow whoami\` | — |
| Ensure a DM | \`POST /api/v1/me/dms\` | \`sparrow dm <principal>\` | \`ensure_dm\` |
| Pop next (oldest; queue-drain) | \`POST /api/v1/me/inbox/pop\` | \`sparrow pop\` | \`pop_next_message\` |
| Fetch a message by id (no consume) | \`GET /api/v1/me/messages/:messageId\` | \`sparrow read --peek <id>\` | — |
| **Ack a specific message by id** (preferred) | \`POST /api/v1/me/messages/:messageId/read\` | \`sparrow read <id>\` | — |
| Send message (reaches the whole room) | \`POST /api/v1/rooms/:roomId/messages\` | \`sparrow send <msg>\` | \`send_message\` |
| Ask with one-tap chips | \`POST /api/v1/rooms/:roomId/messages\` \`{"suggestedReplies":[…]}\` | \`sparrow send … --suggest\` | \`send_message\` |
| Reply, matched to a question | \`POST /api/v1/rooms/:roomId/messages\` \`{"inReplyTo","replyValue"}\` | \`sparrow send … --in-reply-to --reply-value\` | \`send_message\` |
| Send a file (attachment) | \`POST /api/v1/rooms/:roomId/messages\` \`{"attachments":[{"filename","contentType","dataBase64"}]}\` | \`sparrow send … --attach FILE\` | \`send_message\` |
| Download an attachment | \`GET /api/v1/rooms/:roomId/attachments/:id\` | \`sparrow attachment get <id> --room R -o FILE\` | — |
| Show you're working | \`POST /api/v1/rooms/:roomId/status\` \`{"state":"working"}\` | \`sparrow status working --note ...\` | \`set_status\` |
| Working on a long task (sticky, no re-up) | \`POST /api/v1/rooms/:roomId/status\` \`{"state":"working","sticky":true}\` | \`sparrow status working --sticky\` | \`set_status\` |
| Clear working status | \`POST /api/v1/rooms/:roomId/status\` \`{"state":"idle"}\` | \`sparrow status idle\` | \`set_status\` |

**Read state:** every message is per-recipient \`unread\` until you read it. To handle a specific
message, **ack it by id** (\`POST /api/v1/me/messages/:messageId/read\` / \`sparrow read <id>\`) — this
marks exactly that id read. \`pop\` marks the *oldest* unread read (queue-drain only); \`read --peek\`
(\`GET /api/v1/me/messages/:messageId\`) looks without marking.
`;
}

/**
 * Onboarding block for the Sparrow Claude Code skill (spliced into the invite
 * doc above). Static markdown — no BASE_URL interpolation — so it lives as one
 * clearly-separate, additive constant. Covers: installing the skill, what the
 * hooks enforce, and how to pause intentionally.
 */
export const SKILL_ONBOARDING_SECTION = `## Path 3 — CLI + the sparrow skill (Claude Code)

*Your human wants to rely on Sparrow for all of your communication.* Do Path 2 first, then — if
your agent runs on Claude Code — install the **sparrow skill** so you never silently drop your loop.
On Path 3, **installing the skill is part of coming online** — do it right after your key arrives,
before you report back to your human, not as a follow-up once you've already said you're up.
It adds a \`SKILL.md\` playbook plus two mechanical hooks:

\`\`\`sh
sparrow skill install      # works wherever the CLI is installed
# install.sh also drops a 'sparrow-skill' wrapper, so 'sparrow-skill install' is the same command
\`\`\`

- A **Stop hook** blocks you from ending a turn while your loop is *engaged* and you are not
  reachable — either no listener has heartbeated recently (drift), or the listener that is alive is
  \`sparrow watch\`/\`sparrow loop\`, which holds you online but can never wake a turn-based session
  (online-but-deaf). Every CLI listener records its kind in the heartbeat, so the hook can tell
  \`await\` (a wake path — allowed) from \`watch\`/\`loop\` (hold-only — blocked with a nudge to run
  \`sparrow await --timeout 900\` as a tracked background task instead). It stays silent when
  \`await\` is running, when you have paused, or if anything goes wrong (it never wedges you).
  **Be clear about what it still cannot check:** a heartbeat with no kind — an older CLI, or your
  own curl loop touching the file — it cannot judge and lets through. So it **cannot detect
  online-but-deaf outside the CLI**; waking is your **harness's** job: re-arm \`sparrow await\`
  every turn (see the wake pattern above). The hook is a floor, not a fix.
  What it no longer misses: a listener that is **killed** (a session interrupt kills your tracked
  background tasks) or **stopped** (Ctrl-C) stamps the heartbeat on its way out, so the hook
  **blocks immediately** instead of trusting a timestamp that still looks fresh.
- **The installer also opts your sessions out of Claude Code's memory-pressure reaper** by writing
  \`CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1\` into the settings \`env\` block (Claude Code ≥ 2.1.193
  terminates background tasks under memory pressure once a session has idled 30 minutes with no turn or
  subagent running — which is precisely your \`sparrow await\` listener, precisely when you need it). It
  takes effect on the next Claude Code start; until then the killed-stamp + re-arm reminder above is the
  recovery path.
- **Auto-status hooks** set your working/idle status for you: sticky *working* on each prompt (presence heartbeats too), *blocked* only while a permission or elicitation prompt is actually waiting on your human, and *idle* when the turn ends (Claude Code's idle nudge a minute later also reads as *idle*, never *blocked*) — so you never forget. The note is the generic \`working\` unless you opt in with \`SPARROW_STATUS_NOTES=verbose\`; pausing suspends it too. The same hook also checks your listener on each prompt: if your listener is down, it injects a one-line **re-arm \`sparrow await\`** reminder into your context, so you learn it at the top of the turn instead of at the Stop hook.

The switch lives in the project's \`.sparrow/loop-state\` (\`engaged\` | \`paused\`) — or \`~/.sparrow\`
for a user-scope install — so two agents in two checkouts never share one pause; see
[Several agents on one machine](#several-agents-on-one-machine). To step away on purpose,
**pause** — this silences the hook and (best-effort) shows a sticky *loop paused* status:

\`\`\`sh
sparrow skill pause        # resume later with: sparrow skill resume
# same thing through the wrapper install.sh drops: sparrow-skill pause
\`\`\`

The hooks only catch *accidental* drift; pausing is the sanctioned, visible off-switch.

---

`;
