import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadEvalManifest } from '../evalManifest.js';
import { createCoworkMcpPlan } from './config.js';

const directory = fileURLToPath(
  new URL('../../../examples/cowork-setup/', import.meta.url)
);
const names = [
  'single-server.manifest.json',
  'multi-server.manifest.json',
  'multi-server-approve-writes.manifest.json',
];

describe('organization-neutral Cowork examples', () => {
  it('contains only the generic example manifests and manual dataset', () => {
    expect(readdirSync(directory).sort()).toEqual(
      [...names, 'manual-query.json'].sort()
    );
  });

  it.each(names)(
    '%s uses reserved example URLs and credential references only',
    (name) => {
      const manifest = loadEvalManifest(join(directory, name));
      const servers = manifest.servers ?? [];
      expect(servers.length).toBe(
        name === 'single-server.manifest.json' ? 1 : 2
      );
      for (const server of servers) {
        expect(server.transport).toBe('http');
        if (server.transport !== 'http')
          throw new Error('Expected an HTTP example');
        const url = new URL(server.serverUrl);
        expect(url.protocol).toBe('https:');
        expect(url.hostname).toBe(`${server.label}.example.test`);
        expect(url.pathname).toBe('/mcp');
        expect(url.username + url.password + url.search + url.hash).toBe('');
        expect(server.headers).toBeUndefined();
        expect(server.auth).toEqual({
          accessTokenEnv: `${server.label?.toUpperCase()}_MCP_TOKEN`,
        });
      }
      expect(() =>
        createCoworkMcpPlan(servers, '/run/mst-example', manifest.coworkSetup)
      ).not.toThrow();
    }
  );

  it('uses independent token references for the two-server configuration', () => {
    const manifest = loadEvalManifest(
      join(directory, 'multi-server.manifest.json')
    );
    expect(manifest.servers).toEqual([
      {
        transport: 'http',
        label: 'search',
        serverUrl: 'https://search.example.test/mcp',
        auth: { accessTokenEnv: 'SEARCH_MCP_TOKEN' },
      },
      {
        transport: 'http',
        label: 'calendar',
        serverUrl: 'https://calendar.example.test/mcp',
        auth: { accessTokenEnv: 'CALENDAR_MCP_TOKEN' },
      },
    ]);
  });

  it('keeps write preapproval opt-in separate from the default example', () => {
    const baseline = loadEvalManifest(
      join(directory, 'multi-server.manifest.json')
    );
    const optedIn = loadEvalManifest(
      join(directory, 'multi-server-approve-writes.manifest.json')
    );
    expect(baseline.coworkSetup).toBeUndefined();
    expect(optedIn.coworkSetup).toEqual({ approveWriteTools: true });
    expect(optedIn.servers).toEqual(baseline.servers);
    const plan = createCoworkMcpPlan(
      optedIn.servers ?? [],
      '/run/mst-example',
      optedIn.coworkSetup
    );
    expect(
      plan.settings.managedMcpServers.map((server) => server.toolPolicy)
    ).toEqual([{ '*': 'allow' }, { '*': 'allow' }]);
  });
});
