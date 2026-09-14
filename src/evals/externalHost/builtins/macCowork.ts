import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ensureMacosDesktopAppReady,
  readMacosAccessibilityDescriptions,
  readMacosAccessibilityText,
  runAppleScript,
} from './macosDesktop.js';

const execFileAsync = promisify(execFile);
const DEFAULT_FRESH_COMPOSER_TIMEOUT_MS = 15_000;
const DEFAULT_FRONTMOST_TIMEOUT_MS = 2_000;
const DEFAULT_SETTLE_DELAY_MS = 150;
const MAX_ACCESSIBILITY_VERIFIED_VALUE_LENGTH = 160;

export type MacCoworkPhase =
  | 'created'
  | 'composer_ready'
  | 'armed'
  | 'submitted'
  | 'session_bound'
  | 'terminal'
  | 'failed';

export interface MacCoworkCheckpoint {
  phase: MacCoworkPhase;
  appName: string;
  prompt: string;
  marker: string;
  startedAt?: string;
  submittedAt?: string;
  sessionId?: string;
  submissionMode?: 'keyboard';
  submissionConfidence?: 'high' | 'ambiguous';
  error?: string;
}

export interface MacCoworkSubmissionOptions {
  appName: string;
  marker: string;
  openFreshComposer?: boolean;
  freshComposerTimeoutMs?: number;
  frontmostTimeoutMs?: number;
  settleDelayMs?: number;
  deadlineAt?: number;
  dependencies?: Partial<MacCoworkDependencies>;
}

export interface MacCoworkDependencies {
  ensureReady: typeof ensureMacosDesktopAppReady;
  openFreshComposer: typeof openFreshMacCoworkComposer;
  paste: typeof pasteIntoFocusedMacCoworkComposer;
  readText: typeof readMacosAccessibilityText;
  pressReturn: typeof pressReturnOnce;
}

export interface MacCoworkSubmissionResult {
  checkpoint: MacCoworkCheckpoint;
  visibleText?: string;
}

export async function submitMacCoworkPrompt(
  prompt: string,
  options: MacCoworkSubmissionOptions
): Promise<MacCoworkSubmissionResult> {
  if (!prompt.trim()) {
    throw new Error('Cowork prompt must be non-empty text.');
  }

  const checkpoint: MacCoworkCheckpoint = {
    phase: 'created',
    appName: options.appName,
    prompt,
    marker: options.marker,
  };
  const deadlineAt = options.deadlineAt ?? Date.now() + 120_000;
  const dependencies = options.dependencies ?? {};
  const ensureReady = dependencies.ensureReady ?? ensureMacosDesktopAppReady;
  const openFreshComposer =
    dependencies.openFreshComposer ?? openFreshMacCoworkComposer;
  const paste = dependencies.paste ?? pasteIntoFocusedMacCoworkComposer;
  const readText = dependencies.readText ?? readMacosAccessibilityText;
  const pressReturn = dependencies.pressReturn ?? pressReturnOnce;

  try {
    await assertBeforeDeadline(deadlineAt, 'before opening Cowork');
    await ensureReady(options.appName, remainingMs(deadlineAt));

    if (options.openFreshComposer !== false) {
      await openFreshComposer(options.appName, {
        timeoutMs: Math.min(
          options.freshComposerTimeoutMs ?? DEFAULT_FRESH_COMPOSER_TIMEOUT_MS,
          remainingMs(deadlineAt)
        ),
        deadlineAt,
      });
    }
    checkpoint.phase = 'composer_ready';

    await paste(options.appName, prompt, {
      frontmostTimeoutMs: options.frontmostTimeoutMs,
      settleDelayMs: options.settleDelayMs,
      deadlineAt,
    });
    const afterPaste = await readText(options.appName);
    if (!accessibilityTextContainsPrompt(afterPaste, prompt)) {
      throw new Error(
        `Cowork composer did not contain the submitted prompt after paste (marker=${options.marker}).`
      );
    }

    // This checkpoint is the at-most-once boundary. Anything after this point must
    // reconcile native session state rather than submit the primary prompt again.
    checkpoint.phase = 'armed';
    checkpoint.startedAt = new Date().toISOString();
    checkpoint.submissionMode = 'keyboard';
    await assertBeforeDeadline(deadlineAt, 'before submitting Cowork');

    try {
      await pressReturn(options.appName, {
        frontmostTimeoutMs: options.frontmostTimeoutMs,
        deadlineAt,
      });
      checkpoint.submissionConfidence = 'high';
    } catch (error) {
      const currentText = await readText(options.appName).catch(() => '');
      if (accessibilityTextContainsPrompt(currentText, prompt)) {
        throw error;
      }
      // Return may have reached Claude even if osascript reported an error. Do not
      // click Send or press Return again; native session reconciliation is authoritative.
      checkpoint.submissionConfidence = 'ambiguous';
    }

    checkpoint.phase = 'submitted';
    checkpoint.submittedAt = new Date().toISOString();
    return { checkpoint, visibleText: afterPaste };
  } catch (error) {
    checkpoint.phase = 'failed';
    checkpoint.error = formatError(error);
    throw Object.assign(new Error(checkpoint.error), { checkpoint });
  }
}

