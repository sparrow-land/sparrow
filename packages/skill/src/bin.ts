#!/usr/bin/env node
/**
 * `sparrow-skill` bin entry — the ONLY module in this package that self-invokes.
 *
 * `install.ts` is a pure, side-effect-free library: importing it (as the `sparrow`
 * CLI does, and as the single-file API bundle therefore does) must NEVER run a
 * skill command. This thin wrapper — the target of package.json's `bin` — is what
 * turns `npx sparrow-skill …` into an actual `runSkill(argv)` call. Keeping the
 * invocation here (and out of the importable library) is what stops the bundled
 * CLI from hijacking every `sparrow` invocation.
 */
import { runSkill } from './install.js';

runSkill(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`sparrow-skill: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(1);
  });
