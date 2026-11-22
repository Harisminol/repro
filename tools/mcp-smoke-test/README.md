# MCP smoke test (dev-only)

Verifies Repro's Forge MCP server from an external client, end to end:
OAuth 2.1 → `tools/list` → one read-only `score-severity` call.

This is **not** part of the Forge app bundle — nothing in `src/` imports
it, and `forge deploy` does not ship it. It exists so a human (or an agent
with a browser) can prove the MCP server works from outside Atlassian.

## Why a custom script

The stock MCP Inspector uses a loopback callback (`127.0.0.1:6276`). When
the Inspector runs in a GitHub Codespace and the browser approving the
consent runs on another host, the loopback redirect never reaches the
listener and the 5-minute authorization code expires unused. This script
listens on a port in the Codespace and uses the Codespace's forwarded
`https` URL as the OAuth redirect, so the approval lands back on the
listener.

## Run (in the Codespace)

```bash
cd tools/mcp-smoke-test
npm install
# Forward port 6276 in the Codespace Ports panel; copy its public URL.
REDIRECT_URL=https://<codespace>-6276.github.dev/oauth/callback \
  LISTEN_PORT=6276 \
  node mcp-smoke-test.mjs
```

Open the printed `AUTH_URL` in a browser, approve as the site admin
(haris.minol@gmail.com), and the script prints `tools/list` plus the
`score-severity` result. It never prints tokens or the authorization code.

## Expected output

```
TOOLS (6): parse-report, find-duplicates, score-severity, missing-evidence, route-owner, graph-context
SCORE-SEVERITY RESULT: { ... band High, confidence Medium ... }
SMOKE TEST PASSED.
```
(Forge suffixes the tool names with the install environment, so on the
dev install the list reads `parse-report_development`, … — the script
resolves the real name from `tools/list` instead of hardcoding it.)

## What it proves

- The `rovo:mcp` module is exposed at
  `https://mcp.atlassian.com/forge/2888884b-3f90-44fc-acc0-bbd9335d73fc`.
- External MCP clients can discover and call its tools after OAuth consent.
- The "Expose tools to MCP-compatible apps" toggle is on for the dev install.
