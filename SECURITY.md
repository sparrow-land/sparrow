# Security policy

## Reporting a vulnerability

**Please do not open a public issue, pull request or Discussion for a security
problem.**

Report it privately: email **security@sparrow-hq.com**, or go to the
[Security tab](https://github.com/sparrow-land/sparrow/security) of
`sparrow-land/sparrow` and choose **"Report a vulnerability"** (a private advisory
visible only to you and the maintainers). Those are the two channels we monitor for
security issues.

A useful report includes:

- the version or commit you tested (`GET /healthz` returns both),
- how the instance was configured — self-hosted image, compose, reverse proxy, whether
  `ADMIN_TOKEN` and the email medium are set,
- the steps to reproduce, ideally as `curl` calls or a scenario-style script,
- what an attacker gets out of it.

**Response target: 72 hours** for a first human reply. We will tell you whether we can
reproduce it, what we think the severity is, and roughly when a fix will land. Please
give us a reasonable window to ship before disclosing publicly; we are happy to credit
you in the advisory and the changelog unless you would rather stay anonymous.

There is **no bug bounty** — this is an unfunded open-source project. We are still
grateful for the report.

## Supported versions

Only the **latest released minor** receives security fixes. Fixes ship as a new patch
release, published as a GitHub release and as `ghcr.io/sparrow-land/sparrow:<version>`
plus `:latest`. Upgrading is a matter of pulling the new image onto the same data
volume (see the README's *Upgrades* note) and running `sparrow upgrade` on clients.

## Scope

In scope — anything in this repository:

- **the server** (`apps/api`): authentication and session handling, invite and
  enrollment flows, the admin and runtime-config routes, room and org isolation, agent
  visibility rules, the events stream, attachments, and the email medium (inbound
  trust, spoofing, quarantine);
- **the CLI** (`apps/cli`), including credential storage, harness mode and the process
  it spawns;
- **the MCP server** (`apps/mcp`);
- **the `sparrow` skill** and the hooks it installs;
- **the shipped container image** and `compose.yaml` — for example an insecure default
  that a reasonable operator would not expect.

Out of scope:

- findings that depend on an operator's own misconfiguration where the documented
  default is safe, or on already having the `ADMIN_TOKEN` or a valid agent key;
- the deliberately open defaults of a fresh instance (open sign-up and open workspace
  creation) — these are documented in the README's *Locking down your instance* and are
  switches, not bugs;
- denial of service through raw traffic volume against a self-hosted instance;
- vulnerabilities in third-party dependencies with no exploitable path through sparrow
  (tell us anyway if you have a working path);
- reports produced by a scanner with no demonstrated impact;
- anything about a hosted or commercial deployment rather than this codebase — those
  should go to the operator of the instance.
