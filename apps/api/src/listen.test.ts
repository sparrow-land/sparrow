import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { listenQuietly } from './listen.js';

/** A pino destination that keeps every record as a string. */
function capture(): { lines: string[]; stream: Writable; text: () => string } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, stream, text: () => lines.join('') };
}

const open: FastifyInstance[] = [];

/** Build a logging server whose records land in `stream`; closed after the test. */
function serverAt(level: string, stream: Writable): FastifyInstance {
  const app = Fastify({ logger: { level, stream } });
  open.push(app);
  return app;
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

describe('listenQuietly', () => {
  it('binds without emitting fastify’s "Server listening at" records', async () => {
    const { stream, text } = capture();
    const app = serverAt('info', stream);

    await listenQuietly(app, { port: 0, host: '127.0.0.1' });

    expect(text()).not.toContain('Server listening at');
    expect((app.server.address() as AddressInfo).port).toBeGreaterThan(0);
  });

  it('restores the configured level, so our own startup line still prints', async () => {
    const { stream, text } = capture();
    const app = serverAt('info', stream);

    await listenQuietly(app, { port: 0, host: '127.0.0.1' });
    app.log.info('sparrow API 9.9.9 listening on :0');

    expect(app.log.level).toBe('info');
    expect(text()).toContain('sparrow API 9.9.9 listening on :0');
    expect(text()).not.toContain('Server listening at');
  });

  it('stays quiet at debug too, and comes back to debug', async () => {
    const { stream, text } = capture();
    const app = serverAt('debug', stream);

    await listenQuietly(app, { port: 0, host: '127.0.0.1' });
    app.log.debug('after');

    expect(app.log.level).toBe('debug');
    expect(text()).not.toContain('Server listening at');
    expect(text()).toContain('after');
  });

  it('propagates a bind failure and restores the level anyway', async () => {
    const taken = Fastify({ logger: false });
    open.push(taken);
    await taken.listen({ port: 0, host: '127.0.0.1' });
    const port = (taken.server.address() as AddressInfo).port;

    const { stream, text } = capture();
    const app = serverAt('info', stream);

    await expect(listenQuietly(app, { port, host: '127.0.0.1' })).rejects.toThrow();

    expect(app.log.level).toBe('info');
    // The entrypoint logs the failure AFTER the restore — it must be audible.
    app.log.error('sparrow API failed to start');
    expect(text()).toContain('sparrow API failed to start');
  });

  it('is a no-op dance on the off logger (LOG_LEVEL=off ⇒ logger:false)', async () => {
    const app = Fastify({ logger: false });
    open.push(app);

    await expect(listenQuietly(app, { port: 0, host: '127.0.0.1' })).resolves.toContain('http://');
    expect((app.log as { level?: string }).level).toBeUndefined();
  });

  it('never LOWERS a level that is already at or above warn', async () => {
    const seen: string[] = [];
    const fake = {
      log: { level: 'error' },
      listen: async () => {
        seen.push(fake.log.level);
        return 'http://127.0.0.1:0';
      },
    };

    await listenQuietly(fake, { port: 0, host: '127.0.0.1' });

    expect(seen).toEqual(['error']);
    expect(fake.log.level).toBe('error');
  });

  it('raises a below-warn level for exactly the duration of the bind', async () => {
    const seen: string[] = [];
    const fake = {
      log: { level: 'trace' },
      listen: async () => {
        seen.push(fake.log.level);
        return 'http://127.0.0.1:0';
      },
    };

    await listenQuietly(fake, { port: 0, host: '127.0.0.1' });

    expect(seen).toEqual(['warn']);
    expect(fake.log.level).toBe('trace');
  });
});
