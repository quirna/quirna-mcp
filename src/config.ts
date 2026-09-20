/**
 * Every environment variable this server reads, in one place.
 *
 * An MCP server is configured by a block of JSON in someone else's agent
 * client, so env vars are the whole configuration surface — there is no
 * flag to pass and no file of ours to edit. Each one below is therefore
 * documented as if it were a public API, because it is.
 */

export type ServerConfig = {
  apiKey: string;
  baseUrl?: string;
  /** Who the Console shows as having asked. One System key per agent, ideally. */
  requesterId: string;
  requesterName: string;
  /** Applied when a tool call does not name one. Empty means the org default. */
  environment?: string;
  /**
   * How long a tool call blocks waiting for a human before reporting back
   * that the request is still pending.
   *
   * Deliberately short by default. The limit that matters is not ours — it
   * is the agent client's own tool-call timeout, which is measured in tens
   * of seconds and, when it fires, kills the call without telling the model
   * anything. Coming back first with an approval id the model can resume
   * from is strictly better than being killed holding it.
   */
  waitMs: number;
};

export const DEFAULT_WAIT_MS = 90_000;
export const DEFAULT_REQUESTER_ID = "mcp";
export const DEFAULT_REQUESTER_NAME = "AI agent";

/** Thrown for a configuration problem, which is always the operator's to fix. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type Env = Record<string, string | undefined>;

function trimmed(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Read the configuration, or throw a `ConfigError` naming the variable and
 * where to get its value.
 *
 * The error text matters more here than anywhere else in the package: it is
 * printed to stderr by an agent client that shows the user, at best, a red
 * line saying the server failed to start.
 */
export function readConfig(env: Env): ServerConfig {
  const apiKey = trimmed(env, "QUIRNA_API_KEY");
  if (!apiKey) {
    throw new ConfigError(
      "QUIRNA_API_KEY is not set. Register a System in the Quirna Console " +
        "(Users → Systems) and put its key in this server's env block.",
    );
  }

  const rawWait = trimmed(env, "QUIRNA_WAIT_MS");
  let waitMs = DEFAULT_WAIT_MS;
  if (rawWait !== undefined) {
    const parsed = Number(rawWait);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new ConfigError(
        `QUIRNA_WAIT_MS must be a positive number of milliseconds, got ${rawWait}`,
      );
    }
    waitMs = parsed;
  }

  return {
    apiKey,
    baseUrl: trimmed(env, "QUIRNA_BASE_URL"),
    requesterId: trimmed(env, "QUIRNA_REQUESTER_ID") ?? DEFAULT_REQUESTER_ID,
    requesterName: trimmed(env, "QUIRNA_REQUESTER_NAME") ?? DEFAULT_REQUESTER_NAME,
    environment: trimmed(env, "QUIRNA_ENVIRONMENT"),
    waitMs,
  };
}
