/**
 * `@sparrow/mcp` — a stdio MCP server exposing sparrow to AI agents.
 * Programmatic entry: build a server with {@link createMcpServer} and resolve
 * startup config with {@link resolveConfig}. The `sparrow-mcp` bin wires these to a
 * `StdioServerTransport`.
 */
export { createMcpServer, TOOL_NAMES } from './server.js';
export type { McpServerDeps } from './server.js';
export { resolveConfig, ConfigError } from './config.js';
export type { ResolvedConfig, Env } from './config.js';
