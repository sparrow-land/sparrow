<!--
Thanks for the PR. Keep the description short — what changed and why is enough.
Security fix? Don't open a PR: report it privately first (see SECURITY.md).
-->

## What

<!-- The change, in a sentence or two. -->

## Why

<!-- The problem it solves. Link the issue: Fixes #123 -->

## Tests

<!--
The failing test came first, right? Name the tests you added or changed, and say
how you verified it. `pnpm -r test` output is fine.
-->

## Checklist

- [ ] **Tests added or updated** — a failing `*.test.ts` next to the code came first
- [ ] `pnpm -r test` and `pnpm -r typecheck` pass locally
- [ ] **SPEC.md updated** — behavior, wire shapes, routes and CLI commands are specified
      there first (tick this if the change needed no spec edit, and say why below)
- [ ] **Scenarios** — added or updated one under `scenarios/` if this crosses the wire,
      and ran `scenarios/run-all.sh` (or the affected scenario) with docker
- [ ] Docs updated if user-visible (README, `apps/web/src/routes/docs/`)
- [ ] Public-clean: no secrets, credentials, internal hostnames or deployment details
      in the code, tests or commit messages

<!-- If you skipped anything above, say which and why: -->
