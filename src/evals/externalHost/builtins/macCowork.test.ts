import { describe, expect, it } from 'vitest';
import {
  accessibilityTextContainsPrompt,
  isFreshMacCoworkComposerText,
  openFreshMacCoworkComposer,
  submitMacCoworkPrompt,
  type MacCoworkCheckpoint,
} from './macCowork.js';
import type { MacComputerUseApp } from './macComputerUse.js';

describe('Mac Cowork Computer Use driver', () => {
  it('recognizes a fresh Cowork composer from the CUA observation text', () => {
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

  it('opens the Cowork deep link and waits for a fresh CUA composer', async () => {
    const opened: string[] = [];
    let observations = 0;
    const app: MacComputerUseApp = {
      getAXStateAndScreenshot: async () => {
        observations += 1;
        return {
          state:
            observations === 1
              ? 'Home\nLoading Claude'
              : 'Home\nWrite your prompt to Claude\nAutomatically approve',
        };
      },
      click: async () => undefined,
      setValue: async () => undefined,
      pressKey: async () => undefined,
    };

    const text = await openFreshMacCoworkComposer('Claude', {
      app,
      timeoutMs: 500,
      openUrl: async (url) => {
        opened.push(url);
      },
    });

    expect(opened).toEqual(['claude://cowork/new']);
    expect(observations).toBe(2);
    expect(text).toContain('Automatically approve');
  });

  it('does not submit twice when the first CUA click becomes ambiguous', async () => {
    const calls: string[] = [];
    const checkpoint: MacCoworkCheckpoint = {
      phase: 'created',
      appName: 'Claude',
      prompt: 'Reply with exactly: acknowledged.',
      marker: 'MCP_SERVER_TESTER_TEST',
    };
    let observedText =
      'Write your prompt to Claude Reply with exactly: acknowledged.';

    const app: MacComputerUseApp = {
      getAXStateAndScreenshot: async () => ({ state: observedText }),
      click: async () => {
        calls.push('click-send');
        observedText = 'Cowork task running';
        throw new Error('CUA click reported a transient failure');
      },
      setValue: async (_index, value) => {
        calls.push('set-value');
        observedText = `Write your prompt to Claude ${value}`;
      },
      pressKey: async () => {
        calls.push('press-key');
      },
    };

    const result = await submitMacCoworkPrompt(checkpoint.prompt, {
      appName: 'Claude',
      marker: checkpoint.marker,
      deadlineAt: Date.now() + 5_000,
      runtime: { getApp: async () => app },
      dependencies: {
        ensureReady: async () => {
          calls.push('ready');
          return { text: observedText, nodes: [] };
        },
        openFreshComposer: async () => {
          calls.push('open');
          return 'Write your prompt to Claude\nAutomatically approve';
        },
        setComposerValue: async (target, prompt) => {
          calls.push('set-composer');
          await target.setValue(1, prompt);
        },
        submitDraft: async (target) => {
          calls.push('submit');
          await target.click(2);
        },
      },
    });

    expect(result.checkpoint.phase).toBe('submitted');
    expect(result.checkpoint.submissionConfidence).toBe('ambiguous');
    expect(calls.filter((call) => call === 'submit')).toHaveLength(1);
    expect(calls.filter((call) => call === 'click-send')).toHaveLength(1);
  });
});
