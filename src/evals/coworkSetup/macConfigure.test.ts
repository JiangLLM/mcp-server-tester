import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../../scripts/cowork-mac-config.mjs', import.meta.url)
);
let root: string;
let compiled: string;
let app: string;
let profile: string;
let manifest: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cowork-manual-cli-'));
  compiled = path.join(root, 'compiled');
  profile = path.join(
    root,
    'Library/Application Support/Claude-3p/configLibrary'
  );
  app = path.join(root, 'app.sh');
  manifest = path.join(root, 'manifest.json');
  await mkdir(path.join(compiled, 'evals/coworkSetup'), { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, '_meta.json'), '{}', { mode: 0o600 });
  await writeFile(
    path.join(compiled, 'evals/evalManifest.js'),
    `import fs from 'node:fs'; export function loadEvalManifest(p){return JSON.parse(fs.readFileSync(p,'utf8'))}`,
    { mode: 0o600 }
  );
  await writeFile(
    path.join(compiled, 'evals/coworkSetup/macTransaction.js'),
    `
import fs from 'node:fs/promises'; import path from 'node:path';
export async function installMacCoworkSettings(o){
  const lock=path.join(o.profileDirectory,'.mst-setup-lock');
  await fs.mkdir(lock,{mode:0o700}); await fs.mkdir(o.stagingDirectory,{mode:0o700});
  await fs.writeFile(path.join(lock,'journal.json'), JSON.stringify({directory:o.stagingDirectory}),{mode:0o600});
  const settings={managedMcpServers:o.manifest.servers.map(s=>({name:s.label,transport:s.transport,url:s.serverUrl,headersHelper:'/private/helper',...(o.manifest.coworkSetup?.approveWriteTools === true ? {toolPolicy:{'*':'allow'}} : {})})),allowedMcpServers:o.manifest.servers.map(s=>({serverName:s.label})),allowManagedMcpServersOnly:true};
  await fs.writeFile(path.join(o.stagingDirectory,'managed-mcp.json'),JSON.stringify(settings),{mode:0o600});
  return {id:'11111111-2222-4333-8444-555555555555',directory:o.stagingDirectory};
}
export async function restoreMacCoworkSettings(p){
  try{await fs.access('running'); throw new Error('still running')}catch(e){if(e.code!=='ENOENT')throw e}
  const lock=path.join(p,'.mst-setup-lock');const j=JSON.parse(await fs.readFile(path.join(lock,'journal.json'),'utf8'));
  await fs.rm(j.directory,{recursive:true});await fs.rm(lock,{recursive:true});await fs.writeFile('restored','yes');
}
`,
    { mode: 0o600 }
  );
  await writeFile(
    app,
    `#!/bin/sh\ncase "$1" in\nstate)\n if test -f running; then running=true; else running=false; fi\n echo "{\\"running\\":$running,\\"instances\\":0,\\"workspaceApplicationCount\\":4,\\"claudeBundleReadable\\":true}";;\nstop) rm -f running; echo '{"stopped":true}';;\nstart) touch running; if test -f fail-start; then exit 1; fi; echo '{"launched":true}';;\nesac\n`,
    { mode: 0o700 }
  );
  await writeFile(
    manifest,
    JSON.stringify({
      name: 'manual',
      datasets: [],
      servers: [
        {
          transport: 'http',
          label: 'search',
          serverUrl: 'https://search.example.test/mcp',
          auth: { accessTokenEnv: 'SEARCH_MCP_TOKEN' },
        },
      ],
    })
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function run(action: 'configure' | 'restore') {
  return spawnSync(
    process.execPath,
    [
      script,
      action,
      compiled,
      app,
      ...(action === 'configure'
        ? [manifest, path.join(root, 'private.env'), profile]
        : [profile]),
    ],
    {
      cwd: root,
      env: { ...process.env, HOME: root },
      encoding: 'utf8',
      timeout: 15000,
    }
  );
}
async function sessionFiles() {
  return (await readdir(path.join(root, '.cowork-runtime'))).filter((name) =>
    /^manual-[a-f0-9]+\.json$/.test(name)
  );
}

describe.skipIf(process.platform !== 'darwin')(
  'manual configuration lifecycle (synthetic app/transaction)',
  () => {
    it('leaves configured app open, reports exact endpoint without claiming verification, then restores explicitly', async () => {
      const configured = run('configure');
      expect(configured.status, configured.stderr).toBe(0);
      expect(configured.stdout).toContain('https://search.example.test/mcp');
      expect(configured.stdout).toContain('"completeInventoryVerified": false');
      expect(configured.stdout).toContain('"querySubmitted": false');
      expect(configured.stdout).toContain('"restorationPending": true');
      expect(await readdir(root)).toContain('running');
      expect(await readdir(root)).not.toContain('restored');
      expect(await sessionFiles()).toHaveLength(1);
      const restored = run('restore');
      expect(restored.status, restored.stderr).toBe(0);
      expect(await readdir(root)).not.toContain('running');
      expect(await readdir(root)).toContain('restored');
      expect(await sessionFiles()).toHaveLength(0);
    });
    it('reports opt-in policies without claiming native verification or executing queries', async () => {
      const input = JSON.parse(await readFile(manifest, 'utf8')) as Record<
        string,
        unknown
      >;
      input.coworkSetup = { approveWriteTools: true };
      await writeFile(manifest, JSON.stringify(input));
      const result = run('configure');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('Write-tool preapproval enabled');
      expect(result.stdout).toContain('"toolPolicyVerified": false');
      expect(result.stdout).toContain('"querySubmitted": false');
      expect(result.stdout).toContain('"*": "allow"');
      expect(run('restore').status).toBe(0);
    });
    it.each([0, 2, 6])(
      'configures exactly %i servers without a single-server limit',
      async (count) => {
        const servers = Array.from({ length: count }, (_, index) => ({
          transport: 'http',
          label: `server_${index}`,
          serverUrl: `https://server-${index}.example.test/mcp`,
          auth: { accessTokenEnv: `TOKEN_${index}` },
        }));
        await writeFile(
          manifest,
          JSON.stringify({ name: 'multi', datasets: [], servers })
        );
        const configured = run('configure');
        expect(configured.status, configured.stderr).toBe(0);
        const directory = path.join(root, '.mcp-test-results/cowork-setup');
        const names = await readdir(directory);
        const receipt = JSON.parse(
          await readFile(path.join(directory, names[0]!), 'utf8')
        ) as {
          configuredServers: Array<{ name: string; url: string }>;
          allowedMcpServers: Array<{ serverName: string }>;
          completeInventoryVerified: boolean;
        };
        expect(
          receipt.configuredServers.map((server) => [server.name, server.url])
        ).toEqual(servers.map((server) => [server.label, server.serverUrl]));
        expect(receipt.allowedMcpServers).toEqual(
          servers.map((server) => ({ serverName: server.label }))
        );
        expect(receipt.completeInventoryVerified).toBe(false);
        expect(run('restore').status).toBe(0);
      }
    );
    it('restores the original running state when Claude was originally open', async () => {
      await writeFile(path.join(root, 'running'), '');
      expect(run('configure').status).toBe(0);
      expect(run('restore').status).toBe(0);
      expect(await readdir(root)).toContain('running');
    });
    it('does not stop an automatic host session that already owns the profile', async () => {
      await mkdir(path.join(profile, '.mst-session-lock'), { mode: 0o700 });
      await writeFile(path.join(root, 'running'), '');
      const result = run('configure');
      expect(result.status).toBe(1);
      expect(await readdir(root)).toContain('running');
      expect(await sessionFiles()).toHaveLength(0);
    });
    it('refuses a second configure without undoing the first session', async () => {
      expect(run('configure').status).toBe(0);
      expect(run('configure').status).toBe(1);
      expect(await readdir(root)).toContain('running');
      expect(await readdir(root)).not.toContain('restored');
      expect(run('restore').status).toBe(0);
    });
    it('restores after a partially successful app launch fails', async () => {
      await writeFile(path.join(root, 'fail-start'), '');
      const result = run('configure');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('restored after failure');
      expect(await sessionFiles()).toHaveLength(0);
      expect(await readdir(root)).not.toContain('running');
    });
    it('does not touch app state when the recovery lock belongs to another run', async () => {
      expect(run('configure').status).toBe(0);
      await writeFile(
        path.join(profile, '.mst-setup-lock/journal.json'),
        JSON.stringify({ directory: '/not-this-run' })
      );
      expect(run('restore').status).toBe(1);
      expect(await readdir(root)).toContain('running');
      expect(await readdir(root)).not.toContain('restored');
    });
    it('missing recovery journal plus leftover staging cannot be misreported as restored', async () => {
      expect(run('configure').status).toBe(0);
      await rm(path.join(profile, '.mst-setup-lock'), { recursive: true });
      expect(run('restore').status).toBe(1);
      expect(await sessionFiles()).toHaveLength(1);
      expect(await readdir(root)).toContain('running');
    });
    it('reports the failing restore phase without exposing raw recovery errors', async () => {
      expect(run('configure').status).toBe(0);
      const module = path.join(compiled, 'evals/coworkSetup/macTransaction.js');
      const source = await readFile(module, 'utf8');
      await writeFile(
        module,
        source.replace(
          'export async function restoreMacCoworkSettings(p){',
          'export async function restoreMacCoworkSettings(p){ throw new Error("synthetic-private-token");'
        )
      );
      const result = run('restore');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('failed at restore-files');
      expect(result.stderr).not.toContain('synthetic-private-token');
      expect(result.stdout).not.toContain('synthetic-private-token');
      expect(await sessionFiles()).toHaveLength(1);
      expect(await readdir(path.join(profile, '.mst-setup-lock'))).toContain(
        'journal.json'
      );
    });
    it('invalid manifest data is not echoed', async () => {
      await writeFile(manifest, '{"synthetic-private-token":broken}');
      const result = run('configure');
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain('synthetic-private-token');
      expect(result.stdout).not.toContain('synthetic-private-token');
    });
  }
);
