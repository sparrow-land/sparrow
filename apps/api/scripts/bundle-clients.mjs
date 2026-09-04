#!/usr/bin/env node
/**
 * Bundle the CLI (apps/cli) and MCP server (apps/mcp) into single self-contained
 * files that the API serves as install artifacts (nothing is published to npm).
 *
 * Output:
 *   apps/api/install-assets/sparrow.js       ← apps/cli/src/bin.ts
 *   apps/api/install-assets/sparrow-mcp.js   ← apps/mcp/src/bin.ts
 *
 * Each bundle is ESM, targets Node >=22, and starts with a `#!/usr/bin/env node`
 * shebang so it can be exec'd directly. The CLI/MCP have no native deps, so
 * nothing needs to be marked external.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { computeBuildInfo } from './build-version.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const repoRoot = path.resolve(apiDir, '..', '..');
const outDir = path.join(apiDir, 'install-assets');

const SHEBANG = '#!/usr/bin/env node';

// The build version is stamped into the bundles as `__SPARROW_BUILD__` (esbuild
// `define`): `<pkg-version>+<yyyymmdd>.<sha>` — see build-version.mjs for the
// sha resolution order (BUILD_SHA env → git → "dev"). Docker builds MUST pass
// `--build-arg BUILD_SHA=$(git rev-parse --short HEAD)` because `.git` is never
// in the image build context. The clients read the stamp via
// `clientBuildVersion()` for `--version`, MCP `serverInfo`, and the
// `X-Sparrow-Client` self-identification header.

/** @type {{ entry: string, out: string }[]} */
const targets = [
  { entry: path.join(repoRoot, 'apps/cli/src/bin.ts'), out: 'sparrow.js' },
  { entry: path.join(repoRoot, 'apps/mcp/src/bin.ts'), out: 'sparrow-mcp.js' },
];

async function main() {
  await mkdir(outDir, { recursive: true });
  const info = await computeBuildInfo({ repoRoot });
  const buildVersion = info.buildVersion;
  // The SERVER's version report comes from here too: `src/version.ts` reads this
  // file at startup so `GET /healthz` and `GET /api/v1/meta` name the exact
  // build. install-assets is already copied into the runtime image, so the stamp
  // rides along with no extra Dockerfile plumbing.
  await writeFile(
    path.join(outDir, 'build-info.json'),
    `${JSON.stringify({ version: info.version, build: info.build, buildVersion }, null, 2)}\n`,
  );
  const sizes = [];
  for (const t of targets) {
    const outfile = path.join(outDir, t.out);
    await build({
      entryPoints: [t.entry],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      // Stamp the real build version so the CLI/MCP report it (see clientBuildVersion()).
      define: { __SPARROW_BUILD__: JSON.stringify(buildVersion) },
      // undici is an OPTIONAL enhancement (fresh-socket SSE reconnects): the CLI
      // degrades to its reconcile-poll floor when it's absent, and bundling it is
      // fragile (WASM llhttp loaded from files). Keep it external.
      external: ['undici'],
      // Some bundled CJS deps reference `require`/`__dirname`; provide ESM shims.
      banner: {
        js: [
          `import{createRequire as __sparrowCreateRequire}from'node:module';`,
          `import{fileURLToPath as __sparrowFileURLToPath}from'node:url';`,
          `import{dirname as __sparrowDirname}from'node:path';`,
          `const require=__sparrowCreateRequire(import.meta.url);`,
          `const __filename=__sparrowFileURLToPath(import.meta.url);`,
          `const __dirname=__sparrowDirname(__filename);`,
        ].join(''),
      },
      logLevel: 'info',
    });
    // Normalize: strip any esbuild-emitted shebang, then force one at the top.
    let code = await readFile(outfile, 'utf8');
    code = code.replace(/^#![^\n]*\n/, '');
    code = `${SHEBANG}\n${code}`;
    await writeFile(outfile, code);
    await chmod(outfile, 0o755);
    const kb = (Buffer.byteLength(code) / 1024).toFixed(0);
    sizes.push(`${t.out} (${kb} KB)`);
  }
  // eslint-disable-next-line no-console
  console.log(`bundled ${buildVersion}: ${sizes.join(', ')} → ${outDir}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
