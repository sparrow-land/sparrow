#!/usr/bin/env node
/**
 * `pnpm --filter @sparrow/api render-install-script -- --base https://sparrow.land
 *  --out <file>`
 *
 * Write the POSIX installer to a file so the website build can publish it at
 * `INSTALL_URL/install.sh` (SPEC "Canonical public homes"). The bundle URLs it
 * downloads are `<base>/install/sparrow.js` and `<base>/install/sparrow-mcp.js`
 * — the same home the script itself is served from.
 *
 * The script's behaviour is unchanged from the one the server used to render:
 * Node ≥ 22 check, `SPARROW_BIN_DIR` override, `sparrow`/`sparrow-mcp`/
 * `sparrow-skill` wrappers, idempotent, guarded legacy-bundle cleanup.
 */
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_INSTALL_URL } from '../public-homes.js';
import { renderInstallScript } from '../routes/onboarding.templates.js';

/** The installer text for an install home. Pure — the unit tests call this. */
export function installScriptFor(base: string = DEFAULT_INSTALL_URL): string {
  return renderInstallScript(base);
}

const USAGE = `usage: render-install-script --base ${DEFAULT_INSTALL_URL} --out <file>`;

async function main(argv: readonly string[]): Promise<void> {
  const { parseArgs, requireString, optionalString } = await import('./args.js');
  const args = parseArgs(argv);
  const out = path.resolve(requireString(args, 'out', USAGE));
  const body = installScriptFor(optionalString(args, 'base'));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, body, 'utf8');
  await chmod(out, 0o755);
  // eslint-disable-next-line no-console
  console.log(`render-install-script: wrote ${Buffer.byteLength(body)} bytes → ${out}`);
}

// Run only as a script, never on import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
