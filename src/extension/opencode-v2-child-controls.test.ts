/* oxlint-disable anti-slop/no-module-mocking -- Adapter wire fixtures have no VS Code output channel. */
import { describe, expect, it, vi } from 'vitest';
import { OpenCodeV2Adapter } from './opencode-v2-adapter';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const spec = {
  paths: {
    '/api/session/{sessionID}/interrupt': {
      post: {
        operationId: 'session.interrupt',
        parameters: [
          { name: 'resume', in: 'query', schema: { anyOf: [{ enum: ['true', 'false'] }] } },
        ],
      },
    },
    '/api/session/{sessionID}/background': { post: { operationId: 'session.background' } },
  },
};

function fixture(
  options: {
    interrupted?: boolean;
    eligible?: boolean;
    handedOff?: boolean;
    parent?: string;
    directory?: string;
    supported?: boolean;
    omitProgress?: boolean;
    handoffInInbox?: boolean;
  } = {}
) {
  let handedOff = false;
  const wire = vi.fn(async (method: string, path: string) => {
    if (path === '/openapi.json') return options.supported === false ? { paths: {} } : spec;
    if (path.endsWith('/interrupt?resume=false'))
      return { interrupted: options.interrupted ?? true };
    if (path.endsWith('/background')) {
      handedOff = options.handedOff ?? true;
      return undefined;
    }
    if (path.endsWith('/inbox'))
      return {
        data:
          handedOff && options.handoffInInbox
            ? [
                {
                  id: 'msg_handoff',
                  type: 'synthetic',
                  payload: {
                    text: 'User requested that active blocking work be moved to the background.\n\nBackgrounded work:',
                  },
                },
              ]
            : [],
      };
    if (path.includes('/message?'))
      return {
        data: [
          ...(handedOff && !options.handoffInInbox
            ? [
                {
                  id: 'msg_handoff',
                  type: 'synthetic',
                  text: 'User requested that active blocking work be moved to the background.\n\nBackgrounded work:',
                },
              ]
            : []),
          {
            id: 'msg_assistant',
            type: 'assistant',
            content: [
              {
                type: 'tool',
                id: 'call_child',
                name: 'subagent',
                state: {
                  status: 'running',
                  input: { background: options.eligible === false },
                  metadata: options.omitProgress ? {} : { sessionID: 'child-a', status: 'running' },
                },
              },
            ],
          },
        ],
      };
    if (method === 'GET' && path === '/api/session/child-a')
      return {
        data: {
          id: 'child-a',
          parentID: options.parent ?? 'root',
          location: { directory: '/repo' },
        },
      };
    if (method === 'GET' && path === `/api/session/${options.parent ?? 'root'}`)
      return {
        data: {
          id: 'root',
          location: { directory: options.directory ?? '/repo' },
        },
      };
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  return { wire, adapter: new OpenCodeV2Adapter(wire) };
}

describe('native child task controls', () => {
  it('does not mutate after reset supersedes native ancestry/capability reads', async () => {
    const { adapter, wire } = fixture();
    const original = wire.getMockImplementation();
    if (!original) throw new Error('Missing wire fixture');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    wire.mockImplementation(async (method, path) => {
      const result = await original(method, path);
      if (path === '/openapi.json') await gate;
      return result;
    });
    const stop = adapter.request('POST', '/session/child-a/interrupt-child', undefined);
    await vi.waitFor(() =>
      expect(wire.mock.calls.some(([, path]) => path === '/openapi.json')).toBe(true)
    );
    adapter.reset();
    release();
    await expect(stop).rejects.toThrow('Connection changed');
    expect(wire.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });
  it('recognizes native handoff admission before its guidance is projected into history', async () => {
    const { adapter } = fixture({ handoffInInbox: true });
    expect(await adapter.request('POST', '/session/child-a/background-parent', undefined)).toEqual({
      backgrounded: true,
    });
  });
  it('requires current native progress when saved running-tool metadata is absent', async () => {
    const { adapter } = fixture({ omitProgress: true });
    const read = () => adapter.request('GET', '/session/child-a/child-task-controls', undefined);
    expect(await read()).toMatchObject({ backgroundEligible: false });
    const event = {
      sessionID: 'root',
      assistantMessageID: 'msg_assistant',
      id: 'call_child',
      metadata: { sessionID: 'child-a', status: 'running' },
    };
    adapter.observe('session.tool.progress', { ...event, assistantMessageID: 'old_message' });
    expect(await read()).toMatchObject({ backgroundEligible: false });
    adapter.observe('session.tool.progress', event);
    expect(await read()).toMatchObject({ backgroundEligible: true });
    adapter.observe('session.tool.success', event);
    expect(await read()).toMatchObject({ backgroundEligible: false });
    adapter.observe('session.tool.progress', event);
    adapter.reset();
    expect(await read()).toMatchObject({ backgroundEligible: false });
  });
  it.each([true, false])(
    'preserves native interrupted=%s and never targets parent/sibling/grandchild',
    async (interrupted) => {
      const { adapter, wire } = fixture({ interrupted });
      expect(await adapter.request('POST', '/session/child-a/interrupt-child', undefined)).toEqual({
        interrupted,
      });
      expect(
        wire.mock.calls.filter(([method]) => method !== 'GET').map(([, path]) => path)
      ).toEqual(['/api/session/child-a/interrupt?resume=false']);
    }
  );
  it('does not replace unavailable child interruption with root abort', async () => {
    const { adapter, wire } = fixture({ supported: false });
    await expect(
      adapter.request('POST', '/session/child-a/interrupt-child', undefined)
    ).rejects.toThrow('unavailable');
    expect(wire.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });
  it('rejects cross-directory native ancestry', async () => {
    const { adapter, wire } = fixture({ directory: '/foreign' });
    await expect(
      adapter.request('POST', '/session/child-a/interrupt-child', undefined)
    ).rejects.toThrow('same directory');
    expect(wire.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });
  it.each([true, false])(
    'reports native handoff evidence=%s without synthesizing input',
    async (handedOff) => {
      const { adapter, wire } = fixture({ handedOff });
      expect(
        await adapter.request('POST', '/session/child-a/background-parent', undefined)
      ).toEqual({ backgrounded: handedOff });
      expect(
        wire.mock.calls.filter(([method]) => method !== 'GET').map(([, path]) => path)
      ).toEqual(['/api/session/root/background']);
    }
  );
  it('hides and rejects ineligible background work', async () => {
    const { adapter, wire } = fixture({ eligible: false });
    expect(
      await adapter.request('GET', '/session/child-a/child-task-controls', undefined)
    ).toMatchObject({ stopChild: true, backgroundEligible: false });
    await expect(
      adapter.request('POST', '/session/child-a/background-parent', undefined)
    ).rejects.toThrow('eligible');
    expect(wire.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });
  it('rejects a supplied tree or alternate scope', async () => {
    const { adapter, wire } = fixture();
    await expect(
      adapter.request('POST', '/session/child-a/interrupt-child', { tree: ['root'] })
    ).rejects.toThrow('body');
    expect(wire).not.toHaveBeenCalled();
  });
});
