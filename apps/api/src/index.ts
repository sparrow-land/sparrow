import { DEFAULT_PORT } from '@sparrow/common-types';
import { buildServer } from './server.js';
import { envConfig } from './config.js';
import { installShutdownHandlers } from './shutdown.js';
import { API_VERSION, BUILD_STAMP } from './version.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const app = buildServer(envConfig());
  // Trap SIGTERM/SIGINT before listening: a container stopped mid-boot should
  // still close the database rather than be SIGKILLed 10 seconds later.
  installShutdownHandlers(app);
  const banner = `sparrow API ${API_VERSION}${BUILD_STAMP ? `+${BUILD_STAMP}` : ''} listening on :${port}`;
  try {
    await app.listen({ port, host: '0.0.0.0' });
    // The banner goes through the LOGGER, not `console.log`. A second raw write
    // here meant `LOG_LEVEL=off` still printed a line — "off" that isn't off is
    // a lie, and on the compose path it was the only line you ever saw.
    app.log.info({ version: API_VERSION, build: BUILD_STAMP, port }, banner);
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
