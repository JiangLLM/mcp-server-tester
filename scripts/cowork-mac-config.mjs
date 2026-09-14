// Configuration-only session. Never enters, submits, or evaluates a query.
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  open,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const [action, compiledRoot, controller, ...args] = process.argv.slice(2);
if (
  process.platform !== 'darwin' ||
  !compiledRoot ||
  !controller ||
  !['configure', 'restore'].includes(action) ||
  args.length !== (action === 'configure' ? 3 : 1)
) {
  console.error(
    'Use scripts/cowork-mac-config.sh configure <manifest> <private-env> <configLibrary>, or restore <configLibrary>.'
  );
  process.exit(2);
}
const { installMacCoworkSettings, restoreMacCoworkSettings } = await import(
  pathToFileURL(
    path.resolve(compiledRoot, 'evals/coworkSetup/macTransaction.js')
  ).href
);
const { loadEvalManifest } = await import(
  pathToFileURL(path.resolve(compiledRoot, 'evals/evalManifest.js')).href
);
const profile = path.resolve(action === 'configure' ? args[2] : args[0]);
const root = path.resolve('.cowork-runtime');
await mkdir(root, { recursive: true, mode: 0o700 });
const key = createHash('sha256').update(profile).digest('hex').slice(0, 24);
const sessionFile = path.join(root, `manual-${key}.json`);
const lock = path.join(profile, '.mst-setup-lock');
let phase = 'startup';

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function privateJson(file, metadataOnly = false) {
  const fd = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const s = await fd.stat();
    if (
      !s.isFile() ||
      s.uid !== process.getuid() ||
      s.mode & (metadataOnly ? 0o022 : 0o077) ||
      s.size > 1024 * 1024
    )
      throw new Error();
    const buffer = Buffer.alloc(s.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await fd.read(
        buffer,
        used,
        buffer.length - used,
        null
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await fd.stat();
    if (used !== s.size || after.size !== s.size || after.mtimeMs !== s.mtimeMs)
      throw new Error();
    return JSON.parse(buffer.subarray(0, used).toString('utf8'));
  } finally {
    await fd.close();
  }
}
async function app(command) {
  phase = `app-${command}`;
  const { stdout } = await exec(controller, [command], {
    timeout: 30000,
    maxBuffer: 16384,
  });
  const state = JSON.parse(stdout);
  if (
    command === 'state' &&
    (!(state.workspaceApplicationCount > 0) ||
      !state.claudeBundleReadable ||
      state.instances > 1 ||
      !Number.isInteger(state.instances) ||
      typeof state.running !== 'boolean')
  )
    throw new Error();
  return state;
}
async function ownsJournal(session) {
  if (!(await exists(lock))) return false;
  const journal = await privateJson(path.join(lock, 'journal.json'));
  if (
    session.profile !== profile ||
    journal.directory !== path.join(session.runDirectory, 'staging')
  )
    throw new Error();
  return true;
}
async function metadataHash() {
  return createHash('sha256')
    .update(
      JSON.stringify(await privateJson(path.join(profile, '_meta.json'), true))
    )
    .digest('hex');
}
async function restoreSession(session) {
  if (
    !session ||
    session.profile !== profile ||
    typeof session.wasRunning !== 'boolean' ||
    typeof session.runDirectory !== 'string' ||
    path.dirname(session.runDirectory) !== root ||
    !path.basename(session.runDirectory).startsWith('manual-run-')
  )
    throw new Error();
  // Verify ownership before any application action. Never restore another run's lock.
  phase = 'verify-session-ownership';
  const installed = await ownsJournal(session);
  const state = await app('state');
  if (installed) {
    if (state.running) await app('stop');
    phase = 'restore-files';
    await restoreMacCoworkSettings(profile);
    if (session.wasRunning) await app('start');
  } else {
    if (
      (await metadataHash()) !== session.originalMetaHash ||
      (await exists(path.join(session.runDirectory, 'staging')))
    )
      throw new Error();
    if (state.running !== session.wasRunning)
      await app(session.wasRunning ? 'start' : 'stop');
  }
  phase = 'verify-restoration';
  if (
    (await metadataHash()) !== session.originalMetaHash ||
    (await exists(path.join(session.runDirectory, 'staging')))
  )
    throw new Error();
  phase = 'remove-session-receipt';
  await unlink(sessionFile);
}

let session;
let saved = false;
try {
  if (
    profile !==
    path.resolve(
      homedir(),
      'Library/Application Support/Claude-3p/configLibrary'
    )
  ) {
    throw new Error();
  }
  if (action === 'restore') {
    phase = 'read-session-receipt';
    session = await privateJson(sessionFile);
    await restoreSession(session);
    console.log(
      'Original Claude configuration restored; private token staging removed. Query/session history was not deleted.'
    );
  } else {
    if (
      (await exists(sessionFile)) ||
      (await exists(lock)) ||
      (await exists(path.join(profile, '.mst-session-lock')))
    )
      throw new Error();
    phase = 'read-manifest';
    const manifest = loadEvalManifest(path.resolve(args[0]), {
      skipDatasetValidation: true,
    });
    if (manifest.coworkSetup?.approveWriteTools === true) {
      console.log(
        'Write-tool preapproval enabled for all tools on the configured MCP servers, including future tools. Built-in tool permissions are unchanged. Setup will not invoke tools.'
      );
    }
    const state = await app('state');
    const runDirectory = await mkdtemp(path.join(root, 'manual-run-'));
    session = {
      profile,
      wasRunning: state.running,
      runDirectory,
      originalMetaHash: await metadataHash(),
    };
    await writeFile(sessionFile, JSON.stringify(session) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    saved = true;
    if (state.running) await app('stop');
    console.log(
      'Applying the manifest server list to a separate managed Claude profile...'
    );
    phase = 'install-settings';
    const transaction = await installMacCoworkSettings({
      profileDirectory: profile,
      stagingDirectory: path.join(runDirectory, 'staging'),
      manifest,
      secretsFile: path.resolve(args[1]),
      env: process.env,
      managedPreferencePaths: [
        '/Library/Managed Preferences/com.anthropic.claudefordesktop.plist',
        `/Library/Managed Preferences/${userInfo().username}/com.anthropic.claudefordesktop.plist`,
      ],
    });
    const settings = await privateJson(
      path.join(transaction.directory, 'managed-mcp.json')
    );
    const receipt = {
      status: 'configured-for-manual-inspection',
      profileId: transaction.id,
      configuredServers: settings.managedMcpServers.map((server) => ({
        name: server.name,
        transport: server.transport,
        url: server.url,
        credentialHelperConfigured: Boolean(server.headersHelper),
        toolPolicy: server.toolPolicy ?? null,
      })),
      allowedMcpServers: settings.allowedMcpServers,
      allowManagedMcpServersOnly: settings.allowManagedMcpServersOnly,
      completeInventoryVerified: false,
      toolPolicyVerified: false,
      querySubmitted: false,
      restorationPending: true,
    };
    const output = path.resolve('.mcp-test-results/cowork-setup');
    await mkdir(output, { recursive: true, mode: 0o700 });
    const receiptFile = path.join(output, `${transaction.id}-manual.json`);
    await writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await app('start');
    console.log(JSON.stringify(receipt, null, 2));
    console.log(`Non-secret configuration receipt: ${receiptFile}`);
    console.log(
      'Claude is left open. Verify the task connector menu shows only the intended enabled MCP before asking a question.'
    );
    console.log(
      'This command has NOT independently verified the inventory and has NOT submitted a query.'
    );
    console.log(
      'When finished, use the explicit restore command. Do not edit Developer configuration or remove the recovery lock/staging manually.'
    );
  }
} catch {
  console.error(
    `Cowork configuration command failed at ${phase}. Raw errors and credential values are not printed.`
  );
  if (action === 'configure' && saved && session) {
    try {
      await restoreSession(session);
      console.error(
        'Original configuration and app-running state restored after failure.'
      );
    } catch {
      console.error(
        'Automatic restoration is incomplete. Retain the private staging and recovery journal; do not start another setup.'
      );
    }
  }
  process.exitCode = 1;
}
