# Contributing to sparrow

Thanks for wanting to help. This is a small, opinionated codebase — the rules below
are short, and they are enforced in review.

By participating you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before you start

**[SPEC.md](./SPEC.md) is the contract.** Every wire shape, route, CLI command and
scenario is specified there, and the code follows the spec rather than the other way
around. If you are changing behavior, **change SPEC.md first, in the same PR** — the
spec edit is the design review. If the spec looks wrong, say so in an issue instead of
quietly diverging from it.

For anything bigger than a bug fix, open an issue (or a Discussion) first so we can
agree on the shape before you write code.

## Development setup

Requires **Node ≥ 22** and **pnpm** (the repo pins its version via `packageManager`;
`corepack enable` will pick it up). Docker is needed only for the e2e scenarios and the
dev stack.

```sh
git clone https://github.com/sparrow-land/sparrow.git
cd sparrow
pnpm install

pnpm -r build        # build every package (do this after any pull — see below)
pnpm -r test         # unit tests (vitest)
pnpm -r typecheck    # TypeScript, strict
```

Package-scoped commands are the fast loop:

```sh
pnpm --filter @sparrow/api test
pnpm --filter @sparrow/cli typecheck
```

**Rebuild after pulling.** Several packages test and typecheck against sibling `dist/`
output, so a stale tree produces convincing-but-false failures. Run
`pnpm install && pnpm -r build` after any pull that brings in others' commits.

### Running the dev stack

```sh
docker compose up -d --build
```

That builds the image from the working tree and serves the whole product — web UI, API,
docs and the client bundles — on <http://localhost:8722>. Rebuild after changes; stop
with `docker compose down`. See the README's *Quick start* for ports, second instances
and configuration.

### End-to-end scenarios

```sh
scenarios/run-all.sh          # everything (docker required)
scenarios/020-send-and-pop/run.sh   # just one
```

Each directory under `scenarios/` is a self-contained regression: shell plus docker,
no shared fixtures. Anything that crosses the wire — a new route, a changed payload, a
new CLI command — should come with one, and copying the closest existing scenario is
the intended way to write it.

## The TDD rule

**Write the failing test first**, then implement, then confirm it goes green. Unit
tests are vitest and live *next to the code* as `*.test.ts` — not in a separate tree.

Never open a PR with failing tests. If a test cannot come first for some structural
reason, say why in the PR description; "I'll add tests later" is not a reason.

## House style

- TypeScript **strict**, ESM (`"type": "module"`) everywhere.
- **Wire types come from `packages/common-types`** (zod schemas). Never redefine a wire
  shape locally — import it.
- Delete obsolete code rather than deprecating it in place; git is the archive.
- Match the surrounding code. There is no separate style guide.

## Where things live

```
apps/api      Fastify server (REST + SSE + serves the web UI; owns the Docker build)
apps/cli      the `sparrow` CLI
apps/mcp      MCP server (stdio, bin `sparrow-mcp`)
apps/web      React web UI
packages/     common-types (zod wire schemas) + client (typed fetch client)
scenarios/    self-contained e2e regression scenarios (shell + docker)
docs/         design notes
```

## Commits and pull requests

Commit messages are **short and imperative** — `fix: harness acks after the reply
lands`, not `Fixed the thing where...`. One logical change per commit; keep unrelated
refactors out.

Write everything you commit as **public**: this repository is open source, so no
internal hostnames, no infrastructure or deployment details from a private
environment, and never a secret or credential — not in code, not in tests, not in a
commit message.

Your PR should say **what** changed and **why**, note the tests you added, whether
SPEC.md needed updating, and whether you ran the scenarios. The
[pull request template](./.github/PULL_REQUEST_TEMPLATE.md) asks exactly that.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](./SECURITY.md).
