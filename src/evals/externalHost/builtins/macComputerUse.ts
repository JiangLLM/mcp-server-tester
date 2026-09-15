export interface MacComputerUseApp {
  getAXStateAndScreenshot(options?: {
    disableDiffing?: boolean;
    emit?: boolean;
  }): Promise<{ state?: string; screenshot?: unknown }>;
  click(elementIndex: number): Promise<unknown>;
  setValue(elementIndex: number, value: string): Promise<unknown>;
  pressKey(key: string): Promise<unknown>;
}

export interface MacComputerUseRuntime {
  getApp(appName: string): Promise<MacComputerUseApp>;
}

interface GlobalComputerUseHost {
  cua?: {
    getApp?: (appName: string) => Promise<unknown>;
  };
}

export interface MacComputerUseNode {
  index: number;
  depth: number;
  text: string;
  value?: string;
  url?: string;
}

export interface MacComputerUseObservation {
  text: string;
  nodes: MacComputerUseNode[];
  screenshot?: unknown;
}

const staleMarkers = [
  '-10005',
  'nowindowsavailable',
  'windownotfoundatposition',
  'no longer valid',
  'is not active',
  'is not defined',
  'screencapturekit',
  'the user changed',
  're-query the latest state',
  'axerror.invaliduielement',
];

export function getMacComputerUseRuntime(): MacComputerUseRuntime {
  const host = globalThis as typeof globalThis & GlobalComputerUseHost;
  if (typeof host.cua?.getApp !== 'function') {
    throw new Error(
      'Computer Use runtime unavailable: globalThis.cua.getApp is not initialized. Run MST inside a CUA-enabled host or inject a MacComputerUseRuntime.'
    );
  }

  return {
    async getApp(appName) {
      let rawApp: unknown;
      try {
        rawApp = await host.cua!.getApp!(appName);
      } catch (error) {
        throw new Error(
          `Computer Use could not acquire native app ${appName}: ${formatError(error)}`
        );
      }
      return validateMacComputerUseApp(appName, rawApp);
    },
  };
}

export function validateMacComputerUseApp(
  appName: string,
  app: unknown
): MacComputerUseApp {
  const missing = [
    'getAXStateAndScreenshot',
    'click',
    'setValue',
    'pressKey',
  ].filter(
    (method) =>
      typeof (app as Record<string, unknown> | null | undefined)?.[method] !==
      'function'
  );
  if (missing.length > 0) {
    throw new Error(
      `Computer Use native app ${appName} is missing: ${missing.join(', ')}`
    );
  }
  return app as MacComputerUseApp;
}

export async function observeMacComputerUseApp(
  app: MacComputerUseApp,
  options: { retries?: number } = {}
): Promise<MacComputerUseObservation> {
  const retries = options.retries ?? 1;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const result = await app.getAXStateAndScreenshot({
        disableDiffing: true,
        emit: false,
      });
      const text = String(result.state ?? '');
      return {
        text,
        nodes: parseMacComputerUseNodes(text),
        screenshot: result.screenshot,
      };
    } catch (error) {
      lastError = error;
      if (!isStaleMacComputerUseError(error) || attempt === retries) {
        throw error;
      }
    }
  }
  throw lastError;
}

export function parseMacComputerUseNodes(text: string): MacComputerUseNode[] {
  const nodes: MacComputerUseNode[] = [];
  const nodeLine = /^(\t*)(\d+)\s+(.*)$/;
  for (const line of String(text).split('\n')) {
    const match = nodeLine.exec(line);
    if (!match) continue;
    const rest = match[3] ?? '';
    nodes.push({
      index: Number(match[2] ?? 0),
      depth: (match[1] ?? '').length,
      text: rest,
      value: extractNodeField(rest, 'Value'),
      url: extractNodeField(rest, 'URL'),
    });
  }
  return nodes;
}

export function findMacComputerUseNode(
  nodes: MacComputerUseNode[],
  selector: string | RegExp
): MacComputerUseNode | undefined {
  return nodes.find((node) =>
    typeof selector === 'string'
      ? node.text.includes(selector)
      : selector.test(node.text)
  );
}

export function isStaleMacComputerUseError(error: unknown): boolean {
  const message = formatError(error).toLowerCase();
  return staleMarkers.some((marker) => message.includes(marker));
}

export async function waitForMacComputerUseText(
  app: MacComputerUseApp,
  predicate: (observation: MacComputerUseObservation) => boolean,
  options: { deadlineAt: number; intervalMs?: number }
): Promise<MacComputerUseObservation> {
  let lastObservation: MacComputerUseObservation = { text: '', nodes: [] };
  while (Date.now() < options.deadlineAt) {
    lastObservation = await observeMacComputerUseApp(app);
    if (predicate(lastObservation)) return lastObservation;
    await delay(
      Math.min(
        options.intervalMs ?? 250,
        Math.max(1, options.deadlineAt - Date.now())
      )
    );
  }
  throw new Error(
    `Computer Use timed out waiting for expected Claude UI state: ${lastObservation.text
      .replaceAll(/\s+/g, ' ')
      .slice(0, 500)}`
  );
}

export async function actOnMacComputerUseNode(
  app: MacComputerUseApp,
  selector: string | RegExp,
  action: (node: MacComputerUseNode) => Promise<unknown>,
  options: {
    retries?: number;
    verify?: (observation: MacComputerUseObservation) => boolean;
  } = {}
): Promise<MacComputerUseNode> {
  const retries = options.retries ?? 1;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const observation = await observeMacComputerUseApp(app);
    const node = findMacComputerUseNode(observation.nodes, selector);
    if (!node) {
      lastError = new Error(
        `Computer Use could not find UI node matching ${String(selector)}`
      );
      continue;
    }
    try {
      await action(node);
      if (
        options.verify &&
        !options.verify(await observeMacComputerUseApp(app))
      ) {
        throw new Error(
          `Computer Use post-action verification failed for ${String(selector)}`
        );
      }
      return node;
    } catch (error) {
      lastError = error;
      if (!isStaleMacComputerUseError(error) || attempt === retries)
        throw error;
    }
  }
  throw lastError;
}

function extractNodeField(rest: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|, )${key}: ([^,]+)`).exec(rest);
  return match?.[1]?.trim();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
