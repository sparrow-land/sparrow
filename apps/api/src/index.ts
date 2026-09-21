import { DEFAULT_PORT } from '@sparrow-land/sdk/types';
import { buildServer, loggerOptions } from './server.js';
import { envConfig } from './config.js';
import { installShutdownHandlers } from './shutdown.js';
import { API_VERSION, BUILD_STAMP } from './version.js';
import { bannerUrl, printBanner } from './banner.js';
import { docsHome } from './public-homes.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const config = envConfig();
  const app = buildServer(config);
  // Trap SIGTERM/SIGINT before listening: a container stopped mid-boot should
  // still close the database rather than be SIGKILLed 10 seconds later.
  installShutdownHandlers(app);
  const startupLine = `sparrow API ${API_VERSION}${BUILD_STAMP ? `+${BUILD_STAMP}` : ''} listening on :${port}`;
  try {
    await app.listen({ port, host: '0.0.0.0' });
    // The human-facing banner: printed ONCE, the moment we are actually
    // serving, and set off by blank lines so it reads as a header rather than
    // as another log record. On a graphics terminal it is the real
    // illustration; everywhere else the ASCII bird (see `banner.ts`,
    // `resolveBannerMode`). It obeys the same silence `LOG_LEVEL=off` buys
    // (see `bannerEnabled`), so the raw write below is not the lie the old
    // duplicate `console.log` was; `SPARROW_NO_BANNER` turns it off on its own.
    //
    // Awaited, and awaited HERE: when the environment cannot name the terminal
    // it asks the terminal itself, which costs one round trip (bounded at
    // 500 ms, and only on a TTY). Holding the startup line behind it keeps the
    // banner above the logs, where it belongs; nothing is serving any later,
    // because `listen` has already resolved.
    await printBanner({
      version: API_VERSION,
      build: BUILD_STAMP,
      url: bannerUrl(config.baseUrl),
      docsUrl: docsHome(config),
      logging: loggerOptions(config.logLevel) !== false,
    });
    // The startup line goes through the LOGGER, not `console.log`. A second raw
    // write here meant `LOG_LEVEL=off` still printed a line — "off" that isn't
    // off is a lie, and on the compose path it was the only line you ever saw.
    app.log.info({ version: API_VERSION, build: BUILD_STAMP, port }, startupLine);
  } catch (err) {
    app.log.error(err, 'sparrow API failed to start');
    // A failed boot ALWAYS says why, even at LOG_LEVEL=off: silencing request
    // logging is a choice about noise, not a request to die quietly.
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  }
}

void main();
