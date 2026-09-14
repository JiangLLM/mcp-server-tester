import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PROVIDERS = new Set([
  'anthropic',
  'gateway',
  'bedrock',
  'bedrock-mantle',
  'vertex',
  'foundry',
]);
const CONTAINERS = ['values', 'settings', 'configuration', 'config'] as const;
const FIELDS = [
  'inferenceProvider',
  'managedMcpServers',
  'inferenceModels',
  'modelIds',
  'inferenceGatewayBaseUrl',
  'inferenceAnthropicApiKey',
  'inferenceGatewayApiKey',
  'inferenceCredentialHelper',
  'bootstrapUrl',
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadPrivateConfig(file: string): Promise<unknown> {
  const fd = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const stat = await fd.stat();
    if (
      !stat.isFile() ||
      stat.size > LIMIT ||
      (stat.mode & 0o022) !== 0 ||
      (process.getuid !== undefined && stat.uid !== process.getuid())
    )
      throw new Error();
    const buffer = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await fd.read(buffer, length, buffer.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > LIMIT) throw new Error();
    const after = await fd.stat();
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      length !== after.size
    )
      throw new Error();
    return JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown;
  } finally {
    await fd.close();
  }
}

/** Read only non-secret state; never return raw config, credentials, URLs, or helper commands. */
export async function inspectMacCoworkProfile(directory: string): Promise<{
  applied: boolean;
  schema: string;
  provider: string | null;
  managedServerCount: number | null;
  fieldPresence: string[];
  desktopVerified: false;
}> {
  try {
    const metadata = await loadPrivateConfig(
      path.join(directory, '_meta.json')
    );
    if (!record(metadata)) throw new Error();
    if (metadata.appliedId === null || metadata.appliedId === undefined) {
      return {
        applied: false,
        schema: 'none',
        provider: null,
        managedServerCount: null,
        fieldPresence: [],
        desktopVerified: false,
      };
    }
    if (
      typeof metadata.appliedId !== 'string' ||
      !UUID.test(metadata.appliedId)
    )
      throw new Error();
    const saved = await loadPrivateConfig(
      path.join(directory, `${metadata.appliedId}.json`)
    );
    if (!record(saved)) throw new Error();
    const candidates: Array<{
      schema: string;
      settings: Record<string, unknown>;
    }> = [
      { schema: 'direct', settings: saved },
      ...CONTAINERS.flatMap((key) =>
        record(saved[key]) ? [{ schema: key, settings: saved[key] }] : []
      ),
    ];
    const found = candidates.filter(({ settings }) =>
      FIELDS.some((key) => Object.hasOwn(settings, key))
    );
    if (found.length !== 1) {
      return {
        applied: true,
        schema: 'unknown',
        provider: null,
        managedServerCount: null,
        fieldPresence: [],
        desktopVerified: false,
      };
    }
    const { settings, schema } = found[0]!;
    return {
      applied: true,
      schema,
      provider:
        typeof settings.inferenceProvider === 'string' &&
        PROVIDERS.has(settings.inferenceProvider)
          ? settings.inferenceProvider
          : null,
      managedServerCount: Array.isArray(settings.managedMcpServers)
        ? settings.managedMcpServers.length
        : null,
      fieldPresence: FIELDS.filter((key) => Object.hasOwn(settings, key)),
      desktopVerified: false,
    };
  } catch {
    throw new Error('Unable to inspect non-secret Cowork configuration state.');
  }
}
