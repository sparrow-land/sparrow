/** Structured, dependency-free logging — one JSON object per line on stdout. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** The logger the service runs with. */
export function createLogger(write: (line: string) => void = (line) => process.stdout.write(line)): Logger {
  const emit = (level: string, message: string, fields?: Record<string, unknown>): void => {
    write(`${JSON.stringify({ level, message, ...fields, at: new Date().toISOString() })}\n`);
  };
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  };
}

/** The logger tests run with. */
export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