export async function openFreshMacCoworkComposer(
  appName: string,
  options: {
    timeoutMs?: number;
    deadlineAt?: number;
    openUrl?: (url: string) => Promise<void>;
    readDescriptions?: (name: string) => Promise<string>;
  } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FRESH_COMPOSER_TIMEOUT_MS;
  const deadlineAt = Math.min(
    options.deadlineAt ?? Date.now() + timeoutMs,
    Date.now() + timeoutMs
  );
  const openUrl = options.openUrl ?? openMacExternalUrl;
  const readDescriptions =
    options.readDescriptions ?? readMacosAccessibilityDescriptions;

  await assertBeforeDeadline(
    deadlineAt,
    'before opening a fresh Cowork composer'
  );
  await openUrl('claude://cowork/new');

  let lastText = '';
  while (Date.now() < deadlineAt) {
    lastText = await readDescriptions(appName).catch(() => '');
    if (isFreshMacCoworkComposerText(lastText)) {
      return lastText;
    }
    await delay(Math.min(250, Math.max(1, deadlineAt - Date.now())));
  }

  throw new Error(
    `Cowork did not expose a fresh composer within ${timeoutMs}ms. Last accessibility text: ${lastText
      .replaceAll(/\s+/g, ' ')
      .slice(0, 500)}`
  );
}

export function isFreshMacCoworkComposerText(text: string): boolean {
  return (
    text.includes('Write your prompt to Claude') &&
    (text.includes('Automatically approve') ||
      text.includes('Manually approve'))
  );
}

export function accessibilityTextContainsPrompt(
  text: string,
  prompt: string
): boolean {
  const normalizedText = normalizeAccessibleText(text);
  const normalizedPrompt = normalizeAccessibleText(prompt);
  if (!normalizedPrompt) return false;
  if (normalizedPrompt.length <= MAX_ACCESSIBILITY_VERIFIED_VALUE_LENGTH) {
    return normalizedText.includes(normalizedPrompt);
  }

  return (
    normalizedText.includes(normalizedPrompt.slice(0, 80)) &&
    normalizedText.includes(normalizedPrompt.slice(-80))
  );
}

export async function pasteIntoFocusedMacCoworkComposer(
  appName: string,
  prompt: string,
  options: {
    frontmostTimeoutMs?: number;
    settleDelayMs?: number;
    deadlineAt?: number;
    readClipboard?: () => Promise<string | null>;
    writeClipboard?: (text: string) => Promise<void>;
  } = {}
): Promise<void> {
  const deadlineAt = options.deadlineAt ?? Date.now() + 30_000;
  const readClipboard = options.readClipboard ?? readMacClipboard;
  const writeClipboard = options.writeClipboard ?? writeMacClipboard;
  const previousClipboard = await readClipboard();

  try {
    await assertBeforeDeadline(
      deadlineAt,
      'before writing the Cowork clipboard'
    );
    await writeClipboard(prompt);
    await ensureMacAppFrontmost(appName, {
      timeoutMs: Math.min(
        options.frontmostTimeoutMs ?? DEFAULT_FRONTMOST_TIMEOUT_MS,
        remainingMs(deadlineAt)
      ),
      deadlineAt,
    });
    await runAppleScript(buildPasteIntoFocusedComposerScript(appName), {
      timeoutMs: Math.min(15_000, remainingMs(deadlineAt)),
    });
    await delay(options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS);
  } finally {
    if (previousClipboard !== null) {
      await writeClipboard(previousClipboard).catch(() => undefined);
    }
  }
}

