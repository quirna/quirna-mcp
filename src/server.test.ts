import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  APPROVAL_STATUSES,
  type Approval,
  type CreateApprovalInput,
  QuirnaError,
} from "@quirna/sdk";
import { z } from "zod";
import { ConfigError, DEFAULT_WAIT_MS, readConfig, type ServerConfig } from "./config.js";
import { describe as describeOutcome, OUTPUT_SCHEMA } from "./outcome.js";
import { type ApprovalsClient, createServer } from "./server.js";

function approval(overrides: Partial<Approval> = {}): Approval {
  const status = overrides.status ?? "pending";
  return {
    id: "apr_7x2k",
    org_id: "org_1",
    kind: "database_migration",
    identifiers: { table: "users_v1" },
    message: "Drop table users_v1 on production",
    requester_id: "mcp",
    requester_name: "AI agent",
    environment: "production",
    tier: "critical",
    status,
    callback_url: null,
    created_at: "2026-09-19T14:00:00.000Z",
    timeout_at: "2026-09-19T14:15:00.000Z",
    decided_at: status === "pending" ? null : "2026-09-19T14:02:00.000Z",
    // A user id, which is what the API actually sends — not an email. An
    // earlier fake used "ana@acme.com" and hid the fact that putting this in
    // the text names nobody while sounding like it names someone.
    decided_by: status === "pending" ? null : "usr_dcb66f1118d8409f8732b1af6",
    approved_count: status === "approved" ? 1 : 0,
    policy: {
      group_id: "grp_1",
      name: "Production migrations",
      tier: "critical",
      required_approvals: 1,
      requester_can_approve: false,
      timeout_seconds: 900,
    },
    ...overrides,
  };
}

const config: ServerConfig = {
  apiKey: "qk_test",
  requesterId: "mcp",
  requesterName: "AI agent",
  waitMs: 1000,
};

/** A fake client that records what it was asked and answers from a script. */
function fakeClient(
  script: Partial<ApprovalsClient> & { created?: Approval },
): ApprovalsClient & { inputs: CreateApprovalInput[] } {
  const inputs: CreateApprovalInput[] = [];
  return {
    inputs,
    create: async (input) => {
      inputs.push(input);
      if (script.create) return script.create(input);
      return script.created ?? approval();
    },
    get: script.get ?? (async () => approval()),
    wait: script.wait ?? (async () => approval()),
  };
}

