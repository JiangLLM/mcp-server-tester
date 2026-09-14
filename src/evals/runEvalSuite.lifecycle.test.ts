import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEvalSuite } from './runEvalSuite.js';
import { registerDatasetSource, registerHost } from './frameworkRegistries.js';
import type { EvalCase } from './datasetTypes.js';
import type { DatasetConfig } from './evalManifest.js';
import type {
  HostDefinition,
  PreparedHostSession,
} from './evalFrameworkTypes.js';

const transport = vi.hoisted(() => ({
  connect: vi.fn(async () => ({})),
  close: vi.fn(async () => {}),
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'OK' }] })),
  externalRun: vi.fn(async () => ({ success: true, finalText: 'OK' })),
}));
vi.mock('./externalHost/runtime.js', () => ({
  runExternalHostScenario: transport.externalRun,
}));
vi.mock('../mcp/clientFactory.js', () => ({
  createMCPClientForConfig: transport.connect,
  closeMCPClient: transport.close,
}));
vi.mock('../mcp/fixtures/mcpFixture.js', () => ({
  createMCPFixture: () => ({ callTool: transport.callTool }),
}));

const dirs: string[] = [];
let sequence = 0;
beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

function hostCase(id: string, extra: Partial<EvalCase> = {}): EvalCase {
  return { id, mode: 'host', scenario: id, ...extra };
}

function fakeHost(options: Partial<HostDefinition> = {}) {
  const name = `lifecycle-host-${sequence++}`;
  const run = vi.fn<PreparedHostSession['run']>(async () => ({
    finalText: 'OK',
    events: [],
  }));
  const dispose = vi.fn<PreparedHostSession['dispose']>(async () => {});
  const prepareSession = vi.fn<NonNullable<HostDefinition['prepareSession']>>(
    async () => ({ run, dispose })
  );
  const definition: HostDefinition = {
    name,
    schema: z.object({ model: z.string().default('default') }).passthrough(),
    evidence: 'structured',
    prepareSession,
    ...options,
  };
  registerHost(definition);
  return { name, run, dispose, prepareSession, definition };
}

async function fixture(
  host: string,
  datasets: EvalCase[][],
  extra: Record<string, unknown> = {}
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-lifecycle-'));
  dirs.push(dir);
  const source = `lifecycle-source-${sequence++}`;
  const load = vi.fn(async (config: DatasetConfig) => ({
    name: `dataset-${String(config.slot)}`,
    cases: datasets[Number(config.slot)]!,
  }));
  registerDatasetSource({
    name: source,
    schema: z.object({ slot: z.number() }),
    load,
  });
  const manifestPath = path.join(dir, 'manifest.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      name: 'lifecycle',
      host: { type: host },
      datasets: datasets.map((_, slot) => ({ type: source, slot })),
      servers: [],
      ...extra,
    })
  );
  return {
    dir,
    load,
    options: { manifestPath, rootDir: dir },
  };
}

const server = { transport: 'http', serverUrl: 'https://example.com/eval' };

