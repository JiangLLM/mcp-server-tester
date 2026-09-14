// Read-only protocol preflight. Never calls tools/call or runs Cowork/a query.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [manifestPath, secretsPath, compiledRoot] = process.argv.slice(2);
if (!manifestPath || !secretsPath || !compiledRoot) {
  console.error(
    'Expected manifest, private secrets file, and compiled setup-module directory.'
  );
  process.exit(2);
}
try {
  const { loadEvalManifest } = await import(
    pathToFileURL(path.resolve(compiledRoot, 'evals/evalManifest.js'))
  );
  const { createCoworkMcpPlan, resolveCoworkMcpHeaders } = await import(
    pathToFileURL(path.resolve(compiledRoot, 'evals/coworkSetup/config.js'))
  );
  const { loadCoworkSecretsFile } = await import(
    pathToFileURL(path.resolve(compiledRoot, 'evals/coworkSetup/secrets.js'))
  );
  const manifest = loadEvalManifest(path.resolve(manifestPath), {
    skipDatasetValidation: true,
  });
  if (!manifest.servers) throw new Error();
  const plan = createCoworkMcpPlan(manifest.servers, '/run/mst-preflight');
  const headers = resolveCoworkMcpHeaders(
    manifest.servers,
    await loadCoworkSecretsFile(path.resolve(secretsPath))
  );
  const results = [];
  for (const server of plan.servers) {
    const result = {
      label: server.label,
      url: server.url,
      initialized: false,
      toolsListed: false,
      toolCount: 0,
      toolCalls: 0,
    };
    let lastHttpError;
    const client = new Client({
      name: 'mcp-server-tester-auth-preflight',
      version: '1.0.0',
    });
    const deadline = AbortSignal.timeout(20000);
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: headers[server.label], redirect: 'error' },
      fetch: async (input, init) => {
        const target =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (new URL(target).href !== server.url)
          throw new Error('Endpoint change refused');
        const response = await fetch(input, {
          ...init,
          redirect: 'error',
          signal: deadline,
        });
        if (response.status >= 400) lastHttpError = response.status;
        return response;
      },
    });
    try {
      await client.connect(transport);
      result.initialized = true;
      const seen = new Set();
      let cursor;
      for (let page = 0; page < 32; page++) {
        const listed = await client.listTools(cursor ? { cursor } : undefined);
        result.toolCount += listed.tools.length;
        if (!listed.nextCursor) {
          result.toolsListed = true;
          break;
        }
        if (seen.has(listed.nextCursor)) throw new Error();
        seen.add(listed.nextCursor);
        cursor = listed.nextCursor;
      }
      if (!result.toolsListed) throw new Error();
    } catch {
      result.failed = true;
      if (lastHttpError) result.httpErrorStatus = lastHttpError;
      process.exitCode = 1;
    } finally {
      if (transport.sessionId)
        await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }
    results.push(result);
  }
  console.log(
    JSON.stringify(
      {
        source: 'direct-sdk-preflight-not-cowork',
        results,
        querySubmitted: false,
        coworkInventoryVerified: false,
      },
      null,
      2
    )
  );
} catch {
  console.error(
    'MCP preflight failed; no credential values or raw errors were logged.'
  );
  process.exitCode = 1;
}
