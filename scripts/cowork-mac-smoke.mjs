// Setup-only live probe. Never submits a prompt or invokes a model query.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const exec = promisify(execFile);
const [profileDirectory, secretsFile, transactionModule, appController] =
  process.argv.slice(2);
if (
  !profileDirectory ||
  !secretsFile ||
  !transactionModule ||
  !appController ||
  process.platform !== 'darwin'
) {
  console.error(
    'Use on macOS: node scripts/cowork-mac-smoke.mjs <configLibrary> <private-env> <compiled-transaction-module> <native-app-controller>'
  );
  process.exit(1);
}
const { installMacCoworkSettings } = await import(
  pathToFileURL(path.resolve(transactionModule)).href
);
const root = path.resolve('.cowork-runtime');
await mkdir(root, { mode: 0o700, recursive: true });
const run = await mkdtemp(path.join(root, 'mac-'));
const report = {
  runId: path.basename(run),
  status: 'starting',
  querySubmitted: false,
  nativeMcpInitialized: false,
  nativeMcpToolsListed: false,
  completeInventoryVerified: false,
  cleanupVerified: false,
};
let transaction;
let launched = false;
let wasRunning = false;
let aborted = false;
let interrupted;
let originalStateKnown = false;
const sockets = new Set();
const token = randomBytes(32).toString('hex');
const envKey = `MST_PROBE_${randomBytes(8).toString('hex').toUpperCase()}`;
const label = `mst_probe_${randomBytes(4).toString('hex')}`;
const active = new Set();

async function app(action) {
  report.phase = `app-${action}`;
  try {
    const { stdout } = await exec(appController, [action], {
      timeout: 30000,
      maxBuffer: 16384,
    });
    return JSON.parse(stdout);
  } catch (error) {
    try {
      const diagnostic = JSON.parse(error.stdout);
      if (
        [
          'launch-timeout',
          'application-not-resolved',
          'launch-services-error',
        ].includes(diagnostic.reason)
      ) {
        report.nativeFailure = diagnostic.reason;
        if (Number.isSafeInteger(diagnostic.code))
          report.nativeFailureCode = diagnostic.code;
      }
    } catch {
      /* Never expose raw controller errors. */
    }
    throw new Error('Native app control failed');
  }
}
function signal() {
  aborted = true;
  interrupted?.();
}
process.on('SIGINT', signal);
process.on('SIGTERM', signal);

const http = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    // No OAuth discovery; only the managed header helper can supply this per-run token.
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"authentication required"}');
    return;
  }
  let sdk;
  let transport;
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 65536) throw new Error();
      chunks.push(chunk);
    }
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : undefined;
    sdk = new McpServer({ name: label, version: '1.0.0' });
    sdk.registerTool(
      'setup_probe',
      { description: 'Read-only setup probe; no evaluation needs to call it.' },
      async () => ({ content: [{ type: 'text', text: 'setup fixture' }] })
    );
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    active.add(transport);
    await sdk.connect(transport);
    res.once('finish', () => {
      if (
        res.statusCode >= 200 &&
        res.statusCode < 300 &&
        body?.method === 'initialize'
      ) {
        report.nativeMcpInitialized = true;
        console.log(
          'Observed authenticated MCP initialize from an external client.'
        );
      }
      if (
        res.statusCode >= 200 &&
        res.statusCode < 300 &&
        body?.method === 'tools/list'
      ) {
        report.nativeMcpToolsListed = true;
        console.log(
          'Observed authenticated MCP tools/list from an external client.'
        );
      }
    });
    await transport.handleRequest(req, res, body);
  } catch {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  } finally {
    if (transport) active.delete(transport);
    await sdk?.close().catch(() => {});
  }
});
http.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});

try {
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error();
  const state = await app('state');
  if (state.instances > 1) throw new Error();
  report.workspaceApplicationCount = state.workspaceApplicationCount;
  if (!state.claudeBundleReadable || !(state.workspaceApplicationCount > 0)) {
    report.status = 'gui-session-unavailable';
    throw new Error('No observable macOS GUI session');
  }
  wasRunning = state.running;
  originalStateKnown = true;
  report.accessibilityTrusted = state.accessibilityTrusted;
  // Do not stage any real credentials until the original process has gracefully stopped.
  if (wasRunning) await app('stop');
  if (aborted) throw new Error();
  report.phase = 'install';
  transaction = await installMacCoworkSettings({
    profileDirectory: path.resolve(profileDirectory),
    stagingDirectory: path.join(run, 'staging'),
    manifest: {
      name: 'mac-cowork-setup-only',
      datasets: [],
      host: { type: 'cowork' },
      servers: [
        {
          transport: 'http',
          label,
          serverUrl: `http://127.0.0.1:${address.port}/mcp`,
          auth: { accessTokenEnv: envKey },
        },
      ],
    },
    secretsFile: path.resolve(secretsFile),
    env: { [envKey]: token },
    managedPreferencePaths: [
      '/Library/Managed Preferences/com.anthropic.claudefordesktop.plist',
      `/Library/Managed Preferences/${userInfo().username}/com.anthropic.claudefordesktop.plist`,
    ],
  });
  report.status = 'installed-not-verified';
  console.log(
    'Installed a temporary managed profile; original profile is unchanged.'
  );
  if (aborted) throw new Error();
  await app('start');
  launched = true;
  console.log(
    'Claude launched. Waiting up to 120 seconds for its authenticated MCP connection; no query will be sent.'
  );
  report.phase = 'wait-for-mcp';
  const until = Date.now() + 120000;
  while (!aborted && Date.now() < until && !report.nativeMcpToolsListed) {
    await new Promise((resolve) => {
      interrupted = resolve;
      setTimeout(resolve, 250);
    });
  }
  report.status =
    report.nativeMcpInitialized && report.nativeMcpToolsListed
      ? 'connection-observed-inventory-unverified'
      : aborted
        ? 'interrupted'
        : 'connection-not-observed';
} catch {
  report.failurePhase = report.phase;
  if (report.status !== 'gui-session-unavailable')
    report.status = aborted ? 'interrupted' : 'setup-failed';
  console.error(
    'Setup-only smoke failed. Raw errors and credentials are intentionally not logged.'
  );
} finally {
  interrupted = undefined;
  try {
    if (transaction || launched) {
      const current = await app('state');
      if (current.running) await app('stop');
      launched = false;
    }
    if (transaction) await transaction.restore();
    else {
      try {
        await access(path.join(profileDirectory, '.mst-setup-lock'));
        throw new Error('Recovery required');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    if (originalStateKnown && wasRunning) await app('start');
    report.configurationRestored = transaction ? true : null;
    report.cleanupVerified = originalStateKnown;
    report.phase = originalStateKnown ? 'restored' : 'no-profile-mutation';
  } catch {
    report.cleanupVerified = false;
    console.error(
      'Cleanup could not be verified; private staging and its recovery journal may remain. Do not reuse the profile until recovery.'
    );
  }
  for (const transport of active) await transport.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  if (http.listening) await new Promise((resolve) => http.close(resolve));
  process.off('SIGINT', signal);
  process.off('SIGTERM', signal);
  const output = path.resolve('.mcp-test-results/cowork-setup');
  await mkdir(output, { recursive: true, mode: 0o700 });
  const reportPath = path.join(output, `${report.runId}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  console.log(`Sanitized setup result: ${reportPath}`);
  console.log(JSON.stringify(report));
  // Partial connection evidence is not the complete exact-inventory acceptance gate.
  process.exitCode =
    report.completeInventoryVerified && report.cleanupVerified ? 0 : 1;
}