/** Connect a real MCP client to the server over an in-memory pair. */
async function connect(client: ApprovalsClient): Promise<Client> {
  const server = createServer(config, client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  return mcp;
}

type CallResult = { content: { type: string; text: string }[]; isError?: boolean };

function textOf(result: unknown): string {
  return (result as CallResult).content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/* ------------------------------------------------------------- discovery */

test("exposes exactly the two tools, with the risky one marked non-idempotent", async () => {
  const mcp = await connect(fakeClient({}));
  const { tools } = await mcp.listTools();

  expect(tools.map((t) => t.name).sort()).toEqual(["check_approval", "request_approval"]);
  const request = tools.find((t) => t.name === "request_approval");
  // Every call asks a fresh human: a client that retried this on a blip would
  // put the same action in front of a second approver.
  expect(request?.annotations?.idempotentHint).toBe(false);
  expect(tools.find((t) => t.name === "check_approval")?.annotations?.readOnlyHint).toBe(true);
  await mcp.close();
});

/* ------------------------------------------------------- request_approval */

test("an approved request reads as authorized and is not an error", async () => {
  const decided = approval({ status: "approved" });
  const mcp = await connect(fakeClient({ wait: async () => decided }));

  const result = await mcp.callTool({
    name: "request_approval",
    arguments: { kind: "database_migration", message: "Drop table users_v1" },
  });

  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toContain("APPROVED");
  // The id is machine-readable state, never prose: it would read as a name.
  expect(textOf(result)).not.toContain("usr_");
  expect(result.structuredContent).toMatchObject({
    approval_id: "apr_7x2k",
    status: "approved",
    authorized: true,
  });
  await mcp.close();
});

test("a rejection is a successful call that tells the model not to proceed", async () => {
  const mcp = await connect(fakeClient({ wait: async () => approval({ status: "rejected" }) }));

  const result = await mcp.callTool({
    name: "request_approval",
    arguments: { kind: "refund", message: "Refund 12,000 USD" },
  });

  // We asked and got an answer, so the call succeeded. `isError` is reserved
  // for never having learned anything — marking a denial as an error would
  // invite the retry that puts the same action in front of a second human.
  expect(result.isError).toBeFalsy();
  expect(textOf(result).startsWith("NOT AUTHORIZED")).toBe(true);
  expect(textOf(result)).toContain("REJECTED");
  expect(textOf(result)).toContain("Do NOT perform the action");
  expect(result.structuredContent).toMatchObject({ authorized: false, status: "rejected" });
  await mcp.close();
});

test("a timeout on our side returns the id to resume from, not a failure to reach Quirna", async () => {
  const pending = approval({ status: "pending" });
  const mcp = await connect(
    fakeClient({
      wait: async () => {
        throw new QuirnaError("wait timed out", 408, "wait_timeout");
      },
      get: async () => pending,
    }),
  );

  const result = await mcp.callTool({
    name: "request_approval",
    arguments: { kind: "deploy", message: "Deploy v2 to production" },
  });

  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toContain("STILL PENDING");
  expect(textOf(result)).toContain("apr_7x2k");
  expect(textOf(result)).toContain("check_approval");
  await mcp.close();
});

test("an auto-approved request never polls — it is already terminal", async () => {
  let waits = 0;
  const mcp = await connect(
    fakeClient({
      created: approval({ status: "approved", auto_approved: true, decided_by: null }),
      wait: async () => {
        waits += 1;
        return approval();
      },
    }),
  );

  const result = await mcp.callTool({
    name: "request_approval",
    arguments: { kind: "refund", message: "Refund 4 USD" },
  });

  expect(waits).toBe(0);
  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toContain("APPROVED automatically");
  await mcp.close();
});

test("the configured requester and environment ride along on every request", async () => {
  const client = fakeClient({ wait: async () => approval({ status: "approved" }) });
  const server = createServer(
    { ...config, requesterId: "agent_7", requesterName: "Ops Agent", environment: "staging" },
    client,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

  await mcp.callTool({
    name: "request_approval",
    arguments: { kind: "deploy", message: "Deploy" },
  });
  expect(client.inputs[0]).toMatchObject({
    requester_id: "agent_7",
    requester_name: "Ops Agent",
    environment: "staging",
    identifiers: {},
  });

  // An explicit environment on the call wins over the configured default.
  await mcp.callTool({
    name: "request_approval",
    arguments: { kind: "deploy", message: "Deploy", environment: "production" },
  });
  expect(client.inputs[1]).toMatchObject({ environment: "production" });
  await mcp.close();
});

test("a rejected API key becomes a readable tool error, never a thrown exception", async () => {
  const mcp = await connect(
    fakeClient({
      create: async () => {
        throw new QuirnaError("unauthorized", 401);
      },
    }),
  );

  const result = await mcp.callTool({
    name: "request_approval",
    arguments: { kind: "deploy", message: "Deploy" },
  });

  // Here `isError` is right: the call never reached a decision.
  expect(result.isError).toBe(true);
  expect(textOf(result).startsWith("NOT AUTHORIZED")).toBe(true);
  expect(textOf(result)).toContain("QUIRNA_API_KEY");
  await mcp.close();
});

test("an unreachable API still says not authorized rather than failing silently", async () => {
  const mcp = await connect(
    fakeClient({
      create: async () => {
        throw new TypeError("fetch failed");
      },
    }),
  );

  const result = await mcp.callTool({
    name: "request_approval",
    arguments: { kind: "deploy", message: "Deploy" },
  });

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("could not reach Quirna");
  expect(textOf(result)).toContain("Do NOT perform the action");
  await mcp.close();
});

/* --------------------------------------------------------- check_approval */

test("check_approval reads an existing request without creating one", async () => {
  const client = fakeClient({ wait: async () => approval({ status: "approved" }) });
  const mcp = await connect(client);

  const result = await mcp.callTool({
    name: "check_approval",
    arguments: { approval_id: "apr_7x2k" },
  });

  expect(client.inputs).toHaveLength(0);
  expect(result.isError).toBeFalsy();
  expect(textOf(result)).toContain("APPROVED");
  await mcp.close();
});

/* ----------------------------------------------------------------- config */

test("a missing API key names the variable and where its value comes from", () => {
  expect(() => readConfig({})).toThrow(ConfigError);
  try {
    readConfig({});
  } catch (err) {
    expect((err as Error).message).toContain("QUIRNA_API_KEY");
    expect((err as Error).message).toContain("Systems");
  }
});

test("config defaults, overrides and a bad wait value", () => {
  const defaults = readConfig({ QUIRNA_API_KEY: "qk_1" });
  expect(defaults).toMatchObject({ requesterId: "mcp", waitMs: DEFAULT_WAIT_MS });
  expect(defaults.environment).toBeUndefined();

  expect(readConfig({ QUIRNA_API_KEY: "qk_1", QUIRNA_WAIT_MS: "5000" }).waitMs).toBe(5000);
  // Whitespace-only is the shape an unset variable takes in a JSON config block.
  expect(readConfig({ QUIRNA_API_KEY: "qk_1", QUIRNA_REQUESTER_ID: "   " }).requesterId).toBe(
    "mcp",
  );
  expect(() => readConfig({ QUIRNA_API_KEY: "qk_1", QUIRNA_WAIT_MS: "soon" })).toThrow(ConfigError);
});

/* ---------------------------------------------------------------- outcome */

test("every non-approved status opens with NOT AUTHORIZED and is still a successful call", () => {
  for (const status of ["rejected", "timed_out", "cancelled", "pending"] as const) {
    const outcome = describeOutcome(approval({ status }));
    // The text carries the verdict, because the model reads the front of a
    // result most reliably; `isError` is not the channel for it.
    expect(outcome.content[0]?.text.startsWith("NOT AUTHORIZED")).toBe(true);
    expect(outcome.isError).toBe(false);
    expect(outcome.structuredContent).toMatchObject({ authorized: false });
    expect(outcome.content[0]?.text).toContain("Do NOT perform the action");
    expect(outcome.content[0]?.text).toContain("apr_7x2k");
  }
});

test("every outcome satisfies the declared output schema", () => {
  // With an outputSchema declared, the SDK validates on every call and throws
  // McpError on a mismatch — which would turn an answered approval into an
  // opaque protocol failure. Types stop the shape drifting; this stops the
  // values doing it.
  const schema = z.object(OUTPUT_SCHEMA);
  for (const status of APPROVAL_STATUSES) {
    const parsed = schema.safeParse(describeOutcome(approval({ status })).structuredContent);
    expect(parsed.success).toBe(true);
  }
  // Auto-approved carries a null decider, the one shape a human decision never has.
  const auto = approval({ status: "approved", auto_approved: true, decided_by: null });
  expect(schema.safeParse(describeOutcome(auto).structuredContent).success).toBe(true);
});

test("a tool call round-trips structuredContent through a real client", async () => {
  const mcp = await connect(fakeClient({ wait: async () => approval({ status: "approved" }) }));
  const result = await mcp.callTool({
    name: "request_approval",
    arguments: { kind: "deploy", message: "Deploy" },
  });
  // Reaching here at all means the SDK's output validation passed end to end.
  expect(z.object(OUTPUT_SCHEMA).safeParse(result.structuredContent).success).toBe(true);
  await mcp.close();
});

test("only a call that never got an answer is a tool error", () => {
  // The whole rule in one place: a decision — any decision — is isError false.
  expect(describeOutcome(approval({ status: "approved" })).isError).toBe(false);
  expect(describeOutcome(approval({ status: "rejected" })).isError).toBe(false);
});
