/* oxlint-disable anti-slop/no-module-mocking -- Wire fixtures exercise the real adapter and annotation store. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SessionInfo } from '@opencode/client';
import { asRecord } from '../shared/type-utils';
import { OpenCodeV2Adapter } from './opencode-v2-adapter';
import { OpenCodeV2SessionState } from './opencode-v2-session-state';
import { projectV2Event } from './opencode-v2-events';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const nativeApi = {
  paths: {
    '/api/session/{sessionID}': {
      patch: {
        requestBody: {
          content: {
            'application/json': { schema: { properties: { archived: { type: 'boolean' } } } },
          },
        },
      },
    },
  },
};
const session: SessionInfo = {
  id: 'ses_archive',
  projectID: 'project',
  title: 'Archive fixture',
  location: { directory: '/repo' },
  time: { created: 1, updated: 2 },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};
let directory: string;
let annotations: OpenCodeV2SessionState;

beforeEach(async () => {
  const parent = resolve('artifacts/ai-test-data');
  await mkdir(parent, { recursive: true });
  directory = await mkdtemp(join(parent, 'archive-adapter-'));
  annotations = new OpenCodeV2SessionState(directory);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('backward-compatible native session archiving', () => {
  it('archives and restores with the native boolean API and confirmed timestamps', async () => {
    let current = session;
    const wire = vi.fn(async <T>(method: string, path: string, body?: T) => {
      if (path === '/openapi.json') return nativeApi;
      if (method === 'PATCH') {
        const time: SessionInfo['time'] = { ...session.time, updated: 30 };
        if (asRecord(body)?.archived) time.archived = 30;
        current = { ...session, time };
        return undefined;
      }
      return { data: current };
    });
    const adapter = new OpenCodeV2Adapter(wire, annotations);
    expect(
      await adapter.request('PATCH', '/session/ses_archive', { time: { archived: 10 } })
    ).toMatchObject({ time: { archived: 30, updated: 30 } });
    expect(wire).toHaveBeenCalledWith(
      'PATCH',
      '/api/session/ses_archive',
      expect.objectContaining({ archived: true }),
      expect.anything()
    );
    const restored = await adapter.request('PATCH', '/session/ses_archive', {
      time: { archived: null },
    });
    expect(restored).toMatchObject({
      time: { created: 1, updated: 30 },
    });
    expect(asRecord(restored)?.time).not.toHaveProperty('archived');
    expect(wire).toHaveBeenCalledWith(
      'PATCH',
      '/api/session/ses_archive',
      expect.objectContaining({ archived: false }),
      expect.anything()
    );
    expect(await annotations.read(session.id)).toEqual({});
    expect(wire.mock.calls.filter(([, path]) => path === '/openapi.json')).toHaveLength(1);
  });

  it('keeps local archive writes and restoration on older servers', async () => {
    const wire = vi.fn(async (_method: string, path: string) =>
      path === '/openapi.json' ? { paths: {} } : { data: session }
    );
    const adapter = new OpenCodeV2Adapter(wire, annotations);
    expect(
      await adapter.request('PATCH', '/session/ses_archive', { time: { archived: 10 } })
    ).toMatchObject({ time: { archived: 10 } });
    expect(await annotations.read(session.id)).toMatchObject({ time: { archived: 10 } });
    expect(
      await adapter.request('PATCH', '/session/ses_archive', { time: { archived: null } })
    ).toMatchObject({ time: { archived: null } });
    expect(wire.mock.calls.some(([method]) => method === 'PATCH')).toBe(false);
  });

  it('retains the legacy fallback when an older server has no OpenAPI route', async () => {
    const wire = vi.fn(async (_method: string, path: string) => {
      if (path === '/openapi.json') throw new Error('404 Not Found');
      return { data: session };
    });
    const adapter = new OpenCodeV2Adapter(wire, annotations);
    await adapter.request('PATCH', '/session/ses_archive', { time: { archived: 10 } });
    expect(await adapter.request('GET', '/session/ses_archive', undefined)).toMatchObject({
      time: { archived: 10 },
    });
    expect(wire.mock.calls.filter(([, path]) => path === '/openapi.json')).toHaveLength(1);
    expect(wire.mock.calls.some(([method]) => method === 'PATCH')).toBe(false);
  });

  it('does not probe optional capabilities while reading ordinary unannotated sessions', async () => {
    const wire = vi.fn(async () => ({ data: session }));
    const adapter = new OpenCodeV2Adapter(wire, annotations);
    await adapter.request('GET', '/session/ses_archive', undefined);
    expect(wire.mock.calls).toHaveLength(1);
  });

  it('rejects a malformed capability response without changing local archives', async () => {
    const adapter = new OpenCodeV2Adapter(async () => ({ data: session }), annotations);
    await expect(
      adapter.request('PATCH', '/session/ses_archive', { time: { archived: 10 } })
    ).rejects.toThrow('Invalid OpenCode API capability response');
    expect(await annotations.read(session.id)).toEqual({});
  });

  it.each([undefined, 50])(
    'makes native archive state authoritative over retained local annotations: %s',
    async (archived) => {
      await annotations.update(session.id, {
        time: { archived: 10 },
        metadata: { varro: { permissionMode: 'auto' } },
      });
      const time: SessionInfo['time'] = { ...session.time };
      if (archived !== undefined) time.archived = archived;
      const current = { ...session, time };
      const wire = vi.fn(async (_method: string, path: string) =>
        path === '/openapi.json' ? nativeApi : { data: current }
      );
      const adapter = new OpenCodeV2Adapter(wire, annotations);
      const projected = await adapter.request('GET', '/session/ses_archive', undefined);
      expect(projected).toMatchObject({ metadata: { varro: { permissionMode: 'auto' } } });
      expect(asRecord(asRecord(projected)?.time)?.archived).toBe(archived);
      expect(await annotations.read(session.id)).toMatchObject({ time: { archived: 10 } });
      expect(wire.mock.calls.every(([method]) => method === 'GET')).toBe(true);
    }
  );

  it.each(['401 Unauthorized', '503 unavailable', 'network failed'])(
    'does not fall back to local writes after discovery failure: %s',
    async (message) => {
      const wire = vi.fn(async () => {
        throw new Error(message);
      });
      const adapter = new OpenCodeV2Adapter(wire, annotations);
      await expect(
        adapter.request('PATCH', '/session/ses_archive', { time: { archived: 10 } })
      ).rejects.toThrow(message);
      expect(await annotations.read(session.id)).toEqual({});
    }
  );

  it('does not save local archive or metadata changes after a failed native update', async () => {
    const adapter = new OpenCodeV2Adapter(async (method, path) => {
      if (path === '/openapi.json') return nativeApi;
      if (method === 'PATCH') throw new Error('503 unavailable');
      return { data: session };
    }, annotations);
    await expect(
      adapter.request('PATCH', '/session/ses_archive', {
        time: { archived: 10 },
        metadata: { test: true },
      })
    ).rejects.toThrow('503');
    expect(await annotations.read(session.id)).toEqual({});
  });

  it('rediscovers archive support after a new event connection', async () => {
    let spec = { paths: {} };
    const wire = vi.fn(async (_method: string, path: string) =>
      path === '/openapi.json' ? spec : { data: session }
    );
    const adapter = new OpenCodeV2Adapter(wire, annotations);
    await adapter.request('PATCH', '/session/ses_archive', { time: { archived: 10 } });
    spec = nativeApi;
    adapter.observe('server.connected', {});
    await adapter.request('PATCH', '/session/ses_archive', { time: { archived: null } });
    expect(wire).toHaveBeenCalledWith(
      'PATCH',
      '/api/session/ses_archive',
      expect.objectContaining({ archived: false }),
      expect.anything()
    );
  });

  it('preserves include-archived list semantics without forwarding the native archived-only filter', async () => {
    const archived = { ...session, id: 'ses_other', time: { ...session.time, archived: 10 } };
    const wire = vi.fn(async () => ({ data: [session, archived] }));
    const adapter = new OpenCodeV2Adapter(wire, annotations);
    expect(
      await adapter.request('GET', '/experimental/session?archived=true&limit=1000', undefined)
    ).toHaveLength(2);
    expect(wire).toHaveBeenCalledWith(
      'GET',
      '/api/session?limit=1000',
      undefined,
      expect.anything()
    );
  });

  it.each(['session.archived', 'session.unarchived'])(
    'preserves native archive event identity and sequence: %s',
    (type) => {
      expect(
        projectV2Event({
          id: 'evt_archive',
          type,
          created: 30,
          durable: { seq: 12 },
          location: { directory: '/repo' },
          data: { sessionID: session.id },
        })
      ).toMatchObject([
        {
          id: 'evt_archive',
          type,
          seq: 12,
          workspaceDirectory: '/repo',
          properties: { sessionID: session.id },
        },
      ]);
    }
  );
});
