import { describe, expect, it } from 'vitest';
import {
  actOnMacComputerUseNode,
  getMacComputerUseRuntime,
  listMacComputerUseProviders,
  parseMacComputerUseNodes,
  registerMacComputerUseProvider,
  validateMacComputerUseApp,
} from './macComputerUse.js';
import type { MacComputerUseApp } from './macComputerUse.js';

describe('Mac Computer Use runtime', () => {
  it('parses semantic CUA nodes and their values', () => {
    const nodes = parseMacComputerUseNodes(
      '0 Window, Title: Claude\n\t1 text entry area, Value: hello world\n\t2 button Send'
    );
    expect(nodes).toEqual([
      {
        index: 0,
        depth: 0,
        text: 'Window, Title: Claude',
        value: undefined,
        url: undefined,
      },
      {
        index: 1,
        depth: 1,
        text: 'text entry area, Value: hello world',
        value: 'hello world',
        url: undefined,
      },
      {
        index: 2,
        depth: 1,
        text: 'button Send',
        value: undefined,
        url: undefined,
      },
    ]);
  });

  it('re-observes after stale-node failures before retrying the action', async () => {
    let observations = 0;
    const clicks: number[] = [];
    const app: MacComputerUseApp = {
      getAXStateAndScreenshot: async () => {
        observations += 1;
        return { state: '\t4 button Send' };
      },
      click: async (index) => {
        clicks.push(index);
        if (clicks.length === 1) throw new Error('AXError.invalidUIElement');
      },
      setValue: async () => undefined,
      pressKey: async () => undefined,
    };

    await actOnMacComputerUseNode(app, /^button Send$/, (node) =>
      app.click(node.index)
    );

    expect(clicks).toEqual([4, 4]);
    expect(observations).toBe(2);
  });

  it('registers and resolves arbitrary CUA providers as MST plugins', async () => {
    const provider = {
      id: 'test-provider',
      getApp: async () => ({
        getAXStateAndScreenshot: async () => ({ state: '' }),
        click: async () => undefined,
        setValue: async () => undefined,
        pressKey: async () => undefined,
      }),
    };
    const unregister = registerMacComputerUseProvider(provider);
    try {
      expect(listMacComputerUseProviders().map(({ id }) => id)).toContain(
        'test-provider'
      );
      expect(getMacComputerUseRuntime('test-provider')).toBe(provider);
    } finally {
      unregister();
    }
  });

  it('fails clearly when the global CUA plugin has not been initialized', async () => {
    const host = globalThis as typeof globalThis & { cua?: unknown };
    const previous = host.cua;
    delete host.cua;
    try {
      await expect(getMacComputerUseRuntime().getApp('Claude')).rejects.toThrow(
        'globalThis.cua.getApp is not initialized'
      );
    } finally {
      host.cua = previous;
    }
  });

  it('rejects a runtime app that does not expose the CUA operations', () => {
    expect(() => validateMacComputerUseApp('Claude', {})).toThrow(
      'getAXStateAndScreenshot, click, setValue, pressKey'
    );
  });
});
