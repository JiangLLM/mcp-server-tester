import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectMacCoworkProfile } from './macProfile.js';

const id = '11111111-2222-4333-8444-555555555555';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cowork-inspect-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function save(value: unknown) {
  await writeFile(
    path.join(root, '_meta.json'),
    JSON.stringify({ appliedId: id }),
    { mode: 0o600 }
  );
  await writeFile(path.join(root, `${id}.json`), JSON.stringify(value), {
    mode: 0o600,
  });
}

describe('read-only Mac profile inspection', () => {
  for (const container of [
    'direct',
    'values',
    'settings',
    'configuration',
    'config',
  ]) {
    it(`recognizes ${container} without returning secrets, endpoints, or commands`, async () => {
      const config = {
        inferenceProvider: 'gateway',
        inferenceGatewayApiKey: 'synthetic-private-token',
        inferenceGatewayBaseUrl: 'https://private.invalid',
        inferenceCredentialHelper: '/private/helper-with-secret',
        managedMcpServers: [
          { headers: { Authorization: 'synthetic-private-token' } },
        ],
      };
      await save(container === 'direct' ? config : { [container]: config });
      const result = await inspectMacCoworkProfile(root);
      expect(result).toMatchObject({
        applied: true,
        schema: container,
        provider: 'gateway',
        managedServerCount: 1,
        desktopVerified: false,
      });
      expect(result.fieldPresence).toContain('inferenceGatewayApiKey');
      expect(JSON.stringify(result)).not.toMatch(
        /synthetic-private-token|private.invalid|helper-with-secret/
      );
    });
  }
  it('does not return unrecognized provider values', async () => {
    await save({ inferenceProvider: 'synthetic-private-token' });
    expect((await inspectMacCoworkProfile(root)).provider).toBeNull();
  });
  it('does not claim ambiguous or empty schemas are configured', async () => {
    for (const value of [
      {},
      {
        inferenceProvider: 'gateway',
        settings: { inferenceProvider: 'anthropic' },
      },
    ]) {
      await save(value);
      expect(await inspectMacCoworkProfile(root)).toMatchObject({
        applied: true,
        schema: 'unknown',
        desktopVerified: false,
      });
    }
  });
  it('supports unapplied state without reading a configuration file', async () => {
    await writeFile(path.join(root, '_meta.json'), '{}', { mode: 0o600 });
    expect(await inspectMacCoworkProfile(root)).toMatchObject({
      applied: false,
      desktopVerified: false,
    });
  });
  it('rejects traversal and sanitized parsing errors', async () => {
    for (const text of [
      '{"appliedId":"../../synthetic-private-token"}',
      '{"synthetic-private-token":broken}',
    ]) {
      await writeFile(path.join(root, '_meta.json'), text, { mode: 0o600 });
      await expect(inspectMacCoworkProfile(root)).rejects.toThrow(
        /^Unable to inspect non-secret Cowork configuration state\.$/
      );
    }
  });
  it('rejects symlinked and writable-by-others profiles', async () => {
    await save({ inferenceProvider: 'gateway' });
    const file = path.join(root, `${id}.json`);
    await chmod(file, 0o666);
    await expect(inspectMacCoworkProfile(root)).rejects.toThrow(
      'Unable to inspect'
    );
    await rm(file);
    await symlink(path.join(root, '_meta.json'), file);
    await expect(inspectMacCoworkProfile(root)).rejects.toThrow(
      'Unable to inspect'
    );
  });
});
