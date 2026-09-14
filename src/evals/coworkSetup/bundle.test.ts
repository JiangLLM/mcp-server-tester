import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpMCPConfig } from '../../config/mcpConfig.js';
import type { EvalManifest } from '../evalManifest.js';
import { prepareCoworkMcpBundle } from './bundle.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const BUNDLE_ERROR = 'Unable to prepare Cowork MCP bundle.';
const HELPER_ERROR = 'Unable to read Cowork MCP runtime headers.\n';
const TOKEN = 'synthetic-only-token';
let root: string;
let directory: string;

type Options = Parameters<typeof prepareCoworkMcpBundle>[0];

function http(overrides: Partial<HttpMCPConfig> = {}): HttpMCPConfig {
  return {
    transport: 'http',
    label: 'Search_1',
    serverUrl: 'https://search.example.test/mcp',
    auth: { accessTokenEnv: 'SYNTHETIC_COWORK_TOKEN' },
    ...overrides,
  };
}

function manifest(overrides: Partial<EvalManifest> = {}): EvalManifest {
  return { name: 'synthetic', datasets: [], servers: [http()], ...overrides };
}

function options(overrides: Partial<Options> = {}): Options {
  return {
    manifest: manifest(),
    directory,
    runtimeDirectory: directory,
    env: { SYNTHETIC_COWORK_TOKEN: TOKEN },
    ...overrides,
  };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
}

async function expectPrivate(path: string, mode: number): Promise<void> {
  const stat = await fs.stat(path);
  expect(stat.mode & 0o777).toBe(mode);
  expect(stat.uid).toBe(process.getuid!());
}

function invokeHelper(): ReturnType<typeof spawnSync> {
  return spawnSync(join(directory, 'mcp-Search_1-headers.sh'), [], {
    encoding: 'utf8',
    env: {},
    timeout: 5000,
    maxBuffer: 128 * 1024,
  });
}

function expectHelperFailure(): void {
  const result = invokeHelper();
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe(HELPER_ERROR);
}

