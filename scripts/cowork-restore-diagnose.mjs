// Read-only recovery diagnostics. Never prints configuration values, tokens, or hashes.
import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const profile = path.resolve(process.argv[2] ?? '');
const root = path.resolve('.cowork-runtime');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sessionFile = path.join(
  root,
  `manual-${hash(profile).slice(0, 24)}.json`
);
const allowed = (name) =>
  [
    '.mst-setup-marker',
    'inference-helper.sh',
    'managed-mcp.json',
    'status.json',
    'credentials/inference.json',
  ].includes(name) ||
  /^mcp-[A-Za-z][A-Za-z0-9_-]{0,63}-headers\.sh$/.test(name) ||
  /^credentials\/[A-Za-z][A-Za-z0-9_-]{0,63}\.json$/.test(name);
async function bytes(file) {
  const fd = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await fd.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid() ||
      before.size > 1024 * 1024 ||
      before.mode & 0o022
    )
      throw new Error();
    const buffer = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const next = await fd.read(buffer, used, buffer.length - used, null);
      if (!next.bytesRead) break;
      used += next.bytesRead;
    }
    const after = await fd.stat();
    if (
      used !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error();
    return buffer.subarray(0, used);
  } finally {
    await fd.close();
  }
}
function sameJson(a, b) {
  return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
}
try {
  const session = JSON.parse(await bytes(sessionFile));
  const journalFile = path.join(profile, '.mst-setup-lock/journal.json');
  const journal = JSON.parse(await bytes(journalFile));
  if (
    session.profile !== profile ||
    path.dirname(session.runDirectory) !== root ||
    !path.basename(session.runDirectory).startsWith('manual-run-') ||
    journal.directory !== path.join(session.runDirectory, 'staging') ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      journal.id
    )
  )
    throw new Error();
  const original = Buffer.from(journal.originalMeta, 'base64');
  const originalJson = JSON.parse(original);
  const expectedMeta = Buffer.from(
    JSON.stringify(
      {
        ...originalJson,
        appliedId: journal.id,
        entries: [
          ...originalJson.entries,
          { id: journal.id, name: 'MST test' },
        ],
      },
      null,
      2
    ) + '\n'
  );
  const currentMeta = await bytes(path.join(profile, '_meta.json'));
  const profileFile = path.join(profile, `${journal.id}.json`);
  const currentProfile = await bytes(profileFile);
  const settings = JSON.parse(
    await bytes(path.join(journal.directory, 'managed-mcp.json'))
  );
  const expectedProfile = {
    ...settings,
    inferenceProvider: 'anthropic',
    inferenceCredentialKind: 'helper-script',
    inferenceCredentialHelper: path.join(
      journal.directory,
      'inference-helper.sh'
    ),
  };
  const current = JSON.parse(currentProfile);
  const names = Object.keys(journal.files ?? {});
  if (names.some((name) => !allowed(name))) throw new Error();
  let mismatchedStagingFiles = 0;
  let nonPrivateStagingFiles = 0;
  for (const name of names) {
    const file = path.join(journal.directory, name);
    if (hash(await bytes(file)) !== journal.files[name])
      mismatchedStagingFiles++;
    if ((await lstat(file)).mode & 0o077) nonPrivateStagingFiles++;
  }
  const knownKeys = [
    'managedMcpServers',
    'allowedMcpServers',
    'allowManagedMcpServersOnly',
    'inferenceProvider',
    'inferenceCredentialKind',
    'inferenceCredentialHelper',
  ];
  console.log(
    JSON.stringify(
      {
        phase: ['preparing', 'ready', 'applied', 'restoring'].includes(
          journal.phase
        )
          ? journal.phase
          : 'unknown',
        sessionHasOriginalMetaHash:
          typeof session.originalMetaHash === 'string',
        sessionMetadataHashMatchesJournal:
          hash(JSON.stringify(originalJson)) === session.originalMetaHash,
        originalMetadataIntegrity: hash(original) === journal.originalHash,
        reconstructedInstalledMetadataIntegrity:
          hash(expectedMeta) === journal.installedHash,
        installedMetadataBytesMatch: currentMeta.equals(expectedMeta),
        installedMetadataJsonMatch: sameJson(currentMeta, expectedMeta),
        profileBytesMatch: hash(currentProfile) === journal.profileHash,
        profileJsonMatchesReconstruction:
          JSON.stringify(current) === JSON.stringify(expectedProfile),
        profilePrivatePermissions:
          ((await lstat(profileFile)).mode & 0o077) === 0,
        changedKnownFields: knownKeys.filter(
          (key) =>
            JSON.stringify(current[key]) !==
            JSON.stringify(expectedProfile[key])
        ),
        addedUnknownFieldCount: Object.keys(current).filter(
          (key) => !knownKeys.includes(key)
        ).length,
        mismatchedStagingFiles,
        nonPrivateStagingFiles,
        readOnly: true,
      },
      null,
      2
    )
  );
} catch {
  console.error(
    'Recovery inspection failed; no raw metadata, credentials, or errors were printed.'
  );
  process.exitCode = 1;
}
