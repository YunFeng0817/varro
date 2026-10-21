/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-module-mocking -- The storage fixture owns opaque serialized values; the logger mock isolates VS Code output channels. */
import { describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { fixture } from '../webview/test-fixtures';
import { ServerMemoryPermissionStore } from './server-memory-permission-store';
import { logger } from './logger';

vi.mock('./logger', () => ({ logger: { warn: vi.fn() } }));

function storage(initial?: unknown) {
  let stored = initial;
  return fixture<Persistence>({
    get: () => structuredClone(stored),
    set: vi.fn((_key: string, value: unknown) => {
      stored = structuredClone(value);
    }),
    remove: vi.fn(),
  });
}

const rule = { id: 'saved-1', projectID: 'project-1', permission: 'bash', pattern: 'git status *' };

describe('saved permission observations', () => {
  it('keeps acknowledged rules manageable after a storage failure and retries the next write', async () => {
    const persistence = storage();
    const set = vi.spyOn(persistence, 'set');
    set.mockRejectedValueOnce(new Error('disk unavailable'));
    const store = new ServerMemoryPermissionStore(persistence);
    await expect(store.remember('server', [rule])).resolves.toBeUndefined();
    expect(store.get('server', 'project-1')).toEqual([rule]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk unavailable'));
    await store.remember('server', [rule]);
    expect(new ServerMemoryPermissionStore(persistence).get('server', 'project-1')).toEqual([rule]);
  });

  it('restores only native observations within their server and project', async () => {
    const persistence = storage();
    const store = new ServerMemoryPermissionStore(persistence);
    await store.remember('2:http://localhost:1234', [
      { ...rule, editable: true },
      { ...rule, id: 'legacy:perm-2:0', pattern: 'npm *', retractable: false },
    ]);
    expect(store.get('2:http://localhost:1234', 'project-1')).toHaveLength(2);
    const restored = new ServerMemoryPermissionStore(persistence);
    expect(restored.get('2:http://localhost:1234', 'project-1')).toEqual([rule]);
    expect(restored.get('2:http://localhost:4321', 'project-1')).toEqual([]);
    expect(restored.get('1:http://localhost:1234', 'project-1')).toEqual([]);
    expect(restored.get('2:http://localhost:1234', 'project-2')).toEqual([]);
  });

  it('replaces an edited native ID and persists retraction across host recreation', async () => {
    const persistence = storage();
    const store = new ServerMemoryPermissionStore(persistence);
    await store.remember('server', [rule]);
    await store.remember('server', [{ ...rule, permission: 'read', pattern: 'README.md' }]);
    const restored = new ServerMemoryPermissionStore(persistence);
    expect(restored.get('server', 'project-1')).toEqual([
      { ...rule, permission: 'read', pattern: 'README.md' },
    ]);
    await restored.forget('server', rule);
    expect(new ServerMemoryPermissionStore(persistence).get('server', 'project-1')).toEqual([]);
  });

  it('rejects malformed storage and never restores legacy allowances', () => {
    for (const value of [
      null,
      {},
      [
        null,
        { server: 'server', rule: {} },
        { server: 'server', rule: { ...rule, id: 'legacy:perm:0' } },
      ],
    ]) {
      expect(new ServerMemoryPermissionStore(storage(value)).get('server', 'project-1')).toEqual(
        []
      );
    }
  });
});