async function expectRejected(input: Options): Promise<void> {
  let failure: unknown;
  try {
    await prepareCoworkMcpBundle(input);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Expected rejection');
  expect(failure.message).toBe(BUNDLE_ERROR);
  expect(failure.cause).toBeUndefined();
  expect(failure.stack).not.toContain(TOKEN);
  expect(failure.stack).not.toContain(directory);
}

beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'cowork_bundle-test-'))
  );
  directory = join(root, 'bundle_safe-1');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('prepareCoworkMcpBundle', () => {
  it.each([
    [undefined, undefined, false],
    [false, undefined, false],
    [true, undefined, true],
    [true, false, false],
    [false, true, true],
  ] as const)(
    'applies base=%s arm=%s approval policy only to the selected server',
    async (base, override, approved) => {
      const input = manifest({
        coworkSetup:
          base === undefined ? undefined : { approveWriteTools: base },
        arms: [
          {
            name: 'selected',
            servers: [
              http({
                label: 'selected',
                serverUrl: 'https://selected.example.test/mcp',
              }),
            ],
            coworkSetup:
              override === undefined
                ? undefined
                : { approveWriteTools: override },
          },
        ],
      });
      const result = await prepareCoworkMcpBundle(
        options({ manifest: input, arm: 'selected' })
      );
      expect(await readJson(result.settingsPath)).toEqual({
        managedMcpServers: [
          {
            name: 'selected',
            transport: 'http',
            url: 'https://selected.example.test/mcp',
            headersHelper: `${directory}/mcp-selected-headers.sh`,
            ...(approved ? { toolPolicy: { '*': 'allow' } } : {}),
          },
        ],
        allowedMcpServers: [{ serverName: 'selected' }],
        allowManagedMcpServersOnly: true,
      });
      expect(await fs.readdir(directory)).not.toContain(
        'mcp-Search_1-headers.sh'
      );
    }
  );
  it('rejects invalid approval settings before accessing credentials or creating staging', async () => {
    await expectRejected(
      options({
        manifest: manifest({
          coworkSetup: { approveWriteTools: 'true' } as unknown as NonNullable<
            EvalManifest['coworkSetup']
          >,
        }),
        secretsFile: '/nonexistent/private-secret',
      })
    );
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('prepares two private servers, secret-free settings/status/helpers, without applying', async () => {
    const result = await prepareCoworkMcpBundle(
      options({
        manifest: manifest({
          servers: [
            http({ headers: { 'X-Synthetic': 'synthetic-header-value' } }),
            http({
              label: 'Public-2',
              serverUrl: 'https://public.example.test/mcp',
              auth: undefined,
            }),
          ],
        }),
      })
    );
    expect(result).toEqual({
      directory,
      settingsPath: join(directory, 'managed-mcp.json'),
      serverCount: 2,
    });
    expect(await readJson(result.settingsPath)).toEqual({
      managedMcpServers: [
        {
          name: 'Search_1',
          transport: 'http',
          url: 'https://search.example.test/mcp',
          headersHelper: join(directory, 'mcp-Search_1-headers.sh'),
        },
        {
          name: 'Public-2',
          transport: 'http',
          url: 'https://public.example.test/mcp',
        },
      ],
      allowedMcpServers: [
        { serverName: 'Search_1' },
        { serverName: 'Public-2' },
      ],
      allowManagedMcpServersOnly: true,
    });
    expect(await readJson(join(directory, 'status.json'))).toEqual({
      status: 'prepared-not-applied',
      desktopVerified: false,
      serverCount: 2,
    });
    expect(await fs.readdir(directory)).toEqual([
      'credentials',
      'managed-mcp.json',
      'mcp-Search_1-headers.sh',
      'status.json',
    ]);
    expect(await fs.readdir(join(directory, 'credentials'))).toEqual([
      'Search_1.json',
    ]);
    const expectedHeaders = {
      'X-Synthetic': 'synthetic-header-value',
      Authorization: `Bearer ${TOKEN}`,
    };
    expect(
      await readJson(join(directory, 'credentials', 'Search_1.json'))
    ).toEqual(expectedHeaders);
    for (const file of [
      'managed-mcp.json',
      'status.json',
      'mcp-Search_1-headers.sh',
    ]) {
      const content = await fs.readFile(join(directory, file), 'utf8');
      expect(content).not.toContain(TOKEN);
      expect(content).not.toContain('synthetic-header-value');
      expect(content).not.toContain('SYNTHETIC_COWORK_TOKEN');
    }
    await expectPrivate(directory, 0o700);
    await expectPrivate(join(directory, 'credentials'), 0o700);
    for (const file of [
      'managed-mcp.json',
      'status.json',
      'credentials/Search_1.json',
    ]) {
      await expectPrivate(join(directory, file), 0o600);
    }
    await expectPrivate(join(directory, 'mcp-Search_1-headers.sh'), 0o700);
    const invocation = invokeHelper();
    expect(invocation.error).toBeUndefined();
    expect(invocation.status).toBe(0);
    expect(invocation.stderr).toBe('');
    expect(JSON.parse(String(invocation.stdout))).toEqual(expectedHeaders);
  });

  it('uses runtime paths, not staging paths, and requires the same private destination layout', async () => {
    const runtimeDirectory = join(root, 'runtime_safe-2');
    await prepareCoworkMcpBundle(options({ runtimeDirectory }));
    expectHelperFailure();
    await expect(fs.stat(runtimeDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await fs.cp(directory, runtimeDirectory, { recursive: true });
    expect(invokeHelper().status).toBe(0);
    await fs.rm(join(runtimeDirectory, 'credentials', 'Search_1.json'));
    // The staging credential still exists, but must never be a fallback.
    expectHelperFailure();
  });

  it('isolates credentials and helpers for two authenticated servers', async () => {
    await prepareCoworkMcpBundle(
      options({
        manifest: manifest({
          servers: [
            http(),
            http({
              label: 'Other',
              serverUrl: 'https://other.example.test/',
              auth: undefined,
              headers: { 'X-Key': 'second-synthetic-secret' },
            }),
          ],
        }),
      })
    );
    const invocation = spawnSync(join(directory, 'mcp-Other-headers.sh'), [], {
      encoding: 'utf8',
      env: {},
      timeout: 5000,
    });
    expect(invocation.status).toBe(0);
    expect(invocation.stderr).toBe('');
    expect(JSON.parse(invocation.stdout)).toEqual({
      'X-Key': 'second-synthetic-secret',
    });
    expect(String(invokeHelper().stdout)).not.toContain(
      'second-synthetic-secret'
    );
  });

  it.each([
    { servers: [] },
    { servers: [http()], arms: [{ name: 'empty', servers: [] }] },
    { arms: [{ name: 'empty', servers: [] }] },
  ])('accepts explicitly empty server lists: %j', async (configuration) => {
    const input = manifest(configuration);
    if (!Object.hasOwn(configuration, 'servers')) delete input.servers;
    const result = await prepareCoworkMcpBundle(
      options({
        manifest: input,
        arm: configuration.arms ? 'empty' : undefined,
        env: {},
      })
    );
    expect(result.serverCount).toBe(0);
    expect(await fs.readdir(join(directory, 'credentials'))).toEqual([]);
    expect(await readJson(result.settingsPath)).toMatchObject({
      managedMcpServers: [],
      allowedMcpServers: [],
    });
  });

  it.each(['base', 'inherit', 'replace'])(
    'resolves %s canonical servers',
    async (selection) => {
      const input = manifest({
        arms: [
          { name: 'inherit' },
          {
            name: 'replace',
            servers: [http({ label: 'Replacement', auth: undefined })],
          },
        ],
      });
      const result = await prepareCoworkMcpBundle(
        options({
          manifest: input,
          arm: selection === 'base' ? undefined : selection,
        })
      );
      expect(await readJson(result.settingsPath)).toMatchObject({
        managedMcpServers: [
          { name: selection === 'replace' ? 'Replacement' : 'Search_1' },
        ],
      });
    }
  );

  it.each([
    { manifest: manifest({ servers: undefined }) },
    {
      manifest: manifest({ servers: undefined, arms: [{ name: 'inherit' }] }),
      arm: 'inherit',
    },
    { arm: 'no-match' },
    {
      manifest: manifest({
        arms: [{ name: 'same' }, { name: 'same', servers: [] }],
      }),
    },
    {
      manifest: manifest({ arms: [{ name: 'same' }, { name: 'same' }] }),
      arm: 'same',
    },
    { manifest: manifest({ servers: [http(), http()] }) },
    { env: {} },
    { env: { SYNTHETIC_COWORK_TOKEN: 'synthetic\r\nInjected: yes' } },
    {
      manifest: manifest({
        servers: [http({ headers: { 'X-Bad': 'synthetic\nsecret' } })],
      }),
    },
    {
      manifest: manifest({
        servers: [http({ headers: { 'X-Large': 'x'.repeat(65536) } })],
      }),
    },
  ])(
    'rejects invalid selection or credentials before any directory is created (#%#)',
    async (overrides) => {
      await expectRejected(options(overrides));
      expect(await fs.readdir(root)).toEqual([]);
    }
  );

  it.each([
    'relative/path',
    '/safe/../unsafe',
    '/safe//unsafe',
    '/safe;echo-secret',
    '/safe\nsecret',
  ])(
    'rejects unsafe runtime path before writes: %j',
    async (runtimeDirectory) => {
      await expectRejected(options({ runtimeDirectory }));
      expect(await fs.readdir(root)).toEqual([]);
    }
  );

  it('does not fall back to ambient process.env', async () => {
    vi.stubEnv('SYNTHETIC_COWORK_TOKEN', TOKEN);
    await expectRejected(options({ env: undefined }));
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('loads only an explicitly selected private secrets file, with explicit-file precedence', async () => {
    const secretsFile = join(root, 'synthetic.env');
    await fs.writeFile(secretsFile, `SYNTHETIC_COWORK_TOKEN=${TOKEN}\n`, {
      mode: 0o600,
    });
    await prepareCoworkMcpBundle(
      options({
        secretsFile,
        env: { SYNTHETIC_COWORK_TOKEN: 'overridden-synthetic-value' },
      })
    );
    expect(
      await readJson(join(directory, 'credentials', 'Search_1.json'))
    ).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it('rejects a missing or public secrets file without creating output', async () => {
    const secretsFile = join(root, 'synthetic-secret-file');
    await expectRejected(options({ secretsFile }));
    await fs.writeFile(
      secretsFile,
      JSON.stringify({ SYNTHETIC_COWORK_TOKEN: TOKEN }),
      { mode: 0o644 }
    );
    await fs.chmod(secretsFile, 0o644);
    await expectRejected(options({ secretsFile }));
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['directory', 'file', 'symlink', 'dangling-symlink'])(
    'refuses an existing %s without modifying it',
    async (kind) => {
      const sentinel = join(root, 'sentinel');
      await fs.mkdir(sentinel);
      await fs.writeFile(join(sentinel, 'untouched'), 'synthetic-sentinel');
      if (kind === 'directory') await fs.mkdir(directory);
      else if (kind === 'file')
        await fs.writeFile(directory, 'synthetic-existing');
      else
        await fs.symlink(
          kind === 'symlink' ? sentinel : join(root, 'absent'),
          directory
        );
      const before = await fs.lstat(directory);
      await expectRejected(options());
      expect((await fs.lstat(directory)).ino).toBe(before.ino);
      expect(await fs.readFile(join(sentinel, 'untouched'), 'utf8')).toBe(
        'synthetic-sentinel'
      );
      if (kind === 'file')
        expect(await fs.readFile(directory, 'utf8')).toBe('synthetic-existing');
      if (kind === 'directory') expect(await fs.readdir(directory)).toEqual([]);
    }
  );

  it('never overwrites a generated bundle', async () => {
    await prepareCoworkMcpBundle(options());
    const before = await fs.readFile(
      join(directory, 'credentials', 'Search_1.json'),
      'utf8'
    );
    await expectRejected(
      options({ env: { SYNTHETIC_COWORK_TOKEN: 'different-synthetic-secret' } })
    );
    expect(
      await fs.readFile(join(directory, 'credentials', 'Search_1.json'), 'utf8')
    ).toBe(before);
  });

  it('does not recursively create missing parents', async () => {
    await expectRejected(options({ directory: join(root, 'absent', 'child') }));
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('removes staged secrets when writing a helper fails', async () => {
    const original = vi.mocked(fs.writeFile).getMockImplementation()!;
    vi.mocked(fs.writeFile)
      .mockImplementationOnce(original)
      .mockImplementationOnce(original)
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(new Error(`synthetic-write-failure: ${TOKEN}`));
    await expectRejected(options());
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('cleans only its new directory on a post-creation error and sanitizes the failure', async () => {
    const untouched = join(root, 'untouched');
    await fs.writeFile(untouched, 'synthetic-sentinel');
    vi.mocked(fs.writeFile).mockRejectedValueOnce(
      new Error(`${directory}: ${TOKEN}`)
    );
    await expectRejected(options());
    expect(await fs.readdir(root)).toEqual(['untouched']);
    expect(await fs.readFile(untouched, 'utf8')).toBe('synthetic-sentinel');
  });
});

describe('generated runtime helper', () => {
  it.each([
    'missing',
    'symlink',
    'directory',
    'public',
    'oversized',
    'invalid-json',
    'array',
    'missing-header',
    'extra-header',
    'duplicate-header',
    'header-injection',
    'control',
    'c1-control',
    'unicode',
    'non-string',
    'invalid-bearer',
    'invalid-field',
  ])(
    'fails closed with empty stdout and fixed stderr for %s credentials',
    async (kind) => {
      await prepareCoworkMcpBundle(options());
      const credential = join(directory, 'credentials', 'Search_1.json');
      if (kind === 'missing') await fs.rm(credential);
      else if (kind === 'symlink') {
        const target = join(root, 'synthetic-target');
        await fs.rename(credential, target);
        await fs.symlink(target, credential);
      } else if (kind === 'directory') {
        await fs.rm(credential);
        await fs.mkdir(credential, { mode: 0o700 });
      } else if (kind === 'public') await fs.chmod(credential, 0o644);
      else {
        const payloads: Record<string, string> = {
          oversized: JSON.stringify({
            Authorization: `Bearer ${'x'.repeat(65536)}`,
          }),
          'invalid-json': `not-json-${TOKEN}`,
          array: '[]',
          'missing-header': '{}',
          'extra-header': JSON.stringify({
            Authorization: `Bearer ${TOKEN}`,
            'X-Extra': TOKEN,
          }),
          'duplicate-header':
            '{"Authorization":"Bearer one","Authorization":"Bearer two"}',
          'header-injection': JSON.stringify({
            Authorization: `Bearer ${TOKEN}\r\nX-Injected: yes`,
          }),
          control: JSON.stringify({ Authorization: `Bearer ${TOKEN}\t` }),
          'c1-control': JSON.stringify({
            Authorization: `Bearer ${TOKEN}\u0085`,
          }),
          unicode: JSON.stringify({ Authorization: `Bearer ${TOKEN}\u2603` }),
          'non-string': '{"Authorization":42}',
          'invalid-bearer': '{"Authorization":"Basic synthetic"}',
          'invalid-field': JSON.stringify({
            'Authorization\r\nX-Injected': TOKEN,
          }),
        };
        await fs.writeFile(credential, payloads[kind]!);
      }
      expectHelperFailure();
    }
  );

  it('allows validated static header bytes and punctuation without embedding values into Python', async () => {
    const headers = {
      "X-!#$%&'*+.^_`|~": 'synthetic "quote" \\ literal $HOME café',
      Authorization: 'Basic synthetic-static',
    };
    await prepareCoworkMcpBundle(
      options({
        manifest: manifest({ servers: [http({ auth: undefined, headers })] }),
      })
    );
    const result = invokeHelper();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(String(result.stdout))).toEqual(headers);
  });

  it('accepts an exact 64 KiB private credential file but rejects one byte more', async () => {
    await prepareCoworkMcpBundle(options());
    const credential = join(directory, 'credentials', 'Search_1.json');
    const empty = JSON.stringify({ Authorization: 'Bearer ' });
    const content = JSON.stringify({
      Authorization: `Bearer ${'x'.repeat(65536 - empty.length)}`,
    });
    expect(Buffer.byteLength(content)).toBe(65536);
    await fs.writeFile(credential, content);
    const result = invokeHelper();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(String(result.stdout))).toEqual(JSON.parse(content));
    await fs.appendFile(credential, ' ');
    expectHelperFailure();
  });

  it('rereads credentials each invocation, never retaining a deleted secret', async () => {
    await prepareCoworkMcpBundle(options());
    expect(invokeHelper().status).toBe(0);
    const credential = join(directory, 'credentials', 'Search_1.json');
    await fs.writeFile(
      credential,
      JSON.stringify({ Authorization: 'Bearer rotated-synthetic' })
    );
    expect(JSON.parse(String(invokeHelper().stdout))).toEqual({
      Authorization: 'Bearer rotated-synthetic',
    });
    await fs.rm(credential);
    expectHelperFailure();
  });
});
