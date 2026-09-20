#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Quirna } from "@quirna/sdk";
import { ConfigError, readConfig } from "./config.js";
import { createServer } from "./server.js";

/**
 * The executable: read the env, open stdio, serve.
 *
 * **Nothing here may write to stdout.** On this transport stdout *is* the
 * protocol stream, and a stray `console.log` corrupts the JSON-RPC framing —
 * the client's failure looks like a parse error with no hint of where it came
 * from. Diagnostics go to stderr, which agent clients surface as server logs.
 */
async function main(): Promise<void> {
  const config = readConfig(process.env);
  const client = new Quirna({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    // Each poll is its own HTTP request; the wait as a whole is bounded by
    // `waitMs` in `settle`, not by this.
    timeoutMs: 30_000,
  });

  const server = createServer(config, client);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `quirna-mcp: ready (waiting up to ${Math.round(config.waitMs / 1000)}s per approval)\n`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    err instanceof ConfigError
      ? `quirna-mcp: ${message}\n`
      : `quirna-mcp: failed to start: ${message}\n`,
  );
  process.exit(1);
});
