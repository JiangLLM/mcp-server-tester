import { describe, expect, it } from 'vitest';
import {
  accessibilityTextContainsPrompt,
  buildEnsureFrontmostScript,
  buildPasteIntoFocusedComposerScript,
  buildPressReturnScript,
  isFreshMacCoworkComposerText,
  openFreshMacCoworkComposer,
  submitMacCoworkPrompt,
  type MacCoworkCheckpoint,
} from './macCowork.js';

describe('Mac Cowork driver', () => {
  it('recognizes a fresh Cowork composer from semantic accessibility text', () => {
    expect(
      isFreshMacCoworkComposerText(
        'Home\nWrite your prompt to Claude\nAutomatically approve'
      )
    ).toBe(true);
    expect(
      isFreshMacCoworkComposerText('Write your prompt to Claude\nLoading')
    ).toBe(false);
  });

  it('verifies short and long prompts without trusting a truncated AX value', () => {
    expect(
      accessibilityTextContainsPrompt(
        'Write your prompt to Claude Reply with exactly acknowledged.',
        'Reply with exactly acknowledged.'
      )
    ).toBe(true);

    const longPrompt = `${'a'.repeat(120)}${'b'.repeat(120)}`;
    expect(
      accessibilityTextContainsPrompt(
        `Value: ${'a'.repeat(80)} ... ${'b'.repeat(80)}`,
        longPrompt
      )
    ).toBe(true);
    expect(
      accessibilityTextContainsPrompt('Value: unrelated prompt', longPrompt)
    ).toBe(false);
  });

  it('opens the Cowork deep link and waits for the fresh composer', async () => {
    const opened: string[] = [];
    let observations = 0;
    const text = await openFreshMacCoworkComposer('Claude', {
      timeoutMs: 500,
      openUrl: async (url) => {
        opened.push(url);
      },
      readDescriptions: async () => {
        observations += 1;
        return observations === 1
          ? 'Home\nLoading Claude'
          : 'Home\nWrite your prompt to Claude\nAutomatically approve';
      },
    });

    expect(opened).toEqual(['claude://cowork/new']);
    expect(observations).toBe(2);
    expect(text).toContain('Automatically approve');
  });

  it('does not submit twice when the first Return becomes ambiguous', async () => {
    const calls: string[] = [];
    const checkpoint: MacCoworkCheckpoint = {
      phase: 'created',
      appName: 'Claude',
      prompt: 'Reply with exactly: acknowledged.',
      marker: 'MCP_SERVER_TESTER_TEST',
    };

    const result = await submitMacCoworkPrompt(checkpoint.prompt, {
      appName: 'Claude',
      marker: checkpoint.marker,
      deadlineAt: Date.now() + 5_000,
      dependencies: {
        ensureReady: async () => {
          calls.push('ready');
        },
        openFreshComposer: async () => {
          calls.push('open');
          return 'Write your prompt to Claude\nAutomatically approve';
        },
        paste: async () => {
          calls.push('paste');
        },
        readText: async () => {
          calls.push('read');
          return calls.filter((call) => call === 'read').length === 1
            ? 'Write your prompt to Claude Reply with exactly: acknowledged.'
            : '';
        },
        pressReturn: async () => {
          calls.push('return');
          throw new Error('osascript reported a transient failure');
        },
      },
    });

    expect(result.checkpoint.phase).toBe('submitted');
    expect(result.checkpoint.submissionConfidence).toBe('ambiguous');
    expect(calls.filter((call) => call === 'return')).toHaveLength(1);
  });

  it('builds scripts that only use semantic focus and a single Return', () => {
    expect(buildPasteIntoFocusedComposerScript('Claude')).toContain(
      'keystroke "v" using command down'
    );
    expect(buildPressReturnScript('Claude')).toContain('key code 36');
    expect(buildEnsureFrontmostScript('Claude')).toContain(
      'whose frontmost is true'
    );
  });
});
