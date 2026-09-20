/**
 * The library surface, for embedding the Quirna tools in a server of your
 * own. Running it as a standalone MCP server needs none of this — that is
 * `bin.ts`, published as the `quirna-mcp` executable.
 */
export {
  ConfigError,
  DEFAULT_REQUESTER_ID,
  DEFAULT_REQUESTER_NAME,
  DEFAULT_WAIT_MS,
  type Env,
  readConfig,
  type ServerConfig,
} from "./config.js";
export { describe, type ToolResult } from "./outcome.js";
export { type ApprovalsClient, createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
