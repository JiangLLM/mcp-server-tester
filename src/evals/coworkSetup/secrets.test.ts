import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCoworkSecretsFile } from './secrets.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});

const ERROR_MESSAGE = 'Unable to load Cowork runtime credentials.';
const MAX_BYTES = 64 * 1024;
let directory: string;
let filePath: string;

async function writeSynthetic(content: string | Uint8Array): Promise<void> {
  await fs.writeFile(filePath, content, { mode: 0o600 });
}

async function expectRejected(path: string = filePath): Promise<void> {
  let failure: unknown;
  try {
    await loadCoworkSecretsFile(path);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Expected rejection');
  expect(failure.message).toBe(ERROR_MESSAGE);
  expect(failure.cause).toBeUndefined();
  expect(Object.keys(failure)).toEqual([]);
  expect(failure.stack).not.toContain(path);
  expect(failure.stack).not.toContain('synthetic-secret');
}

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'cowork-synthetic-secrets-'));
  filePath = join(directory, 'synthetic.env');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('loadCoworkSecretsFile', () => {
  it('loads a JSON string map, including escapes and prototype-like keys', async () => {
    await writeSynthetic(
      '{"TOKEN":"synthetic-secret","EMPTY":"","LINES":"a\\nb","__proto__":"safe","constructor":"literal"}'
    );
    const result = await loadCoworkSecretsFile(filePath);
    expect(result).toEqual(
      JSON.parse(
        '{"TOKEN":"synthetic-secret","EMPTY":"","LINES":"a\\nb","__proto__":"safe","constructor":"literal"}'
      )
    );
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it('loads dotenv exports, comments, empty values, quotes, whitespace and CRLF', async () => {
    await writeSynthetic(
      [
        ' # synthetic comment',
        'export TOKEN = synthetic-secret # ignored',
        ' SINGLE=\' literal # $TOKEN "quoted" \' # comment',
        'DOUBLE="literal # ${TOKEN} and \'quote\'"',
        'EMPTY=',
        'QUOTED_EMPTY=""',
        'INLINE=literal#comment',
        'SPACES=two words  ',
        '',
      ].join('\r\n')
    );
    expect(await loadCoworkSecretsFile(filePath)).toEqual({
      TOKEN: 'synthetic-secret',
      SINGLE: ' literal # $TOKEN "quoted" ',
      DOUBLE: "literal # ${TOKEN} and 'quote'",
      EMPTY: '',
      QUOTED_EMPTY: '',
      INLINE: 'literal',
      SPACES: 'two words',
    });
  });

  it('never reads or changes process.env and keeps expansions and escapes literal', async () => {
    await writeSynthetic(
      'COWORK_SYNTHETIC_ONLY=synthetic-secret\nREF=${COWORK_SYNTHETIC_ONLY}\nSHELL=$(echo synthetic)\nESCAPES="a\\nb\\t"'
    );
    const descriptor = Object.getOwnPropertyDescriptor(process, 'env')!;
    let reads = 0;
    let writes = 0;
    Object.defineProperty(process, 'env', {
      configurable: true,
      get: function () {
        reads++;
        throw new Error('Environment must not be read');
      },
      set: function () {
        writes++;
        throw new Error('Environment must not be replaced');
      },
    });
    let result: Record<string, string>;
    try {
      result = await loadCoworkSecretsFile(filePath);
    } finally {
      Object.defineProperty(process, 'env', descriptor);
    }
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(result).toEqual({
      COWORK_SYNTHETIC_ONLY: 'synthetic-secret',
      REF: '${COWORK_SYNTHETIC_ONLY}',
      SHELL: '$(echo synthetic)',
      ESCAPES: 'a\\nb\\t',
    });
  });

  it.each(['', ' # only a comment\n', '{}', ' \n { "A" : "b" }\t\n'])(
    'accepts empty maps and valid JSON whitespace: %j',
    async (source) => {
      await writeSynthetic(source);
      expect(await loadCoworkSecretsFile(filePath)).toEqual(
        source.includes('"A"') ? { A: 'b' } : {}
      );
    }
  );

  it.each([
    '{"A":"synthetic-secret","A":"duplicate"}',
    '{"A":"one","\\u0041":"duplicate"}',
    '{"A":1}',
    '{"A":null}',
    '{"A":true}',
    '{"A":[]}',
    '{"A":{}}',
    '{"A":"one",}',
    '{"A":"unterminated}',
    '{"A":"bad\\xescape"}',
    '{"A":"literal\nnewline"}',
    '{"A":"one"} trailing',
    '{"A":"one"} {"B":"two"}',
    '{"A":"one" // comment\n}',
    '{"1KEY":"value"}',
    '{"BAD-KEY":"value"}',
    '{"A\\n":"value"}',
    '{"A":"\\u0000"}',
    '[]',
    'null',
    '"text"',
    'A=synthetic-secret\nexport A=duplicate',
    'export A',
    'A',
    '=missing-key',
    '1KEY=value',
    'BAD-KEY=value',
    'A B=value',
    'export export A=value',
    'A="unterminated',
    "A='unterminated",
    'A="value" trailing',
    'A="one""two"',
    'A=unquoted"quote"',
    'A="escaped\\"quote"',
    'A=continuation\\\nB=value',
    'A="multi\nline"',
    'A=bare\rcarriage-return',
    'A=nul\0value',
    'A=one\n{"B":"two"}',
  ])('rejects malformed or ambiguous content: %j', async (source) => {
    await writeSynthetic(source);
    await expectRejected();
  });

  it('rejects invalid UTF-8 instead of replacing credential bytes', async () => {
    await writeSynthetic(Buffer.from([0x41, 0x3d, 0xff]));
    await expectRejected();
  });

  it('uses no-follow and nonblocking open flags and closes on parse failure', async () => {
    await writeSynthetic('malformed synthetic-secret');
    const file = await fs.open(filePath, constants.O_RDONLY);
    const close = vi.spyOn(file, 'close');
    const open = vi.mocked(fs.open).mockResolvedValueOnce(file);
    await expectRejected();
    expect(open).toHaveBeenCalledWith(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects missing files and directories with the same sanitized error', async () => {
    await expectRejected();
    await expectRejected(directory);
  });

  it('rejects a symlink even when its target has private permissions', async () => {
    await writeSynthetic('A=synthetic-secret');
    const link = join(directory, 'link.env');
    await fs.symlink(filePath, link);
    await expectRejected(link);
  });

  it('rejects a FIFO without waiting for a writer', async () => {
    execFileSync('mkfifo', ['-m', '600', filePath]);
    await expectRejected();
  }, 2000);

  it.each([0o640, 0o620, 0o610, 0o604, 0o602, 0o601, 0o644, 0o777])(
    'rejects group or other permissions: %i',
    async (mode) => {
      await writeSynthetic('A=synthetic-secret');
      await fs.chmod(filePath, mode);
      await expectRejected();
    }
  );

  it('accepts owner-read-only permissions', async () => {
    await writeSynthetic('A=synthetic-secret');
    await fs.chmod(filePath, 0o400);
    expect(await loadCoworkSecretsFile(filePath)).toEqual({
      A: 'synthetic-secret',
    });
  });

  it('rejects a file not owned by the current user', async () => {
    await writeSynthetic('A=synthetic-secret');
    const stat = await fs.stat(filePath);
    vi.spyOn(process, 'getuid').mockReturnValue(stat.uid + 1);
    await expectRejected();
  });

  it('accepts exactly 64 KiB and rejects one byte over', async () => {
    await writeSynthetic(`A=${'x'.repeat(MAX_BYTES - 2)}`);
    expect((await loadCoworkSecretsFile(filePath)).A).toHaveLength(
      MAX_BYTES - 2
    );
    await writeSynthetic(`A=${'x'.repeat(MAX_BYTES - 1)}`);
    await expectRejected();
  });

  it('limits bytes rather than Unicode characters', async () => {
    await writeSynthetic(`A=${'é'.repeat(MAX_BYTES / 2)}`);
    await expectRejected();
  });

  it('handles partial reads and closes the descriptor on success', async () => {
    await writeSynthetic('A=synthetic-secret');
    const file = await fs.open(filePath, constants.O_RDONLY);
    const close = vi.spyOn(file, 'close');
    const originalRead = file.read.bind(file);
    vi.spyOn(file, 'read').mockImplementationOnce(async (buffer) => {
      // Preserve the caller's buffer while limiting the first read size.
      if (!(buffer instanceof Buffer)) throw new Error('Expected buffer');
      return originalRead(buffer, 0, 2, 0);
    });
    vi.mocked(fs.open).mockResolvedValueOnce(file);
    expect(await loadCoworkSecretsFile(filePath)).toEqual({
      A: 'synthetic-secret',
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('rechecks privacy after reading and closes on validation failure', async () => {
    await writeSynthetic('A=synthetic-secret');
    const file = await fs.open(filePath, constants.O_RDONLY);
    const originalStat = file.stat.bind(file);
    const close = vi.spyOn(file, 'close');
    vi.spyOn(file, 'stat').mockImplementationOnce(async () => {
      const stat = await originalStat();
      await fs.chmod(filePath, 0o644);
      return stat;
    });
    vi.mocked(fs.open).mockResolvedValueOnce(file);
    await expectRejected();
    expect(close).toHaveBeenCalledOnce();
  });

  it('bounds the read even if the file grows after the first fstat', async () => {
    await writeSynthetic('A=synthetic-secret');
    const file = await fs.open(filePath, constants.O_RDONLY);
    const original = await file.stat();
    const read = vi.spyOn(file, 'read');
    const close = vi.spyOn(file, 'close');
    vi.spyOn(file, 'stat').mockImplementationOnce(async () => {
      await fs.appendFile(filePath, 'x'.repeat(MAX_BYTES * 2));
      return original;
    });
    vi.mocked(fs.open).mockResolvedValueOnce(file);
    await expectRejected();
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.slice(1)).toEqual([0, MAX_BYTES + 1, 0]);
    expect(close).toHaveBeenCalledOnce();
  });
});