export async function pressReturnOnce(
  appName: string,
  options: {
    frontmostTimeoutMs?: number;
    deadlineAt?: number;
  } = {}
): Promise<void> {
  const deadlineAt = options.deadlineAt ?? Date.now() + 15_000;
  await ensureMacAppFrontmost(appName, {
    timeoutMs: Math.min(
      options.frontmostTimeoutMs ?? DEFAULT_FRONTMOST_TIMEOUT_MS,
      remainingMs(deadlineAt)
    ),
    deadlineAt,
  });
  await runAppleScript(buildPressReturnScript(appName), {
    timeoutMs: Math.min(15_000, remainingMs(deadlineAt)),
  });
}

export function buildPasteIntoFocusedComposerScript(appName: string): string {
  return `
tell application "System Events"
  tell process ${JSON.stringify(appName)}
    keystroke "a" using command down
    delay 0.05
    keystroke "v" using command down
  end tell
end tell
`;
}

export function buildPressReturnScript(appName: string): string {
  return `
tell application "System Events"
  tell process ${JSON.stringify(appName)}
    key code 36
  end tell
end tell
`;
}

export async function ensureMacAppFrontmost(
  appName: string,
  options: {
    timeoutMs?: number;
    deadlineAt?: number;
    runScript?: (script: string) => Promise<string>;
  } = {}
): Promise<void> {
  const deadlineAt = Math.min(
    options.deadlineAt ??
      Date.now() + (options.timeoutMs ?? DEFAULT_FRONTMOST_TIMEOUT_MS),
    Date.now() + (options.timeoutMs ?? DEFAULT_FRONTMOST_TIMEOUT_MS)
  );
  const runScript = options.runScript ?? ((script) => runAppleScript(script));
  let lastFrontmost = '';

  while (Date.now() < deadlineAt) {
    lastFrontmost = await runScript(buildEnsureFrontmostScript(appName));
    if (lastFrontmost.trim() === appName) return;
    await delay(Math.min(100, Math.max(1, deadlineAt - Date.now())));
  }

  throw new Error(
    `${appName} did not become frontmost before the deadline (frontmost=${JSON.stringify(lastFrontmost.trim())})`
  );
}

export function buildEnsureFrontmostScript(appName: string): string {
  return `
tell application ${JSON.stringify(appName)} to activate
 tell application "System Events"
   tell process ${JSON.stringify(appName)} to set frontmost to true
   return name of first application process whose frontmost is true
 end tell
`;
}

export async function openMacExternalUrl(url: string): Promise<void> {
  await execFileAsync('/usr/bin/open', [url], { timeout: 15_000 });
}

export async function readMacClipboard(): Promise<string | null> {
  try {
    const result = await execFileAsync('/usr/bin/pbpaste', [], {
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'en_US.UTF-8' },
    });
    return String(result.stdout ?? '');
  } catch {
    return null;
  }
}

export async function writeMacClipboard(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/pbcopy', [], {
      env: { ...process.env, LC_ALL: 'en_US.UTF-8' },
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pbcopy exited with code ${code ?? 'unknown'}`));
    });
    child.stdin.end(text, 'utf8');
  });
}

function normalizeAccessibleText(value: string): string {
  return String(value ?? '')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function remainingMs(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

async function assertBeforeDeadline(
  deadlineAt: number,
  stage: string
): Promise<void> {
  if (Date.now() >= deadlineAt) {
    throw new Error(`Cowork deadline expired ${stage}.`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
