# @quirna/mcp

Ask a human before your agent acts. Official [Quirna](https://quirna.com)
server for the [Model Context Protocol](https://modelcontextprotocol.io).

Add one block of config and your agent gains a tool it can call before doing
something consequential — a refund, a production deploy, a destructive
migration. A named human approves it on their phone. The agent proceeds only
if they said yes, and the decision is signed and kept.

> **Nothing moves until someone says yes.**

Your agent's framework may already have a way to pause for confirmation. This
is different in three ways that matter once it is not just you at the terminal:

- **The decision leaves the loop.** It goes to whoever your policy nominates,
  on their phone, behind Face ID — not to whoever happens to be watching the
  agent run.
- **Who approves is policy, not prompt.** Quorum, risk tier and which group is
  asked live in your organization's settings. The agent cannot choose its own
  approvers, and neither can a prompt injection.
- **It leaves evidence.** Every decision is signed at the moment it is made,
  and exports to a file a third party can verify without trusting us.

## Install

Nothing to install: the config below runs it on demand with `npx`. To pin it,
`npm install -g @quirna/mcp` and use `quirna-mcp` as the command.

## Before you start

> **The mobile app is in private beta.** Decisions are made on the phone and
> nowhere else — the Console configures policies and never decides one — so
> without the app an approval request is created and then waits until it
> expires. Write to **hello@quirna.com** and we will get you in. Everything
> else below works today.

Then, in the [Console](https://console.quirna.com):

1. **A System key.** Open **Users → Systems** and register one for this agent.
   You get a key (`ck_…`), shown once.
2. **A Policy**, which decides who approves a given kind of request and how
   many of them are needed.
3. **The app**, on the phone of whoever will approve.

## Configure your agent

**Claude Code** — `claude mcp add quirna --env QUIRNA_API_KEY=ck_… -- npx -y @quirna/mcp`

**Cursor** (`~/.cursor/mcp.json`), **Claude Desktop**
(`claude_desktop_config.json`) and most other clients take the same shape:

```json
{
  "mcpServers": {
    "quirna": {
      "command": "npx",
      "args": ["-y", "@quirna/mcp"],
      "env": {
        "QUIRNA_API_KEY": "ck_your_system_key",
        "QUIRNA_REQUESTER_NAME": "Ops Agent",
        "QUIRNA_ENVIRONMENT": "production"
      }
    }
  }
}
```

### Environment

| Variable | Default | What it does |
| --- | --- | --- |
| `QUIRNA_API_KEY` | — | **Required.** The System key from the Console. |
| `QUIRNA_REQUESTER_NAME` | `AI agent` | The name an approver sees as having asked. |
| `QUIRNA_REQUESTER_ID` | `mcp` | Stable id for this caller in the audit trail. |
| `QUIRNA_ENVIRONMENT` | — | Applied when a call does not name one. |
| `QUIRNA_WAIT_MS` | `90000` | How long a tool call waits before reporting back. |
| `QUIRNA_BASE_URL` | `https://api.quirna.com` | Point at a self-hosted API. |

**On the key.** It lives in your agent client's config file, which is often in
a dotfile and sometimes in a repo. Treat it as a deployment credential: give
each agent its own System rather than sharing one, scope it in the Console to
the kinds it may request, and rotate it there if the file gets somewhere it
should not be. A System key can only *ask* — it can never approve anything.

## The tools

### `request_approval`

Creates the request and waits for a human.

| Argument | Required | |
| --- | --- | --- |
| `kind` | yes | The class of action, e.g. `database_migration`. Selects the policy. |
| `message` | yes | One imperative line, shown as the headline on the phone. |
| `identifiers` | no | Flat string key/values an approver needs: amounts, table names, hosts. |
| `environment` | no | `production`, `staging`, … |
| `tier` | no | `routine`, `elevated`, `critical`. Can only raise the policy's floor. |

Notably absent: who approves, how many are needed, how long it stays open.
Those are the organization's to decide in the Console, once, for every caller —
an agent that could pick its own approvers would not be a control.

### `check_approval`

Takes an `approval_id` and waits for that existing request. Use it when
`request_approval` came back still pending; calling `request_approval` again
would put the same action in front of a second human.

## What the agent gets back

**Anything that is not `APPROVED` opens with `NOT AUTHORIZED`**, followed by
why, and by an explicit instruction not to perform the action. The structured
result carries `authorized: true | false` for code that parses instead of
reading.

Asking and getting an answer is a successful tool call, whatever the answer
was — a denial is the product working, not a failure. `isError` is reserved for
the cases where the tool could not run at all and nothing was learned: Quirna
unreachable, a key rejected, the call aborted. So an agent can tell "a human
said no" from "the approval system is down", which are opposite situations, and
nothing invites it to retry a denial into a second person's hands.

### When nobody answers

An agent running unattended at 3am will hit this: the request expires and the
action is never authorized. That is the correct outcome, not a bug to design
around. If your agent needs to run without anyone awake, the answer is a policy
whose condition does not require a human for that case — not a longer timeout.

Two timeouts are in play, and they are not the same:

- **`QUIRNA_WAIT_MS`** (default 90s) is how long a *tool call* waits before
  returning the approval id so the agent can resume. It exists because agent
  clients kill long tool calls. The request stays live.
- **The policy's expiry** (set in the Console) is how long the *request* stays
  open. Only this one can time a request out.

## Links

- [quirna.com](https://quirna.com) — what it is
- [console.quirna.com](https://console.quirna.com) — policies, groups, systems
- [`@quirna/sdk`](https://www.npmjs.com/package/@quirna/sdk) — for calling
  Quirna from your own code instead

MIT © Quirna
