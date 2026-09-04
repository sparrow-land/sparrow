#!/usr/bin/env node
/**
 * `sparrow-mcp` — stdio MCP server entrypoint. Resolves config from env / credential
 * store, then serves tools over stdio until the transport closes.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import { resolveConfig, ConfigError } from './config.js';

async function main(): Promise<void> {
  let config;
  try {
    config = resolveConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const server = createMcpServer({
    server: config.server,
    token: config.token,
    roomId: config.roomId,
    orgId: config.orgId,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Stay alive until stdin/transport closes.
}

main().catch((err: unknown) => {
  process.stderr.write(`sparrow MCP fatal: ${(err as Error).message ?? String(err)}\n`);
  process.exit(1);
});
