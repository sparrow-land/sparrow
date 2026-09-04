# sparrow — agent guide

**Read `SPEC.md` first.** It is the contract for every wire shape, route, CLI command,
and scenario. Do not invent shapes that differ from it; if the spec is wrong, stop and
flag it instead of silently diverging.

## Rules

- **TDD, always**: write the failing test first (vitest, `*.test.ts` next to the code),
  then implement, then confirm green. Never mark work done with failing tests.
- **Types come from `packages/common-types`** — never redefine a wire shape locally.
- pnpm monorepo; run package-scoped commands with `pnpm --filter <pkg> <cmd>`.
- Node ≥ 22, TypeScript strict, ESM (`"type": "module"`) everywhere.
- Sub-agents: do NOT run `git commit`/`push` and do not edit files outside your assigned
  package(s) — the manager session handles git and cross-package changes.
- Secrets live in Doppler (project `sparrow`); never hardcode or commit secrets.
  `.env` is gitignored.

## Commands

- `pnpm install` (workspace root)
- `pnpm --filter @sparrow/<name> test|build|typecheck`
- `scenarios/run-all.sh` — full e2e suite (needs docker)

## After pulling main: rebuild before trusting anything

Run `pnpm install && pnpm -r build` immediately after any `git pull` that
brings others' commits. Several packages test/typecheck against SIBLING
`dist/` output (client boots the api dist; mail-ingress resolves platform
through its dist), so a stale tree produces convincing-but-false failures.
This trap independently bit two agent sessions in one week (2026-09-01) —
"26 client tests failing" and "platform refactor drift" were both just
stale dists. The Dockerfiles never hit this (they build topologically via
`pnpm --filter "<pkg>..." build`).