describe('suite prepared host lifecycle', () => {
  it('rejects legacy external_host cases instead of silently bypassing preparation', async () => {
    const host = fakeHost();
    const f = await fixture(host.name, [
      [
        hostCase('legacy', {
          mode: 'external_host',
          externalHost: { driver: 'anthropic.claude.cowork.desktop-app.macos' },
        }),
      ],
    ]);
    await expect(runEvalSuite(f.options)).rejects.toThrow(
      'Legacy external_host cases bypass the prepared host lifecycle'
    );
    expect(host.prepareSession).not.toHaveBeenCalled();
    expect(host.run).not.toHaveBeenCalled();
    expect(transport.connect).not.toHaveBeenCalled();
  });
  it.each(['same-dataset', 'later-dataset', 'earlier-dataset'] as const)(
    'rejects legacy cases with a prepared case override in %s before any execution',
    async (location) => {
      const baseRun = vi.fn<NonNullable<HostDefinition['run']>>(async () => ({
        finalText: 'OK',
        events: [],
      }));
      const base = fakeHost({ prepareSession: undefined, run: baseRun });
      const prepared = fakeHost();
      const override = hostCase('prepared', { host: { type: prepared.name } });
      const legacy = hostCase('legacy', {
        mode: 'external_host',
        externalHost: { driver: 'anthropic.claude.cowork.desktop-app.macos' },
      });
      const datasets =
        location === 'same-dataset'
          ? [[override, legacy]]
          : location === 'later-dataset'
            ? [[override], [legacy]]
            : [[legacy], [override]];
      const f = await fixture(base.name, [[hostCase('base')], ...datasets]);
      await expect(runEvalSuite(f.options)).rejects.toThrow(
        'Legacy external_host cases bypass the prepared host lifecycle'
      );
      expect(baseRun).not.toHaveBeenCalled();
      expect(prepared.prepareSession).not.toHaveBeenCalled();
      expect(transport.externalRun).not.toHaveBeenCalled();
      expect(transport.connect).not.toHaveBeenCalled();
    }
  );

  it('preserves legacy external_host dispatch in a run-only arm', async () => {
    const run = vi.fn<NonNullable<HostDefinition['run']>>(async () => ({
      finalText: 'OK',
      events: [],
    }));
    const base = fakeHost({ prepareSession: undefined, run });
    const f = await fixture(base.name, [
      [
        hostCase('base'),
        hostCase('legacy', {
          mode: 'external_host',
          externalHost: { driver: 'anthropic.claude.cowork.desktop-app.macos' },
        }),
      ],
    ]);
    const result = await runEvalSuite(f.options);
    expect(result.summary.results.every((item) => item.pass)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(transport.externalRun).toHaveBeenCalledTimes(1);
  });

  it('prefers automatic preparation and reuses a session across cases, iterations, and datasets', async () => {
    const fallback = vi.fn<NonNullable<HostDefinition['run']>>(async () => ({
      finalText: 'fallback',
      events: [],
    }));
    const host = fakeHost({ run: fallback });
    const f = await fixture(host.name, [
      [
        hostCase('one', { iterations: 2 }),
        hostCase('two', { iterations: 2, mode: 'mcp_host' }),
      ],
      [hostCase('three', { iterations: 2, host: { type: host.name } })],
    ]);
    const result = await runEvalSuite(f.options);
    expect(result.summary.results.every((item) => item.pass)).toBe(true);
    expect(host.prepareSession).toHaveBeenCalledTimes(1);
    expect(host.run).toHaveBeenCalledTimes(6);
    expect(host.dispose).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(transport.connect).not.toHaveBeenCalled();
  });

  it('isolates sessions per arm and passes effective config, servers, and context', async () => {
    const events: string[] = [];
    const host = fakeHost();
    host.prepareSession.mockImplementation(async (input, config, context) => {
      const arm = context.arm!.name;
      events.push(`prepare:${arm}`);
      expect(input.servers[0]).toMatchObject({ label: arm });
      expect(input.env).toBe(context.env);
      expect(config.model).toBe(arm);
      expect(context.manifest.host).toEqual(config);
      return {
        async run() {
          events.push(`run:${arm}`);
          return { finalText: 'OK', events: [] };
        },
        async dispose() {
          events.push(`dispose:${arm}`);
        },
      };
    });
    const f = await fixture(host.name, [[hostCase('one')]], {
      arms: ['first', 'second'].map((name) => ({
        name,
        host: { type: host.name, model: name },
        servers: [{ ...server, label: name }],
      })),
    });
    await runEvalSuite(f.options);
    expect(events).toEqual([
      'prepare:first',
      'run:first',
      'dispose:first',
      'prepare:second',
      'run:second',
      'dispose:second',
    ]);
  });

  it('disposes before serial config or host switches, including a run-only host', async () => {
    const events: string[] = [];
    const host = fakeHost();
    host.prepareSession.mockImplementation(async (_input, config) => {
      events.push(`prepare:${String(config.model)}`);
      return {
        async run() {
          events.push(`run:${String(config.model)}`);
          return { finalText: 'OK', events: [] };
        },
        async dispose() {
          await Promise.resolve();
          events.push(`dispose:${String(config.model)}`);
        },
      };
    });
    const other = fakeHost({
      prepareSession: undefined,
      async run() {
        events.push('run:other');
        return { finalText: 'OK', events: [] };
      },
    });
    const f = await fixture(host.name, [
      [
        hostCase('one'),
        hostCase('two', { host: { type: host.name, model: 'override' } }),
        hostCase('three', { host: { type: other.name } }),
        hostCase('four'),
      ],
    ]);
    await runEvalSuite(f.options);
    expect(events).toEqual([
      'prepare:default',
      'run:default',
      'dispose:default',
      'prepare:override',
      'run:override',
      'dispose:override',
      'run:other',
      'prepare:default',
      'run:default',
      'dispose:default',
    ]);
  });

  it('uses per-case prepare-only overrides when the arm host is run-only', async () => {
    const baseRun = vi.fn<NonNullable<HostDefinition['run']>>(async () => ({
      finalText: 'OK',
      events: [],
    }));
    const base = fakeHost({ prepareSession: undefined, run: baseRun });
    const override = fakeHost();
    const f = await fixture(base.name, [
      [
        hostCase('base'),
        hostCase('override', { host: { type: override.name, model: 'case' } }),
      ],
    ]);
    await runEvalSuite(f.options);
    expect(baseRun).toHaveBeenCalledTimes(1);
    expect(override.prepareSession).toHaveBeenCalledTimes(1);
    expect(override.prepareSession.mock.calls[0]?.[1]).toMatchObject({
      model: 'case',
    });
    expect(override.dispose).toHaveBeenCalledTimes(1);
  });

  it('prepares lazily after an initial direct case and never connects a prepare-only host', async () => {
    const host = fakeHost();
    host.prepareSession.mockImplementation(async () => {
      expect(transport.callTool).toHaveBeenCalledTimes(1);
      expect(transport.close).toHaveBeenCalledTimes(1);
      return { run: host.run, dispose: host.dispose };
    });
    const f = await fixture(
      host.name,
      [[{ id: 'direct', toolName: 'echo', args: {} }, hostCase('host')]],
      { servers: [server] }
    );
    const result = await runEvalSuite(f.options);
    expect(result.summary.results.every((item) => item.pass)).toBe(true);
    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(host.prepareSession).toHaveBeenCalledTimes(1);
  });

  it('never prepares on a dry run', async () => {
    const host = fakeHost({ maxConcurrency: 1 });
    const f = await fixture(host.name, [[hostCase('one')]]);
    await runEvalSuite({ ...f.options, dryRun: true });
    expect(f.load).not.toHaveBeenCalled();
    expect(host.prepareSession).not.toHaveBeenCalled();
    expect(host.dispose).not.toHaveBeenCalled();
    expect(transport.connect).not.toHaveBeenCalled();
  });

  it('never prepares or imposes unused host concurrency on direct-only runs', async () => {
    const host = fakeHost({ maxConcurrency: 1 });
    const f = await fixture(
      host.name,
      [[{ id: 'direct', toolName: 'echo', args: {} }]],
      {
        concurrency: 2,
        servers: [server],
      }
    );
    const result = await runEvalSuite(f.options);
    expect(result.summary.results[0]?.pass).toBe(true);
    expect(host.prepareSession).not.toHaveBeenCalled();
    expect(host.dispose).not.toHaveBeenCalled();
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('disposes after host execution rejects and preserves the failed verdict', async () => {
    const host = fakeHost();
    host.run.mockRejectedValue(new Error('execution failed'));
    const f = await fixture(host.name, [[hostCase('one')]]);
    const result = await runEvalSuite(f.options);
    expect(result.summary.results[0]).toMatchObject({
      pass: false,
      error: 'execution failed',
    });
    expect(host.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not run or dispose an unprepared session after preparation rejects', async () => {
    const host = fakeHost();
    const selfCleanup = vi.fn();
    host.prepareSession.mockImplementation(async () => {
      selfCleanup();
      throw new Error('preparation failed');
    });
    const f = await fixture(host.name, [[hostCase('one'), hostCase('two')]], {
      concurrency: 2,
    });
    const result = await runEvalSuite(f.options);
    expect(result.summary.results.every((item) => !item.pass)).toBe(true);
    expect(host.prepareSession).toHaveBeenCalledTimes(1);
    expect(selfCleanup).toHaveBeenCalledTimes(1);
    expect(host.run).not.toHaveBeenCalled();
    expect(host.dispose).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'propagates final cleanup failure (execution failed: %s)',
    async (executionFails) => {
      const host = fakeHost();
      if (executionFails)
        host.run.mockRejectedValue(new Error('execution failed'));
      host.dispose.mockRejectedValue(new Error('cleanup failed'));
      const f = await fixture(host.name, [[hostCase('one')]]);
      await expect(runEvalSuite(f.options)).rejects.toThrow('cleanup failed');
      expect(host.dispose).toHaveBeenCalledTimes(1);
    }
  );

  it('propagates switch cleanup failure and never prepares or runs a replacement', async () => {
    const host = fakeHost();
    host.dispose.mockRejectedValue(new Error('switch cleanup failed'));
    const other = fakeHost();
    const f = await fixture(host.name, [
      [
        hostCase('one'),
        hostCase('two', { host: { type: other.name } }),
        hostCase('three'),
      ],
    ]);
    await expect(runEvalSuite(f.options)).rejects.toThrow(
      'switch cleanup failed'
    );
    expect(host.run).toHaveBeenCalledTimes(1);
    expect(host.dispose).toHaveBeenCalledTimes(1);
    expect(other.prepareSession).not.toHaveBeenCalled();
  });

  it('shares in-flight preparation for concurrent cases and waits for runs before disposal', async () => {
    const host = fakeHost();
    let active = 0;
    let maximum = 0;
    let release: () => void = () => {};
    const bothRunning = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.prepareSession.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { run: host.run, dispose: host.dispose };
    });
    host.run.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      if (active === 2) release();
      await bothRunning;
      active--;
      return { finalText: 'OK', events: [] };
    });
    host.dispose.mockImplementation(async () => {
      expect(active).toBe(0);
    });
    const f = await fixture(host.name, [[hostCase('one'), hostCase('two')]], {
      concurrency: 2,
    });
    await runEvalSuite(f.options);
    expect(maximum).toBe(2);
    expect(host.prepareSession).toHaveBeenCalledTimes(1);
    expect(host.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'drains started workers after malformed assertions without dispatching queued cases (second worker fails: %s)',
    async (secondFails) => {
      const host = fakeHost();
      const events: string[] = [];
      let releaseSlow: () => void = () => {};
      let startedSlow: () => void = () => {};
      const slowStarted = new Promise<void>((resolve) => {
        startedSlow = resolve;
      });
      const slowReleased = new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      host.run.mockImplementation(async (input) => {
        events.push(`run:${input.scenario}`);
        if (input.scenario === 'malformed') await slowStarted;
        if (input.scenario === 'slow') {
          startedSlow();
          await slowReleased;
          events.push('slow:finished');
        }
        return { finalText: 'OK', events: [] };
      });
      host.dispose.mockImplementation(async () => {
        events.push('dispose');
      });
      const f = await fixture(
        host.name,
        [
          [
            // The first task finishes last: preserve rejection order, not index.
            hostCase('slow', {
              expect: { matchesPattern: secondFails ? '(' : 'OK' },
            }),
            hostCase('malformed', { expect: { matchesPattern: '[' } }),
            hostCase('queued'),
          ],
          [hostCase('later-dataset')],
        ],
        { concurrency: 2 }
      );
      let settled = false;
      const outcome = runEvalSuite(f.options).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        }
      );
      try {
        await slowStarted;
        // Let the fast worker's malformed assertion reject through the pool.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(host.dispose).not.toHaveBeenCalled();
      } finally {
        releaseSlow();
        await outcome;
      }
      expect(await outcome).toBeInstanceOf(SyntaxError);
      expect(String(await outcome)).toContain('Unterminated character class');
      expect(events).toEqual([
        'run:slow',
        'run:malformed',
        'slow:finished',
        'dispose',
      ]);
      expect(host.prepareSession).toHaveBeenCalledTimes(1);
      expect(host.dispose).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['base', 'later-arm', 'later-case', 'later-dataset'] as const)(
    'preflights maxConcurrency for %s before any execution',
    async (location) => {
      const normal = fakeHost();
      const bounded = fakeHost({ maxConcurrency: 1 });
      const datasets = [[hostCase('one')]];
      const extra: Record<string, unknown> = {
        concurrency: 2,
        servers: [server],
      };
      if (location === 'later-arm')
        extra.arms = [
          { name: 'first' },
          { name: 'second', host: { type: bounded.name } },
        ];
      if (location === 'later-case')
        datasets[0]!.push(hostCase('two', { host: { type: bounded.name } }));
      if (location === 'later-dataset')
        datasets.push([hostCase('two', { host: { type: bounded.name } })]);
      const f = await fixture(
        location === 'base' ? bounded.name : normal.name,
        datasets,
        extra
      );
      await expect(runEvalSuite(f.options)).rejects.toThrow('maxConcurrency 1');
      expect(normal.prepareSession).not.toHaveBeenCalled();
      expect(bounded.prepareSession).not.toHaveBeenCalled();
      expect(transport.connect).not.toHaveBeenCalled();
    }
  );

  it('also preflights run-only host concurrency before direct or host execution', async () => {
    const run = vi.fn<NonNullable<HostDefinition['run']>>(async () => ({
      finalText: 'OK',
      events: [],
    }));
    const host = fakeHost({
      prepareSession: undefined,
      run,
      maxConcurrency: 1,
    });
    const f = await fixture(
      host.name,
      [[{ id: 'direct', toolName: 'echo', args: {} }, hostCase('host')]],
      { concurrency: 2, servers: [server] }
    );
    await expect(runEvalSuite(f.options)).rejects.toThrow('maxConcurrency 1');
    expect(run).not.toHaveBeenCalled();
    expect(transport.connect).not.toHaveBeenCalled();
  });

  it('preserves concurrent switching for run-only hosts', async () => {
    const run = vi.fn<NonNullable<HostDefinition['run']>>(async () => ({
      finalText: 'OK',
      events: [],
    }));
    const first = fakeHost({ prepareSession: undefined, run });
    const second = fakeHost({ prepareSession: undefined, run });
    const f = await fixture(
      first.name,
      [
        [
          hostCase('first'),
          hostCase('second', { host: { type: second.name } }),
        ],
      ],
      { concurrency: 2 }
    );
    const result = await runEvalSuite(f.options);
    expect(result.summary.results.every((item) => item.pass)).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('validates only selected arms and cases', async () => {
    const normal = fakeHost();
    const bounded = fakeHost({ maxConcurrency: 1 });
    const f = await fixture(
      normal.name,
      [
        [
          hostCase('selected', { tags: ['keep'] }),
          hostCase('excluded', {
            tags: ['skip'],
            host: { type: bounded.name },
          }),
        ],
      ],
      {
        concurrency: 2,
        filterTags: ['keep'],
        arms: [
          { name: 'keep' },
          { name: 'skip', host: { type: bounded.name } },
        ],
      }
    );
    const result = await runEvalSuite({ ...f.options, arm: 'keep' });
    expect(result.summary.results).toHaveLength(1);
    expect(normal.prepareSession).toHaveBeenCalledTimes(1);
    expect(bounded.prepareSession).not.toHaveBeenCalled();
  });

  it.each(['config', 'host', 'legacy-config'] as const)(
    'rejects concurrent %s switching upfront without imposing an implicit concurrency limit',
    async (switchType) => {
      const host = fakeHost();
      const other = fakeHost({
        prepareSession: undefined,
        async run() {
          return { finalText: 'OK', events: [] };
        },
      });
      const extra: Partial<EvalCase> =
        switchType === 'legacy-config'
          ? { mcpHostConfig: { provider: 'anthropic' } }
          : {
              host: {
                type: switchType === 'host' ? other.name : host.name,
                model: 'other',
              },
            };
      const f = await fixture(
        host.name,
        [[hostCase('one'), hostCase('two', extra)]],
        { concurrency: 2 }
      );
      await expect(runEvalSuite(f.options)).rejects.toThrow(
        'Concurrent host/config switching'
      );
      expect(host.prepareSession).not.toHaveBeenCalled();
      expect(transport.connect).not.toHaveBeenCalled();
    }
  );

  it('keeps simultaneous suites isolated', async () => {
    const host = fakeHost();
    const f = await fixture(host.name, [[hostCase('one')]]);
    await Promise.all([runEvalSuite(f.options), runEvalSuite(f.options)]);
    expect(host.prepareSession).toHaveBeenCalledTimes(2);
    expect(host.dispose).toHaveBeenCalledTimes(2);
  });
});
