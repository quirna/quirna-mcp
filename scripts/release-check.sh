#!/usr/bin/env bash
# Everything that must hold before a version of @quirna/mcp reaches npm. Runs
# in the monorepo before tagging and again in quirna/quirna-mcp before
# publishing, so both sides refuse the same broken release.
#
# Mirrors packages/sdk/scripts/release-check.sh, with one difference that
# matters: this package's product is an *executable*, not an import. So the
# check installs the packed tarball into a bare Node project and then actually
# runs `quirna-mcp` the way an agent client does — spawning it over stdio and
# asking it for its tools. An `import` that succeeds proves nothing here; the
# failure modes are a missing shebang, a dependency that got bundled or
# dropped, a `bin` that points at nothing, or a server that dies on handshake.
#
# Needs bun, node >= 20 and npm on PATH.
set -euo pipefail

pkg_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$pkg_dir"

version="$(node -p 'require("./package.json").version')"

# SERVER_VERSION is what the server reports in the MCP initialize handshake; a
# stale one makes every client's logs lie about which server is running.
if ! grep -q "export const SERVER_VERSION = \"$version\";" src/server.ts; then
  echo "::error::src/server.ts SERVER_VERSION does not match package.json version $version"
  exit 1
fi

# npm only generates provenance, and only accepts a trusted publisher, when the
# repository running the publish equals `repository.url` (ADR-0020). The publish
# runs in the mirror, so this must name the mirror and not the monorepo's other
# mirror — which is exactly what it said when this check was written.
repo_url="$(node -p 'require("./package.json").repository.url')"
if [ "$repo_url" != "git+https://github.com/quirna/quirna-mcp.git" ]; then
  echo "::error::package.json repository.url must be the mirror this package publishes from (quirna/quirna-mcp); got $repo_url"
  exit 1
fi

# A release nobody wrote down is a release nobody can read. The heading must
# exist before the tag does, because after the tag it never gets written.
if ! grep -q "^## \\[$version\\]" CHANGELOG.md; then
  echo "::error::CHANGELOG.md has no '## [$version]' section; add one before releasing"
  exit 1
fi

bun test src
bun run build

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

npm pack --pack-destination "$work" >/dev/null
cd "$work"
npm init -y >/dev/null
npm pkg set type=module
npm install --no-audit --no-fund --silent \
  "./quirna-mcp-$version.tgz" typescript@5.6 @types/node@20

# 1. The library surface typechecks for a consumer on nodenext, which is where
#    an extensionless relative specifier in dist/*.d.ts would blow up.
cat >check.ts <<'EOF'
import { ConfigError, createServer, readConfig, SERVER_NAME } from "@quirna/mcp";

const config = readConfig({ QUIRNA_API_KEY: "ck_release_check" });
// If the declarations failed to resolve, this is `any` and the directive below
// stops being an error, which makes the directive itself the failure.
// @ts-expect-error waitMs is a number
const notAWait: string = config.waitMs;
console.log(SERVER_NAME, ConfigError.name, typeof createServer, notAWait);
EOF

cat >tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "es2022",
    "strict": true,
    "noEmit": true,
    "types": ["node"]
  },
  "files": ["check.ts"]
}
EOF

npx tsc -p tsconfig.json

# 2. Missing configuration fails loudly, because the only place that message is
#    ever read is an agent client's server log.
set +e
missing="$(node ./node_modules/.bin/quirna-mcp </dev/null 2>&1)"
code=$?
set -e
if [ $code -eq 0 ] || ! printf '%s' "$missing" | grep -q "QUIRNA_API_KEY"; then
  echo "::error::running without QUIRNA_API_KEY should exit non-zero naming the variable; got ($code) $missing"
  exit 1
fi

# 3. The installed executable serves the protocol: spawn it exactly as Claude
#    Code or Cursor would and require both tools, with their schemas.
npm install --no-audit --no-fund --silent @modelcontextprotocol/sdk

cat >handshake.mjs <<'EOF'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mcp = new Client({ name: "release-check", version: "0" });
await mcp.connect(
  new StdioClientTransport({
    command: "node",
    args: ["./node_modules/.bin/quirna-mcp"],
    // No QUIRNA_BASE_URL: nothing here talks to an API, it only handshakes.
    env: { PATH: process.env.PATH, QUIRNA_API_KEY: "ck_release_check" },
  }),
);

const { tools } = await mcp.listTools();
const names = tools.map((t) => t.name).sort();
const expected = ["check_approval", "request_approval"];
if (names.join() !== expected.join()) {
  throw new Error(`expected tools ${expected.join()}, got ${names.join()}`);
}
for (const tool of tools) {
  if (!tool.inputSchema?.properties) throw new Error(`${tool.name} has no input schema`);
  if (!tool.outputSchema?.properties) throw new Error(`${tool.name} has no output schema`);
  if (!tool.description) throw new Error(`${tool.name} has no description`);
}
// The one input a model must always be asked for.
const request = tools.find((t) => t.name === "request_approval");
for (const required of ["kind", "message"]) {
  if (!request.inputSchema.required?.includes(required)) {
    throw new Error(`request_approval no longer requires ${required}`);
  }
}
await mcp.close();
console.log("handshake ok:", names.join(", "));
EOF

node handshake.mjs

echo "release check passed for @quirna/mcp@$version"
