import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../../../scripts/cowork-mac-smoke.mjs', import.meta.url)
);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cowork-smoke-cli-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fixtures(guiAvailable: boolean) {
  const app = path.join(root, 'app.sh');
  const transaction = path.join(root, 'transaction.mjs');
  const profile = path.join(root, 'profile');
  await mkdir(profile);
  await writeFile(
    app,
    `#!/bin/sh\ncase "$1" in\nstate)\n if test -f running; then running=true; else running=false; fi\n echo "{\\"running\\":$running,\\"instances\\":0,\\"workspaceApplicationCount\\":${guiAvailable ? 5 : 0},\\"claudeBundleReadable\\":true,\\"accessibilityTrusted\\":false}";;\nstart) touch running; echo '{"reason":"launch-services-error","code":259}'; exit 1;;\nstop) rm -f running; touch stopped; echo '{"stopped":true}';;\nesac\n`,
    { mode: 0o700 }
  );
  await writeFile(
    transaction,
    `import fs from 'node:fs/promises';\nexport async function installMacCoworkSettings(){await fs.writeFile('installed','yes');return {restore:async()=>{try {await fs.access('running');throw new Error('still running')} catch(error){if(error.code!=='ENOENT')throw error;} await fs.writeFile('restored','yes');}};}\n`
  );
  return { app, transaction, profile };
}
async function run(guiAvailable: boolean) {
  const f = await fixtures(guiAvailable);
  const result = spawnSync(
    process.execPath,
    [
      script,
      f.profile,
      path.join(root, 'nonexistent-secret-file'),
      f.transaction,
      f.app,
    ],
    { cwd: root, encoding: 'utf8', timeout: 20000 }
  );
  const reports = path.join(root, '.mcp-test-results/cowork-setup');
  const files = await readdir(reports);
  const report = JSON.parse(
    await readFile(path.join(reports, files[0]!), 'utf8')
  ) as Record<string, unknown>;
  return { result, report, files: await readdir(root) };
}

describe.skipIf(process.platform !== 'darwin')(
  'Mac smoke control boundaries (synthetic controller, not live Cowork)',
  () => {
    it('rejects missing GUI visibility before installation or secret access', async () => {
      const { result, report, files } = await run(false);
      expect(result.status).toBe(1);
      expect(report).toMatchObject({
        status: 'gui-session-unavailable',
        querySubmitted: false,
        nativeMcpInitialized: false,
        cleanupVerified: false,
        phase: 'no-profile-mutation',
      });
      expect(files).not.toContain('installed');
      expect(files).not.toContain('running');
    });
    it('stops a partially launched app before restoring files after a launch failure', async () => {
      const { result, report, files } = await run(true);
      expect(result.status).toBe(1);
      expect(report).toMatchObject({
        status: 'setup-failed',
        failurePhase: 'app-start',
        nativeFailureCode: 259,
        querySubmitted: false,
        cleanupVerified: true,
        completeInventoryVerified: false,
      });
      expect(files).toContain('installed');
      expect(files).toContain('stopped');
      expect(files).toContain('restored');
      expect(files).not.toContain('running');
    });
  }
);
