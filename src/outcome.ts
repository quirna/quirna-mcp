import {
  APPROVAL_STATUSES,
  type Approval,
  type ApprovalStatus,
  TIERS,
  type Tier,
} from "@quirna/sdk";
import { z } from "zod";

/**
 * Turning an Approval into what the model reads.
 *
 * This module is the safety surface of the package. Everything else moves
 * bytes; this decides what an agent believes it is allowed to do next, and
 * the only reader is a language model that will act on the text.
 *
 * One rule governs all of it: **`isError` means the tool could not run, never
 * that the answer was no.** Every outcome described here — approved, rejected,
 * timed out, cancelled, still pending — is a successful call, because in all
 * of them we asked and got an answer. Only `server.ts`'s catch sets
 * `isError: true`, for the cases where we never learned anything: the API
 * unreachable, a key rejected, the call aborted.
 *
 * Marking a rejection as an error was tried and is wrong in a way worth
 * recording, because it looks safer than it is:
 *
 *  - It contradicts `idempotentHint: false` on `request_approval`. That flag
 *    exists because retrying the call asks a *second* human to approve the
 *    same action — and `isError` is exactly the signal that makes an agent
 *    retry. The two together tell a client to do the one thing the tool must
 *    never do.
 *  - It collapses "Ana said no" and "the API is down" into one bit. Those are
 *    opposites — an authoritative answer versus knowing nothing — and the
 *    agent would have to read the text to tell them apart, which was the whole
 *    justification for not trusting the text.
 *
 * What does the work instead is the text, and its order: a model reads the
 * front of a tool result most reliably, so every unauthorized outcome opens
 * with `NOT AUTHORIZED` before anything else. Fail-closed is unchanged — no
 * path other than `approved` reads as permission — and `structuredContent`
 * carries `authorized` for anything parsing rather than reading.
 */

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
};

/**
 * The declared shape of `structuredContent`, shared by both tools.
 *
 * Declaring it is what turns the JSON half from something a client may render
 * if it feels like it into a contract it can type against — worth having for a
 * package whose job is to live inside someone else's client.
 *
 * It comes with a sharp edge: when a tool declares an output schema, the MCP
 * SDK validates the result on **every call** and throws `McpError` if the
 * shape does not match. A drift between this and `structured()` would turn an
 * approval a human already answered into a protocol error the model reads as
 * an opaque failure — the one outcome this package must never produce.
 *
 * So the drift is made impossible rather than merely tested for: `structured()`
 * is typed as `z.infer` of this schema, which makes a mismatch a compile error
 * instead of a runtime one. A test over every status covers what types cannot,
 * namely that the values really satisfy it. (The error path is safe either
 * way — the SDK skips validation when `isError` is set.)
 */
export const OUTPUT_SCHEMA = {
  approval_id: z.string().describe("The Quirna id for this request."),
  status: z.enum([...APPROVAL_STATUSES] as [ApprovalStatus, ...ApprovalStatus[]]),
  authorized: z
    .boolean()
    .describe("True only when the action may proceed. The one field worth branching on."),
  kind: z.string(),
  message: z.string(),
  tier: z.enum([...TIERS] as [Tier, ...Tier[]]),
  environment: z.string().nullable(),
  auto_approved: z
    .boolean()
    .describe("True when a Policy condition did not match and no human was asked."),
  decided_by: z.string().nullable().describe("User id of the decider, not a name (ZUR-68)."),
  decided_at: z.string().nullable(),
  approved_count: z.number(),
  policy: z.string().describe("Name of the Policy that governed this request."),
  timeout_at: z.string().describe("When the request expires if still undecided."),
};

/**
 * The machine-readable half, identical across every outcome.
 *
 * `decided_by` is a user id (`usr_…`), not a name — the wire `Approval` has no
 * display name for the decider, only for the requester. It stays here, where a
 * caller can resolve it, and deliberately never reaches the text: an agent that
 * told its user "authorized by usr_dcb66f1118d8409f8732b1af6d471ccd" would be
 * naming nobody while sounding like it had named someone. Printing the real
 * name needs `decided_by_name` on the wire first (ZUR-68).
 */
function structured(
  approval: Approval,
  authorized: boolean,
): z.infer<z.ZodObject<typeof OUTPUT_SCHEMA>> {
  return {
    approval_id: approval.id,
    status: approval.status,
    authorized,
    kind: approval.kind,
    message: approval.message,
    tier: approval.tier,
    environment: approval.environment,
    auto_approved: approval.auto_approved ?? false,
    decided_by: approval.decided_by,
    decided_at: approval.decided_at,
    approved_count: approval.approved_count,
    policy: approval.policy.name,
    timeout_at: approval.timeout_at,
  };
}

/** Asking and getting an answer is a successful call, whatever the answer was. */
function result(approval: Approval, authorized: boolean, text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured(approval, authorized),
    isError: false,
  };
}

/** The line every non-approval ends with, phrased for a model about to act. */
const DO_NOT_PROCEED =
  "Do NOT perform the action. Report this outcome to the user instead of working around it.";

/**
 * The outcome of a settled — or still-pending — Approval Request.
 *
 * `pending` reaches here only because *we* stopped waiting, never because the
 * request is over: the human can still decide on their phone, and the id in
 * the text is how the agent picks the answer back up.
 */
export function describe(approval: Approval): ToolResult {
  switch (approval.status) {
    case "approved": {
      if (approval.auto_approved) {
        return result(
          approval,
          true,
          `APPROVED automatically (${approval.id}). The "${approval.policy.name}" policy's ` +
            "condition did not match this request, so no human was asked. You may proceed.",
        );
      }
      const when = approval.decided_at ? ` at ${approval.decided_at}` : "";
      return result(
        approval,
        true,
        `APPROVED (${approval.id}). Authorized by an approver${when} under the ` +
          `"${approval.policy.name}" policy. You may proceed with: ${approval.message}`,
      );
    }

    case "rejected":
      return result(
        approval,
        false,
        `NOT AUTHORIZED — REJECTED (${approval.id}). A human explicitly denied this. ` +
          DO_NOT_PROCEED,
      );

    case "timed_out":
      return result(
        approval,
        false,
        `NOT AUTHORIZED — TIMED OUT (${approval.id}). Nobody decided before the request ` +
          `expired at ${approval.timeout_at}. ${DO_NOT_PROCEED}`,
      );

    case "cancelled":
      return result(
        approval,
        false,
        `NOT AUTHORIZED — CANCELLED (${approval.id}). The request was withdrawn before ` +
          `anyone decided it. ${DO_NOT_PROCEED}`,
      );

    case "pending":
      return result(
        approval,
        false,
        `NOT AUTHORIZED YET — STILL PENDING (${approval.id}). The request is live and ` +
          `waiting on a human; it expires at ${approval.timeout_at}. ${DO_NOT_PROCEED} ` +
          `To pick the answer back up, call check_approval with approval_id "${approval.id}" — ` +
          "never request_approval again, which would ask a second person to approve the same thing.",
      );
  }
}
