#!/usr/bin/env node
/** Thin executable wrapper: delegate to {@link runCli} and exit accordingly. */
import { runCli } from './index.js';

// Use process.exit so lingering keep-alive fetch sockets don't hold the
// process open. stdout/stderr are drained first to avoid truncated output.
async function drain(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.writableLength === 0) return;
  await new Promise<void>((resolve) => stream.write('', () => resolve()));
}

runCli(process.argv.slice(2))
  .then(async (code) => {
    await Promise.all([drain(process.stdout), drain(process.stderr)]);
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    process.stderr.write(`Fatal: ${(err as Error).message ?? String(err)}\n`);
    await drain(process.stderr);
    process.exit(1);
  });
