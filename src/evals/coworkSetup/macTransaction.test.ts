import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvalManifest } from '../evalManifest.js';
import {
  installMacCoworkSettings,
  restoreMacCoworkSettings,
} from './macTransaction.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
    rmdir: vi.fn(actual.rmdir),
    lstat: vi.fn(actual.lstat),
  };
});
const actual = await vi.importActual<typeof fs>('node:fs/promises');
const ERROR = 'Unable to change Cowork configuration safely.';
const HELPER_ERROR = 'Unable to read Cowork inference credential.\n';
const TOKEN = 'synthetic-inference-key';
const MCP_TOKEN = 'synthetic-mcp-key';
const SOURCE = '11111111-2222-3333-4444-555555555555';
const ORIGINAL =
  JSON.stringify(
    {
      appliedId: SOURCE,
      entries: [{ id: SOURCE, name: 'Original' }],
      ui: { color: 'blue' },
    },
    null,
    4
  ) + '\n';
let root: string;
let profileDirectory: string;
let stagingDirectory: string;
let secretsFile: string;
let lock: string;

type Options = Parameters<typeof installMacCoworkSettings>[0];

function manifest(): EvalManifest {
  return {
    name: 'synthetic',
    datasets: [],
    servers: [
      {
        transport: 'http',
        label: 'Search',
        serverUrl: 'https://search.example.test/mcp',
        auth: { accessTokenEnv: 'MCP_KEY' },
      },
    ],
  };
}

function options(overrides: Partial<Options> = {}): Options {
  return {
    profileDirectory,
    stagingDirectory,
    secretsFile,
    managedPreferencePaths: [join(root, 'managed.plist')],
    manifest: manifest(),
    ...overrides,
  };
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
}

async function expectGone(file: string): Promise<void> {
  await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function expectOriginal(): Promise<void> {
  expect(await fs.readFile(join(profileDirectory, '_meta.json'), 'utf8')).toBe(
    ORIGINAL
  );
  expect(
    await fs.readFile(join(profileDirectory, `${SOURCE}.json`), 'utf8')
  ).toBe(' { } \n');
}

async function expectClean(): Promise<void> {
  await expectOriginal();
  await expectGone(stagingDirectory);
  await expectGone(lock);
  expect((await fs.readdir(profileDirectory)).sort()).toEqual(
    [`${SOURCE}.json`, '_meta.json'].sort()
  );
}

function invokeHelper(): ReturnType<typeof spawnSync> {
  return spawnSync(join(stagingDirectory, 'inference-helper.sh'), [], {
    env: {},
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 128 * 1024,
  });
}

beforeEach(async () => {
  vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile);
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink);
  vi.mocked(fs.rmdir).mockReset().mockImplementation(actual.rmdir);
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat);
  root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'mst_mac-transaction-'))
  );
  await fs.chmod(root, 0o700);
  profileDirectory = join(root, 'library');
  stagingDirectory = join(root, 'staged');
  secretsFile = join(root, '.env');
  lock = join(profileDirectory, '.mst-setup-lock');
  await fs.mkdir(profileDirectory, { mode: 0o700 });
  await fs.writeFile(join(profileDirectory, '_meta.json'), ORIGINAL, {
    mode: 0o600,
  });
  await fs.writeFile(join(profileDirectory, `${SOURCE}.json`), ' { } \n', {
    mode: 0o600,
  });
  await fs.writeFile(
    secretsFile,
    `ANTHROPIC_API_KEY=${TOKEN}\nMCP_KEY=${MCP_TOKEN}\n`,
    { mode: 0o600 }
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await actual.rm(root, { recursive: true, force: true });
});

