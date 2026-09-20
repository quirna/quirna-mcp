import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type Approval,
  type CreateApprovalInput,
  QuirnaError,
  TIERS,
  type Tier,
} from "@quirna/sdk";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import { describe, OUTPUT_SCHEMA, type ToolResult } from "./outcome.js";

/**
 * The two tools, and nothing else.
 *
 * ZUR-56 asked for a single tool — create the request and wait — on the
 * grounds that the Kind and the Condition already live in the org's Policy,
 * so there is nothing to configure per agent. That reasoning holds and is why
 * neither tool takes a quorum, an approver or a timeout: the org decides those
 * in the Console, once, for every caller.
 *
 * `check_approval` is the one addition, and it exists because of the case the
 * ticket left open: an agent client kills a tool call long before a human
 * finishes deciding. Without a way to name an existing request, an agent that
 * came back from a cut-off call could only call `request_approval` again —
 * asking a second human to approve the same action, which is worse than any
 * amount of API surface.
 */

/** The slice of `@quirna/sdk`'s client this server uses. Narrow so tests can fake it. */
export type ApprovalsClient = {
  create(input: CreateApprovalInput, options?: { signal?: AbortSignal }): Promise<Approval>;
  get(id: string, options?: { signal?: AbortSignal }): Promise<Approval>;
  wait(
    id: string,
    options?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal },
  ): Promise<Approval>;
};

/** Kept tied to the SDK's vocabulary so a new tier cannot drift out of the schema. */
const TIER_VALUES = [...TIERS] as [Tier, ...Tier[]];

export const SERVER_NAME = "quirna";
export const SERVER_VERSION = "0.1.0";

const REQUEST_DESCRIPTION = [
  "Ask a human to authorize an action before you take it, and wait for their answer.",
  "",
  "Call this BEFORE doing anything that is irreversible, destructive, spends money,",
  "touches production, affects other people, or goes beyond what the user explicitly",
  "asked for. Describe the action you are about to take, then act only if the result",
  "says APPROVED.",
  "",
  "A nominated approver decides on their phone under your organization's policy — you",
  "do not choose who approves or how many are needed. The call blocks while they",
  "decide. If they have not answered by the time it returns, you get the approval id",
  "and resume with check_approval; the request stays live either way.",
].join("\n");

const CHECK_DESCRIPTION = [
  "Look up an approval request you already created and wait for its outcome.",
  "",
  "Use this when a previous request_approval call came back NOT DECIDED YET. Never",
  "call request_approval again for the same action — that asks a second human to",
  "approve something already in front of the first one.",
].join("\n");

export function createServer(config: ServerConfig, client: ApprovalsClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Quirna puts a human in front of risky actions. Before taking an action that " +
        "is irreversible, destructive, costly, or outside what the user asked for, call " +
        "request_approval and proceed only on APPROVED.",
    },
  );

  server.registerTool(
    "request_approval",
    {
      title: "Request human approval",
      description: REQUEST_DESCRIPTION,
      inputSchema: {
        kind: z
          .string()
          .min(1)
          .describe(
            'What class of action this is, in snake_case — for example "database_migration", ' +
              '"refund", "deploy". The organization\'s policy for this kind decides who is ' +
              "asked and whether a human is needed at all.",
          ),
        message: z
          .string()
          .min(1)
          .describe(
            "One imperative line naming the action, shown as the headline on the approver's " +
              'phone: "Drop table users_v1 on production". Write it so someone who cannot see ' +
              "your session can judge it.",
          ),
        identifiers: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "The specifics an approver needs, as flat string key/value pairs: amounts, table " +
              'names, account ids, hostnames. For example {"table": "users_v1", "rows": "48213"}. ' +
              "Policy conditions are evaluated against these.",
          ),
        environment: z
          .string()
          .optional()
          .describe('Deployment label, for example "production" or "staging".'),
        tier: z
          .enum(TIER_VALUES)
          .optional()
          .describe(
            "Raise the risk tier shown to the approver. The policy sets the floor; this can " +
              "only raise it, never lower it.",
          ),
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Each call creates a new Approval Request and asks a human again.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, extra) => {
      const input: CreateApprovalInput = {
        kind: args.kind,
        message: args.message,
        identifiers: args.identifiers ?? {},
        requester_id: config.requesterId,
        requester_name: config.requesterName,
        ...((args.environment ?? config.environment)
          ? { environment: args.environment ?? config.environment }
          : {}),
        ...(args.tier ? { tier: args.tier } : {}),
      };
      return run(async () => {
        const created = await client.create(input, { signal: extra.signal });
        // An auto-approved request is already terminal; polling it would be a
        // round trip to learn what we were just told.
        if (created.status !== "pending") return describe(created);
        return describe(await settle(client, created.id, config.waitMs, extra.signal));
      });
    },
  );

  server.registerTool(
    "check_approval",
    {
      title: "Check a pending approval",
      description: CHECK_DESCRIPTION,
      inputSchema: {
        approval_id: z
          .string()
          .min(1)
          .describe('The id from an earlier request_approval result, such as "apr_7x2k9m".'),
      },
      outputSchema: OUTPUT_SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args, extra) =>
      run(async () =>
        describe(await settle(client, args.approval_id, config.waitMs, extra.signal)),
      ),
  );

  return server;
}

/**
 * Wait for a decision, and treat running out of patience as an answer.
 *
 * The SDK raises `wait_timeout` when its own deadline passes, which here is
 * not a failure but the expected path for any approval a human takes longer
 * than `waitMs` to think about. Re-reading gives the freshest status to
 * report — a decision landing during that last poll interval is common.
 */
async function settle(
  client: ApprovalsClient,
  id: string,
  waitMs: number,
  signal?: AbortSignal,
): Promise<Approval> {
  try {
    return await client.wait(id, { timeoutMs: waitMs, signal });
  } catch (err) {
    if (err instanceof QuirnaError && err.code === "wait_timeout") {
      return client.get(id, { signal });
    }
    throw err;
  }
}

/**
 * Run a tool body, turning any failure into a tool error the model can read.
 *
 * **This is the only place in the package that sets `isError`** — see the rule
 * in `outcome.ts`. It means one thing here: we never learned whether the
 * action was allowed, because the call itself did not complete. A decision
 * that came back, including "no", is a successful call and goes through
 * `describe` instead.
 *
 * Nothing is allowed to throw out of a handler: an exception becomes a
 * protocol-level error that most clients show the model as an opaque string,
 * and "the approval tool broke" is the one message that must never be
 * mistaken for "go ahead".
 */
async function run(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    return {
      content: [{ type: "text", text: failureText(err) }],
      structuredContent: {},
      isError: true,
    };
  }
}

function failureText(err: unknown): string {
  // Opens the same way every unauthorized outcome does, so a model scanning
  // the front of the result cannot tell "denied" from "broken" by tone and
  // guess its way to proceeding.
  const prefix = "NOT AUTHORIZED —";
  const suffix = "Do NOT perform the action; tell the user Quirna could not answer.";
  if (err instanceof QuirnaError) {
    if (err.code === "aborted") {
      return `${prefix} the approval request was cancelled before it was decided. ${suffix}`;
    }
    const hint =
      err.status === 401
        ? " Check QUIRNA_API_KEY: the System key was rejected."
        : err.status === 403
          ? " This System is not allowed to request that kind; an Org admin sets the list in the Console under Users → Systems."
          : "";
    return `${prefix} Quirna returned ${err.status}: ${err.message}.${hint} ${suffix}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `${prefix} could not reach Quirna: ${message}. ${suffix}`;
}
