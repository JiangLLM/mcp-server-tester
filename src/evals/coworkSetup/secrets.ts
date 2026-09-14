import { constants, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';

const MAX_BYTES = 64 * 1024;
const ERROR_MESSAGE = 'Unable to load Cowork runtime credentials.';
const ENV_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function invalidSecrets(): never {
  throw new Error(ERROR_MESSAGE);
}

function addEntry(
  entries: Map<string, string>,
  key: string,
  value: string
): void {
  if (
    !ENV_IDENTIFIER.test(key) ||
    key.includes('\n') ||
    entries.has(key) ||
    value.includes('\0')
  ) {
    invalidSecrets();
  }
  entries.set(key, value);
}

/** Parse only a flat JSON string map, retaining keys until duplicates are checked. */
function parseJson(source: string): Record<string, string> {
  let offset = 0;
  const entries = new Map<string, string>();
  // JSON.parse validates control characters inside each matched string token.
  const stringToken = /"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;

  function skipWhitespace(): void {
    while (offset < source.length && /[ \t\r\n]/.test(source[offset]!)) {
      offset++;
    }
  }

  function consume(character: string): void {
    skipWhitespace();
    if (source[offset] !== character) invalidSecrets();
    offset++;
  }

  function readString(): string {
    skipWhitespace();
    stringToken.lastIndex = offset;
    const match = stringToken.exec(source);
    if (!match) invalidSecrets();
    offset = stringToken.lastIndex;
    const value: unknown = JSON.parse(match[0]);
    if (typeof value !== 'string') invalidSecrets();
    return value;
  }

  consume('{');
  skipWhitespace();
  if (source[offset] !== '}') {
    while (offset < source.length) {
      const key = readString();
      consume(':');
      addEntry(entries, key, readString());
      skipWhitespace();
      if (source[offset] === '}') break;
      consume(',');
    }
  }
  consume('}');
  skipWhitespace();
  if (offset !== source.length) invalidSecrets();
  return Object.fromEntries(entries);
}

/**
 * Deliberately narrow dotenv grammar: one assignment per line, literal values,
 * no escape decoding, interpolation, continuations, or multiline quotes. A #
 * outside quotes starts a comment. Embedded quotes must use the other quote
 * delimiter; escaped closing delimiters are rejected as ambiguous.
 */
function parseDotenv(source: string): Record<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\r$/, '').replace(/^[ \t]+/, '');
    if (/^[ \t]*(?:#.*)?$/.test(line)) continue;
    if (/[\r\0]/.test(line)) invalidSecrets();
    const assignment =
      /^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/.exec(line);
    if (!assignment) invalidSecrets();
    const key = assignment[1]!;
    const rawValue = assignment[2]!;
    const quote = rawValue[0];
    let value: string;
    if (quote === "'" || quote === '"') {
      const end = rawValue.indexOf(quote, 1);
      if (
        end < 0 ||
        rawValue[end - 1] === '\\' ||
        !/^[ \t]*(?:#.*)?$/.test(rawValue.slice(end + 1))
      ) {
        invalidSecrets();
      }
      value = rawValue.slice(1, end);
    } else {
      value = rawValue.split('#', 1)[0]!.replace(/[ \t]+$/, '');
      if (/["']/.test(value) || value.endsWith('\\')) invalidSecrets();
    }
    addEntry(entries, key, value);
  }
  return Object.fromEntries(entries);
}

function validateFile(stat: Stats, uid: number): void {
  if (
    !stat.isFile() ||
    stat.uid !== uid ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > MAX_BYTES
  ) {
    invalidSecrets();
  }
}

/**
 * Load a caller-selected, private UTF-8 JSON map or dotenv file. Never consults
 * or modifies process.env. Every failure has the same non-sensitive error.
 * O_NOFOLLOW protects the final path component; parent directories must be trusted.
 */
export async function loadCoworkSecretsFile(
  filePath: string
): Promise<Record<string, string>> {
  try {
    if (
      typeof filePath !== 'string' ||
      typeof process.getuid !== 'function' ||
      typeof constants.O_NOFOLLOW !== 'number' ||
      typeof constants.O_NONBLOCK !== 'number'
    ) {
      invalidSecrets();
    }
    const uid = process.getuid();
    const file = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const before = await file.stat();
      validateFile(before, uid);
      // Never use readFile: the inode can grow after fstat. Read only one byte
      // beyond the limit, to distinguish an exact-size file from overflow.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          length,
          buffer.length - length,
          length
        );
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) invalidSecrets();
      const after = await file.stat();
      validateFile(after, uid);
      if (
        after.size !== length ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      ) {
        invalidSecrets();
      }
      const source = new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, length)
      );
      if (source.includes('\0')) invalidSecrets();
      return source.trimStart().startsWith('{')
        ? parseJson(source)
        : parseDotenv(source);
    } finally {
      await file.close();
    }
  } catch {
    // Do not attach the original error, which may contain a path or secret.
    throw new Error(ERROR_MESSAGE);
  }
}