describe('Mac Cowork settings transaction', () => {
  it('installs opt-in tool policy and restores the exact original profile without leaking it into the next run', async () => {
    const input = manifest();
    input.coworkSetup = { approveWriteTools: true };
    const installed = await installMacCoworkSettings(
      options({ manifest: input })
    );
    const configured = await readJson(
      join(profileDirectory, `${installed.id}.json`)
    );
    expect(configured.managedMcpServers).toEqual([
      expect.objectContaining({ name: 'Search', toolPolicy: { '*': 'allow' } }),
    ]);
    expect(configured).not.toHaveProperty('builtinToolPolicy');
    expect(configured).not.toHaveProperty('disableBypassPermissionsMode');
    await installed.restore();
    await expectClean();
    const next = await installMacCoworkSettings(options());
    const nextProfile = await readJson(
      join(profileDirectory, `${next.id}.json`)
    );
    expect(
      (nextProfile.managedMcpServers as Array<Record<string, unknown>>)[0]
    ).not.toHaveProperty('toolPolicy');
    await next.restore();
    await expectClean();
  });
  it('preserves user changes to tool policy instead of silently restoring over them', async () => {
    const input = manifest();
    input.coworkSetup = { approveWriteTools: true };
    const installed = await installMacCoworkSettings(
      options({ manifest: input })
    );
    const file = join(profileDirectory, `${installed.id}.json`);
    const configured = await readJson(file);
    (
      configured.managedMcpServers as Array<Record<string, unknown>>
    )[0]!.toolPolicy = { '*': 'ask' };
    await fs.writeFile(file, JSON.stringify(configured));
    await expect(installed.restore()).rejects.toThrow(ERROR);
    expect(await readJson(file)).toEqual(configured);
    await fs.access(join(lock, 'journal.json'));
    await fs.access(stagingDirectory);
  });
  it.each([0, 2, 6])(
    'isolates credentials and restores an exact %i-server profile',
    async (count) => {
      const input = manifest();
      input.servers = Array.from({ length: count }, (_, index) => ({
        transport: 'http' as const,
        label: `server_${index}`,
        serverUrl: `https://server-${index}.example.test/mcp`,
        auth: { accessTokenEnv: `TOKEN_${index}` },
      }));
      await fs.writeFile(
        secretsFile,
        `ANTHROPIC_API_KEY=${TOKEN}\n` +
          Array.from(
            { length: count },
            (_, index) => `TOKEN_${index}=synthetic-server-${index}\n`
          ).join('')
      );
      const installed = await installMacCoworkSettings(
        options({ manifest: input })
      );
      const configured = await readJson(
        join(profileDirectory, `${installed.id}.json`)
      );
      const servers = configured.managedMcpServers as Array<{
        name: string;
        url: string;
        headersHelper: string;
      }>;
      expect(servers.map((server) => [server.name, server.url])).toEqual(
        input.servers.map((server) => [
          server.label,
          server.transport === 'http' ? server.serverUrl : null,
        ])
      );
      expect(configured.allowedMcpServers).toEqual(
        input.servers.map((server) => ({ serverName: server.label }))
      );
      for (const [index, server] of servers.entries()) {
        const reply = spawnSync(server.headersHelper, [], {
          encoding: 'utf8',
          timeout: 5000,
          env: {},
        });
        expect(reply.status, reply.stderr).toBe(0);
        expect(JSON.parse(reply.stdout)).toEqual({
          Authorization: `Bearer synthetic-server-${index}`,
        });
        expect(JSON.stringify(configured)).not.toContain(
          `synthetic-server-${index}`
        );
      }
      await installed.restore();
      await expectClean();
    }
  );
  it('two servers, replacement set, and empty set never accumulate registrations', async () => {
    for (const labels of [['first', 'second'], ['replacement'], []]) {
      const input = manifest();
      input.servers = labels.map((label) => ({
        transport: 'http',
        label,
        serverUrl: `https://${label}.example.test/mcp`,
        auth: { accessTokenEnv: 'MCP_KEY' },
      }));
      const installed = await installMacCoworkSettings(
        options({ manifest: input })
      );
      const configured = await readJson(
        join(profileDirectory, `${installed.id}.json`)
      );
      expect(
        (configured.managedMcpServers as Array<{ name: string }>).map(
          (server) => server.name
        )
      ).toEqual(labels);
      await installed.restore();
      await expectClean();
    }
  });
  it('installs a new private flat profile, keeps source bytes, and restores exact metadata', async () => {
    const result = await installMacCoworkSettings(options());
    expect(result.status).toBe('applied-not-verified');
    expect(result.directory).toBe(stagingDirectory);
    expect(result.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.id).not.toBe(SOURCE);
    const profile = await readJson(join(profileDirectory, `${result.id}.json`));
    expect(profile).toEqual({
      managedMcpServers: [
        {
          name: 'Search',
          transport: 'http',
          url: 'https://search.example.test/mcp',
          headersHelper: join(stagingDirectory, 'mcp-Search-headers.sh'),
        },
      ],
      allowedMcpServers: [{ serverName: 'Search' }],
      allowManagedMcpServersOnly: true,
      inferenceProvider: 'anthropic',
      inferenceCredentialKind: 'helper-script',
      inferenceCredentialHelper: join(stagingDirectory, 'inference-helper.sh'),
    });
    expect(await readJson(join(profileDirectory, '_meta.json'))).toEqual({
      appliedId: result.id,
      entries: [
        { id: SOURCE, name: 'Original' },
        { id: result.id, name: 'MST test' },
      ],
      ui: { color: 'blue' },
    });
    expect(
      await fs.readFile(join(profileDirectory, `${SOURCE}.json`), 'utf8')
    ).toBe(' { } \n');
    for (const file of [
      join(profileDirectory, `${result.id}.json`),
      join(profileDirectory, '_meta.json'),
      join(lock, 'journal.json'),
      join(stagingDirectory, 'credentials/inference.json'),
    ]) {
      const info = await fs.stat(file);
      expect(info.uid).toBe(process.getuid!());
      expect(info.mode & 0o777).toBe(0o600);
    }
    expect((await fs.stat(lock)).mode & 0o777).toBe(0o700);
    const invoked = invokeHelper();
    expect(invoked.error).toBeUndefined();
    expect(invoked.status).toBe(0);
    expect(invoked.stdout).toBe(TOKEN + '\n');
    expect(invoked.stderr).toBe('');
    await result.restore();
    await expectClean();
  });

  it('keeps credentials out of profile, metadata, helper, and journal', async () => {
    const result = await installMacCoworkSettings(options());
    for (const file of [
      join(profileDirectory, `${result.id}.json`),
      join(profileDirectory, '_meta.json'),
      join(lock, 'journal.json'),
      join(stagingDirectory, 'inference-helper.sh'),
      join(stagingDirectory, 'managed-mcp.json'),
    ]) {
      const bytes = await fs.readFile(file, 'utf8');
      expect(bytes).not.toContain(TOKEN);
      expect(bytes).not.toContain(MCP_TOKEN);
      expect(bytes).not.toContain('inferenceModels');
    }
    const journal = await readJson(join(lock, 'journal.json'));
    expect(
      Buffer.from(journal.originalMeta as string, 'base64').toString()
    ).toBe(ORIGINAL);
    await restoreMacCoworkSettings(profileDirectory);
    await expectClean();
  });

  it('selects a requested manifest arm through the canonical bundle', async () => {
    const input = manifest();
    input.arms = [{ name: 'empty', servers: [] }];
    const result = await installMacCoworkSettings(
      options({ manifest: input, arm: 'empty' })
    );
    expect(
      (await readJson(join(profileDirectory, `${result.id}.json`)))
        .managedMcpServers
    ).toEqual([]);
    await result.restore();
  });

  it('accepts explicit runtime inference and MCP credentials without a secrets file', async () => {
    await fs.unlink(secretsFile);
    const result = await installMacCoworkSettings(
      options({
        secretsFile: undefined,
        env: { ANTHROPIC_API_KEY: TOKEN, MCP_KEY: MCP_TOKEN },
      })
    );
    expect(
      await readJson(join(stagingDirectory, 'credentials/inference.json'))
    ).toEqual({ ANTHROPIC_API_KEY: TOKEN });
    expect(
      await readJson(join(stagingDirectory, 'credentials/Search.json'))
    ).toEqual({ Authorization: `Bearer ${MCP_TOKEN}` });
    await result.restore();
    await expectClean();
  });

  it('never uses ambient inference or MCP credentials in runtime-env mode', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', TOKEN);
    vi.stubEnv('MCP_KEY', MCP_TOKEN);
    for (const env of [
      undefined,
      {},
      { ANTHROPIC_API_KEY: TOKEN },
      { MCP_KEY: MCP_TOKEN },
    ]) {
      await expect(
        installMacCoworkSettings(options({ secretsFile: undefined, env }))
      ).rejects.toThrow(ERROR);
      await expectClean();
    }
  });

  it('keeps explicit secrets-file precedence for inference and MCP keys', async () => {
    const result = await installMacCoworkSettings(
      options({
        env: {
          ANTHROPIC_API_KEY: 'synthetic-env-override',
          MCP_KEY: 'synthetic-env-override',
        },
      })
    );
    expect(
      await readJson(join(stagingDirectory, 'credentials/inference.json'))
    ).toEqual({ ANTHROPIC_API_KEY: TOKEN });
    expect(
      await readJson(join(stagingDirectory, 'credentials/Search.json'))
    ).toEqual({ Authorization: `Bearer ${MCP_TOKEN}` });
    await result.restore();
    await expectClean();
  });

  it('never falls back to ambient or supplied inference credentials when a secrets file is supplied', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', TOKEN);
    vi.stubEnv('MCP_KEY', MCP_TOKEN);
    await fs.writeFile(secretsFile, 'MCP_KEY=synthetic-only\n');
    await expect(
      installMacCoworkSettings(options({ env: { ANTHROPIC_API_KEY: TOKEN } }))
    ).rejects.toThrow(ERROR);
    await expectClean();
    await fs.writeFile(secretsFile, `ANTHROPIC_API_KEY=${TOKEN}\n`);
    await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
    await expectClean();
  });

  it.each(['missing', 'malformed', 'public', 'symlink', 'invalid-token'])(
    'rejects %s explicit credential files without changing the profile',
    async (kind) => {
      if (kind === 'missing') await fs.unlink(secretsFile);
      if (kind === 'malformed')
        await fs.writeFile(secretsFile, 'ANTHROPIC_API_KEY="unterminated');
      if (kind === 'public') await fs.chmod(secretsFile, 0o644);
      if (kind === 'symlink') {
        await fs.rename(secretsFile, join(root, 'secret-target'));
        await fs.symlink(join(root, 'secret-target'), secretsFile);
      }
      if (kind === 'invalid-token')
        await fs.writeFile(secretsFile, 'ANTHROPIC_API_KEY="bad value"');
      await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
      await expectClean();
    }
  );

  it('rejects a second install without disturbing the existing transaction', async () => {
    const result = await installMacCoworkSettings(options());
    const journal = await fs.readFile(join(lock, 'journal.json'));
    await expect(
      installMacCoworkSettings(
        options({ stagingDirectory: join(root, 'other-stage') })
      )
    ).rejects.toThrow(ERROR);
    expect(await fs.readFile(join(lock, 'journal.json'))).toEqual(journal);
    await expectGone(join(root, 'other-stage'));
    await result.restore();
  });

  it.each(['../escape', '', 'not-a-uuid'])(
    'rejects invalid applied UUID %s',
    async (id) => {
      await fs.writeFile(
        join(profileDirectory, '_meta.json'),
        JSON.stringify({ appliedId: id, entries: [{ id, name: 'bad' }] })
      );
      await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
      await expectGone(lock);
      await expectGone(stagingDirectory);
    }
  );

  it.each([{ inferenceProvider: 'anthropic' }, { settings: {} }, []])(
    'rejects nonempty/unsupported source %j',
    async (source) => {
      const bytes = JSON.stringify(source);
      await fs.writeFile(join(profileDirectory, `${SOURCE}.json`), bytes);
      await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
      expect(
        await fs.readFile(join(profileDirectory, `${SOURCE}.json`), 'utf8')
      ).toBe(bytes);
      await expectGone(lock);
    }
  );

  it('rejects managed preferences including dangling symlinks and permission-unknown paths', async () => {
    const managed = join(root, 'managed.plist');
    await fs.symlink(join(root, 'missing-target'), managed);
    await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
    await fs.unlink(managed);
    vi.mocked(fs.lstat).mockImplementation(
      async (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === managed)
          throw Object.assign(new Error(TOKEN), { code: 'EACCES' });
        return actual.lstat(...args);
      }
    );
    await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
    await expectClean();
  });

  it('rejects unsafe library permissions and a symlink library', async () => {
    await fs.chmod(profileDirectory, 0o777);
    await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
    await fs.chmod(profileDirectory, 0o700);
    const alias = join(root, 'library-alias');
    await fs.symlink(profileDirectory, alias);
    await expect(
      installMacCoworkSettings(options({ profileDirectory: alias }))
    ).rejects.toThrow(ERROR);
    await expectClean();
  });

  it.each(['stage with spaces', '../outside'])(
    'rejects unsafe staging path %s',
    async (name) => {
      await expect(
        installMacCoworkSettings(
          options({ stagingDirectory: stagingDirectory + '/' + name })
        )
      ).rejects.toThrow(ERROR);
      await expectClean();
    }
  );

  it('never removes a preexisting staging directory', async () => {
    await fs.mkdir(stagingDirectory, { mode: 0o700 });
    await fs.writeFile(join(stagingDirectory, 'user-file'), 'keep');
    await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
    expect(await fs.readFile(join(stagingDirectory, 'user-file'), 'utf8')).toBe(
      'keep'
    );
    await expectGone(lock);
    await expectOriginal();
  });

  it.each(['no-final-newline', 'compact', 'four-space', 'crlf'])(
    'restores after Claude rewrites metadata formatting: %s',
    async (format) => {
      const installed = await installMacCoworkSettings(options());
      const file = join(profileDirectory, '_meta.json');
      const before = await fs.readFile(file, 'utf8');
      const value: unknown = JSON.parse(before);
      const rewritten =
        format === 'no-final-newline'
          ? before.trimEnd()
          : format === 'compact'
            ? JSON.stringify(value)
            : format === 'four-space'
              ? JSON.stringify(value, null, 4) + '\n'
              : before.replaceAll('\n', '\r\n');
      expect(rewritten).not.toBe(before);
      await fs.writeFile(file, rewritten);
      // Explicit recovery must support journals from older CLI runs too.
      await restoreMacCoworkSettings(profileDirectory);
      await expectClean();
      expect(installed.status).toBe('applied-not-verified');
    }
  );
  it('preserves whitespace and escaped characters inside metadata strings', async () => {
    const original =
      JSON.stringify(
        {
          appliedId: SOURCE,
          entries: [{ id: SOURCE, name: 'Original "quoted" \\ path' }],
          note: 'line one\nline two  spaces',
        },
        null,
        4
      ) + '\n';
    await fs.writeFile(join(profileDirectory, '_meta.json'), original);
    const installed = await installMacCoworkSettings(options());
    const file = join(profileDirectory, '_meta.json');
    const current: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify(current));
    await installed.restore();
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    await expectGone(lock);
    await expectGone(stagingDirectory);
  });
  it.each([
    'renamed-entry',
    'changed-selection',
    'extra-field',
    'duplicate-key',
    'changed-string-space',
  ])(
    'does not confuse substantive metadata changes with formatting: %s',
    async (change) => {
      const installed = await installMacCoworkSettings(options());
      const file = join(profileDirectory, '_meta.json');
      const value = JSON.parse(await fs.readFile(file, 'utf8')) as {
        appliedId: string;
        entries: Array<{ id: string; name: string }>;
        ui: { color: string };
        extra?: boolean;
      };
      if (change === 'renamed-entry') value.entries[1]!.name = 'user edit';
      if (change === 'changed-selection') value.appliedId = SOURCE;
      if (change === 'extra-field') value.extra = true;
      if (change === 'changed-string-space') value.entries[1]!.name = 'MSTtest';
      let rewritten = JSON.stringify(value);
      if (change === 'duplicate-key')
        rewritten = rewritten.replace(
          '"appliedId":',
          `"appliedId":"${SOURCE}","appliedId":`
        );
      await fs.writeFile(file, rewritten);
      await expect(installed.restore()).rejects.toThrow(ERROR);
      expect(await fs.readFile(file, 'utf8')).toBe(rewritten);
      expect(await fs.readdir(lock)).toContain('journal.json');
      await fs.access(stagingDirectory);
    }
  );
  it.each(['metadata', 'profile', 'staged-file', 'extra-file', 'marker'])(
    'retains lock/journal and never clobbers changed %s',
    async (kind) => {
      const result = await installMacCoworkSettings(options());
      const target =
        kind === 'metadata'
          ? join(profileDirectory, '_meta.json')
          : kind === 'profile'
            ? join(profileDirectory, `${result.id}.json`)
            : kind === 'staged-file'
              ? join(stagingDirectory, 'credentials/inference.json')
              : kind === 'marker'
                ? join(stagingDirectory, '.mst-setup-marker')
                : join(stagingDirectory, 'user-file');
      const previousMeta = await fs.readFile(
        join(profileDirectory, '_meta.json')
      );
      await fs.writeFile(target, 'user-change', { mode: 0o600 });
      await expect(result.restore()).rejects.toThrow(ERROR);
      expect(await fs.readFile(target, 'utf8')).toBe('user-change');
      expect(await fs.readFile(join(profileDirectory, '_meta.json'))).toEqual(
        kind === 'metadata' ? Buffer.from('user-change') : previousMeta
      );
      expect(await fs.lstat(join(lock, 'journal.json'))).toBeDefined();
      expect(
        await fs.lstat(join(profileDirectory, `${result.id}.json`))
      ).toBeDefined();
    }
  );

  it('cleans only owned files when applying metadata fails', async () => {
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === join(profileDirectory, '_meta.json')) throw new Error(TOKEN);
      await actual.rename(from, to);
    });
    await fs.writeFile(join(root, 'unrelated'), 'keep');
    await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
    await expectClean();
    expect(await fs.readFile(join(root, 'unrelated'), 'utf8')).toBe('keep');
  });

  it('cleans a marked stage when helper creation fails before a profile exists', async () => {
    vi.mocked(fs.writeFile).mockImplementation(
      async (...args: Parameters<typeof fs.writeFile>) => {
        if (args[0] === join(stagingDirectory, 'inference-helper.sh'))
          throw new Error(TOKEN);
        await actual.writeFile(...args);
      }
    );
    await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
    await expectClean();
  });

  it('detects concurrent metadata changes immediately before rename', async () => {
    vi.mocked(fs.writeFile).mockImplementation(
      async (...args: Parameters<typeof fs.writeFile>) => {
        await actual.writeFile(...args);
        if (
          typeof args[0] === 'string' &&
          args[0].startsWith(profileDirectory + '/') &&
          args[0].endsWith('.json') &&
          args[0] !== join(profileDirectory, '_meta.json') &&
          args[0] !== join(profileDirectory, `${SOURCE}.json`)
        ) {
          await actual.writeFile(
            join(profileDirectory, '_meta.json'),
            'user-change'
          );
        }
      }
    );
    await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
    expect(
      await fs.readFile(join(profileDirectory, '_meta.json'), 'utf8')
    ).toBe('user-change');
    expect(await fs.lstat(join(lock, 'journal.json'))).toBeDefined();
  });

  it('retains a journal on cleanup failure and supports later explicit recovery', async () => {
    const result = await installMacCoworkSettings(options());
    vi.mocked(fs.unlink).mockImplementationOnce(async () => {
      throw new Error(TOKEN);
    });
    await expect(result.restore()).rejects.toThrow(ERROR);
    await expectOriginal();
    expect(await fs.lstat(join(lock, 'journal.json'))).toBeDefined();
    await restoreMacCoworkSettings(profileDirectory);
    await expectClean();
  });

  it('recovers after partial staging cleanup', async () => {
    const result = await installMacCoworkSettings(options());
    const blocked = join(stagingDirectory, 'inference-helper.sh');
    vi.mocked(fs.unlink).mockImplementation(async (file) => {
      if (file === blocked) throw new Error(TOKEN);
      await actual.unlink(file);
    });
    await expect(result.restore()).rejects.toThrow(ERROR);
    vi.mocked(fs.unlink).mockImplementation(actual.unlink);
    await restoreMacCoworkSettings(profileDirectory);
    await expectClean();
  });

  it('keeps an old restore closure from restoring a newer transaction', async () => {
    const first = await installMacCoworkSettings(options());
    await first.restore();
    const second = await installMacCoworkSettings(options());
    await expect(first.restore()).rejects.toThrow(ERROR);
    expect(
      (await readJson(join(profileDirectory, '_meta.json'))).appliedId
    ).toBe(second.id);
    await second.restore();
    await expectClean();
  });

  it('releases the lock when the initial journal cannot be persisted', async () => {
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === join(lock, 'journal.json')) throw new Error(TOKEN);
      await actual.rename(from, to);
    });
    await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
    await expectClean();
  });

  it('cleans a bundle write failure before profile mutation', async () => {
    vi.mocked(fs.writeFile).mockImplementation(
      async (...args: Parameters<typeof fs.writeFile>) => {
        if (args[0] === join(stagingDirectory, 'managed-mcp.json'))
          throw new Error(TOKEN);
        await actual.writeFile(...args);
      }
    );
    await expect(installMacCoworkSettings(options())).rejects.toThrow(ERROR);
    await expectClean();
  });

  it('restores the marker when final staging removal fails, permitting recovery', async () => {
    const result = await installMacCoworkSettings(options());
    vi.mocked(fs.rmdir).mockImplementation(
      async (...args: Parameters<typeof fs.rmdir>) => {
        if (args[0] === stagingDirectory) throw new Error(TOKEN);
        await actual.rmdir(...args);
      }
    );
    await expect(result.restore()).rejects.toThrow(ERROR);
    expect(
      await fs.lstat(join(stagingDirectory, '.mst-setup-marker'))
    ).toBeDefined();
    expect(await fs.lstat(join(lock, 'journal.json'))).toBeDefined();
    vi.mocked(fs.rmdir).mockImplementation(actual.rmdir);
    await restoreMacCoworkSettings(profileDirectory);
    await expectClean();
  });

  it('retains the journal if lock removal fails and can retry recovery', async () => {
    const result = await installMacCoworkSettings(options());
    vi.mocked(fs.rmdir).mockImplementation(
      async (...args: Parameters<typeof fs.rmdir>) => {
        if (args[0] === lock) throw new Error(TOKEN);
        await actual.rmdir(...args);
      }
    );
    await expect(result.restore()).rejects.toThrow(ERROR);
    expect(await fs.lstat(join(lock, 'journal.json'))).toBeDefined();
    vi.mocked(fs.rmdir).mockImplementation(actual.rmdir);
    await restoreMacCoworkSettings(profileDirectory);
    await expectClean();
  });

  it.each(['id', 'directory', 'files'])(
    'rejects malicious recovery journal %s paths',
    async (field) => {
      const result = await installMacCoworkSettings(options());
      const journalPath = join(lock, 'journal.json');
      const journal = await readJson(journalPath);
      const victim = join(root, 'victim');
      await fs.mkdir(victim, { mode: 0o700 });
      await fs.writeFile(join(victim, 'keep'), 'keep', { mode: 0o600 });
      if (field === 'id') journal.id = '../victim/keep';
      if (field === 'directory') journal.directory = victim;
      if (field === 'files')
        journal.files = { '../victim/keep': '0'.repeat(64) };
      await fs.writeFile(journalPath, JSON.stringify(journal));
      await expect(restoreMacCoworkSettings(profileDirectory)).rejects.toThrow(
        ERROR
      );
      expect(await fs.readFile(join(victim, 'keep'), 'utf8')).toBe('keep');
      expect(
        (await readJson(join(profileDirectory, '_meta.json'))).appliedId
      ).toBe(result.id);
      expect(await fs.lstat(journalPath)).toBeDefined();
    }
  );

  it.each([
    'missing',
    'malformed',
    'duplicate',
    'public',
    'symlink',
    'oversize',
    'directory',
    'fifo',
  ])(
    'helper rejects %s credentials with only a fixed generic error',
    async (kind) => {
      await installMacCoworkSettings(options());
      const file = join(stagingDirectory, 'credentials/inference.json');
      if (kind === 'missing') await fs.unlink(file);
      if (kind === 'malformed') await fs.writeFile(file, TOKEN);
      if (kind === 'duplicate')
        await fs.writeFile(
          file,
          `{"ANTHROPIC_API_KEY":"${TOKEN}","ANTHROPIC_API_KEY":"other"}`
        );
      if (kind === 'public') await fs.chmod(file, 0o644);
      if (kind === 'symlink') {
        await fs.unlink(file);
        await fs.symlink(secretsFile, file);
      }
      if (kind === 'oversize') await fs.writeFile(file, 'a'.repeat(65537));
      if (kind === 'directory') {
        await fs.unlink(file);
        await fs.mkdir(file, { mode: 0o700 });
      }
      if (kind === 'fifo') {
        await fs.unlink(file);
        const fifo = spawnSync('/usr/bin/mkfifo', ['-m', '600', file], {
          encoding: 'utf8',
          timeout: 5000,
        });
        expect(fifo.status).toBe(0);
      }
      const result = invokeHelper();
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(HELPER_ERROR);
    }
  );
});
