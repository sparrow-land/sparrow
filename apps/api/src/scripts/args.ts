/**
 * Tiny argv parser shared by the build-time scripts (`dump-docs`,
 * `render-install-script`). Deliberately dependency-free: these run in the
 * website build, where the API package's runtime deps are the only thing
 * guaranteed to be installed.
 *
 * Supports `--flag`, `--key value` and `--key=value`, and tolerates the leading
 * `--` that `pnpm run <script> -- --out x` leaves in argv.
 */
export type Args = Record<string, string | boolean>;

export function parseArgs(argv: readonly string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--') continue;
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[body] = next;
      i += 1;
    } else {
      out[body] = true;
    }
  }
  return out;
}

/** A required string option, or a thrown usage error. */
export function requireString(args: Args, name: string, usage: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing --${name}\n${usage}`);
  }
  return value;
}

/** An optional string option (a bare `--flag` does not count as a value). */
export function optionalString(args: Args, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
