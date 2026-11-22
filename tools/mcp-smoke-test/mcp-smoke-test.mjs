// mcp-smoke-test.mjs — dev-only smoke test for Repro's MCP server.
// Runs OUTSIDE the Forge app (plain Node >= 20). It performs the OAuth 2.1
// flow against the Forge MCP endpoint using a redirect URL you control
// (e.g. a GitHub Codespace forwarded URL), then lists tools and calls one
// read-only tool. It never prints tokens or the authorization code.
//
// Why this exists: the cloud browser and the Codespace run on different
// hosts, so the loopback callback (127.0.0.1:6276) the stock MCP Inspector
// uses never reaches its listener. This script listens on a port in the
// Codespace and uses the Codespace's forwarded https URL as the redirect,
// so the browser's approval lands back on the listener.
//
// Usage (in the Codespace, from this directory):
//   npm install
//   # Forward port 6276 in the Codespace Ports panel and copy its URL, e.g.
//   # https://ideal-winner-4pp764pwxp9fwjj-6276.github.dev/oauth/callback
//   REDIRECT_URL=<that URL> LISTEN_PORT=6276 node mcp-smoke-test.mjs
//   # Open the printed AUTH_URL in a browser, approve as the site admin,
//   # and the script prints tools/list + the score-severity result.
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';

const SERVER_URL = process.env.MCP_SERVER_URL ?? 'https://mcp.atlassian.com/forge/2888884b-3f90-44fc-acc0-bbd9335d73fc';
const REDIRECT_URL = process.env.REDIRECT_URL;
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? 6276);
const CODE_TIMEOUT_MS = 300_000; // authorization codes live ~5 minutes

if (!REDIRECT_URL) {
  console.error('REDIRECT_URL is required, e.g. https://<codespace>-6276.github.dev/oauth/callback');
  process.exit(2);
}
const redirectPath = new URL(REDIRECT_URL).pathname;

const store = { clientInfo: undefined, tokens: undefined, verifier: undefined };

const provider = {
  get redirectUrl() {
    return REDIRECT_URL;
  },
  get clientMetadata() {
    return {
      client_name: 'repro-mcp-smoke-test',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  },
  clientInformation: () => store.clientInfo,
  saveClientInformation: (info) => {
    store.clientInfo = info;
  },
  tokens: () => store.tokens,
  saveTokens: (tokens) => {
    store.tokens = tokens;
  },
  redirectToAuthorization: (url) => {
    console.log(`AUTH_URL: ${url.href}`);
    console.log('Open the URL above in a browser and approve as the site admin.');
  },
  saveCodeVerifier: (verifier) => {
    store.verifier = verifier;
  },
  codeVerifier: () => {
    if (!store.verifier) throw new Error('no code verifier saved');
    return store.verifier;
  },
};

function waitForCode() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('timed out waiting for the authorization callback (5 min)'));
    }, CODE_TIMEOUT_MS);
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${LISTEN_PORT}`);
      if (url.pathname !== redirectPath) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found\n');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Authorization received</h1><p>You can close this tab.</p>');
      clearTimeout(timer);
      server.close();
      if (error) reject(new Error(`authorization failed: ${error}`));
      else if (!code) reject(new Error('callback arrived without an authorization code'));
      else resolve(code);
    });
    server.listen(LISTEN_PORT, () => {
      console.log(`Listening for the OAuth callback on port ${LISTEN_PORT} (path ${redirectPath}).`);
    });
  });
}

const SAMPLE_REPORT = `Login bypass on 4.2.1 allows access without password.
Steps to reproduce:
1. Open the login page.
2. Leave the password field empty.
3. Click login.
Impact: anyone can log in as any user without knowing the password.
Expected: login fails without a password. Actual: login succeeds.`;

async function main() {
  console.log(`MCP server: ${SERVER_URL}`);
  console.log(`Redirect URL: ${REDIRECT_URL}`);
  const codePromise = waitForCode();
  const first = await auth(provider, { serverUrl: SERVER_URL });
  if (first !== 'REDIRECT') {
    console.log(`First auth() returned ${first} — no redirect needed.`);
  }
  const code = await codePromise;
  console.log('Authorization code received (value not printed). Exchanging it for tokens…');
  const second = await auth(provider, { serverUrl: SERVER_URL, authorizationCode: code });
  if (second !== 'AUTHORIZED') throw new Error(`second auth() returned ${second}, expected AUTHORIZED`);
  console.log('AUTHORIZED. Connecting the MCP client…');

  const client = new Client({ name: 'repro-mcp-smoke-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), { authProvider: provider });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`TOOLS (${tools.tools.length}): ${tools.tools.map((t) => t.name).join(', ')}`);
  // Forge suffixes MCP tool names with the install environment
  // (e.g. `_development` on the dev install, no suffix on production),
  // so resolve the real name from tools/list instead of hardcoding it.
  const scoreTool = tools.tools.find((t) => t.name === 'score-severity' || t.name.startsWith('score-severity_'));
  if (!scoreTool) throw new Error('score-severity tool not listed by the MCP server');
  console.log(`Calling ${scoreTool.name} …`);
  const result = await client.callTool({
    name: scoreTool.name,
    arguments: { reportText: SAMPLE_REPORT },
  });
  console.log('SCORE-SEVERITY RESULT:');
  console.log(JSON.stringify(result, null, 2));
  await client.close();
  console.log('SMOKE TEST PASSED.');
}

main().catch((err) => {
  console.error(`SMOKE TEST FAILED: ${err?.message || err}`);
  process.exit(1);
});
