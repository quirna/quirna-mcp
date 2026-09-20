# Changelog

Notable changes to `@quirna/mcp`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions
[semver](https://semver.org/), with the usual 0.x caveat that a minor bump may
still move something.

Two surfaces here are public and change under semver like any API: **the tools'
names and input schemas**, and **the text a tool returns**. The text is read by
a language model that acts on it, so rewording it is a product change, not
editing.

Releases are cut with the *MCP* workflow — see
[ADR-0030](../../docs/adr/0030-servidor-mcp.md).

## [0.1.0] — 2026-09-20

First release.

The mobile app is in **private beta**, and decisions are made there and nowhere
else. Write to hello@quirna.com and we will add you; until then an approval
request is created and then waits until it expires.

### Added

- **`request_approval`** — creates an Approval Request and blocks while a
  nominated human decides on their phone. Takes `kind`, `message`, and
  optionally `identifiers`, `environment` and `tier`.

  It deliberately does not take who approves, how many are needed, or how long
  the request stays open. Those live in your organization's Policy, so an agent
  cannot choose its own approvers and neither can a prompt injection.

- **`check_approval`** — resumes a request that is already open, by id. Agent
  clients kill long tool calls well before a human finishes deciding; without
  this, an agent returning from a cut-off call could only create a second
  request, putting the same action in front of a second person.

- **A declared `outputSchema`** on both tools, so `structuredContent` is a
  contract a client can type against rather than JSON it may render if it
  feels like it.

- **`quirna-mcp`**, the executable, configured through `QUIRNA_API_KEY`,
  `QUIRNA_BASE_URL`, `QUIRNA_REQUESTER_ID`, `QUIRNA_REQUESTER_NAME`,
  `QUIRNA_ENVIRONMENT` and `QUIRNA_WAIT_MS`.

### The rule worth knowing before you use it

**`isError` means the tool could not run, never that the answer was no.**
Approved, rejected, timed out, cancelled and still-pending are all successful
calls, because in all of them we asked and got an answer. `isError` is reserved
for learning nothing at all: the API unreachable, a key rejected, the call
aborted.

The verdict is carried by the text instead, and by its order — every
unauthorized outcome opens with `NOT AUTHORIZED` — plus `authorized` in
`structuredContent` for code that parses rather than reads.

Marking a denial as an error was tried first and is wrong in a way that looks
safer than it is: it contradicts `idempotentHint: false` (retrying asks a
second human), and it collapses "a person said no" and "the service is down"
into one bit. Nothing other than `approved` reads as permission.
