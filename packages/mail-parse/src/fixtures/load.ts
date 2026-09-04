import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Read a `.eml` fixture as the bytes an MTA would hand us.
 *
 * The files are stored with LF endings (so diffs stay readable) and converted
 * to CRLF on read, because that is what comes off the wire.
 */
export function readFixture(name: string): Buffer {
  const raw = readFileSync(join(HERE, name), 'utf8');
  return Buffer.from(raw.replace(/\r?\n/g, '\r\n'), 'utf8');
}
