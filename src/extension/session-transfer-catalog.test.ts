/* oxlint-disable anti-slop/no-unknown-parameters -- This persistence fixture owns opaque serialized values. */
import { describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { fixture } from '../webview/test-fixtures';
import { SessionTransferCatalog } from './session-transfer-catalog';

const moved = {
  id: 'session-1',
  projectID: 'project-1',
  directory: '/outside',
  title: 'Transferred conversation',
  version: '2',
  time: { created: 1, updated: 2 },
};

function createStorage() {
  let stored: unknown;
  const persistence = fixture<Persistence>({
    get: () => structuredClone(stored),
    set: vi.fn((_key: string, value: unknown) => {
      stored = structuredClone(value);
    }),
    remove: vi.fn(),
  });
  return persistence;
}

describe('session transfer catalog', () => {
  it('retains an origin link across reloads without storing transcripts or permissions', async () => {
    const persistence = createStorage();
    const catalog = new SessionTransferCatalog(persistence);
    await catalog.remember(
      'server-a',
      { ...moved, permission: [{ secret: true }], metadata: { secret: true } },
      '/repo',
      ['/repo']
    );
    const restored = new SessionTransferCatalog(persistence);
    expect(restored.list('server-a', ['/repo'])).toEqual([
      { ...moved, transfer: { originDirectory: '/repo', available: false } },
    ]);
    expect(restored.list('server-a', ['/other'])).toEqual([]);
    expect(restored.list('server-b', ['/repo'])).toEqual([]);
    expect(restored.get('server-a', ['/repo'], moved.id)?.directory).toBe('/outside');
  });

  it('preserves the original project through repeated moves and removes deleted links', async () => {
    const persistence = createStorage();
    const catalog = new SessionTransferCatalog(persistence);
    await catalog.remember('server-a', moved, '/repo', ['/repo']);
    await catalog.remember('server-a', { ...moved, directory: '/final' }, '/outside', ['/outside']);
    expect(catalog.list('server-a', ['/repo'])).toHaveLength(1);
    expect(catalog.list('server-a', ['/repo'])[0]?.transfer?.originDirectory).toBe('/repo');
    await catalog.remove('server-a', moved.id);
    expect(new SessionTransferCatalog(persistence).list('server-a', ['/repo'])).toEqual([]);
  });

  it('ignores malformed and archived canonical session summaries', async () => {
    const catalog = new SessionTransferCatalog(createStorage());
    for (const value of [
      null,
      { id: 'session-1' },
      { ...moved, time: { created: 1, updated: 2, archived: 3 } },
    ])
      await catalog.remember('server-a', value, '/repo', ['/repo']);
    expect(catalog.list('server-a', ['/repo'])).toEqual([]);
  });

  it('persists hiding only the selected origin while preserving history access and other origins', async () => {
    const persistence = createStorage();
    const catalog = new SessionTransferCatalog(persistence);
    await catalog.remember('server-a', moved, '/repo', ['/repo', '/other']);
    expect(await catalog.hide('server-a', ['/repo/'], moved.id)).toBe(true);

    const restored = new SessionTransferCatalog(persistence);
    expect(restored.list('server-a', ['/repo'])).toEqual([]);
    expect(restored.get('server-a', ['/repo'], moved.id)?.directory).toBe('/outside');
    expect(restored.list('server-a', ['/repo'], { includeHidden: true })[0]?.transfer).toEqual({
      originDirectory: '/repo',
      available: false,
      hidden: true,
      hiddenOrigins: ['/repo'],
    });
    expect(restored.list('server-a', ['/other'])[0]?.transfer?.hidden).toBeUndefined();
    expect(restored.list('server-a', ['/repo', '/other'])[0]?.transfer?.hidden).toBeUndefined();
    expect(
      restored.list('server-a', ['/repo', '/outside'], { includeHidden: true })[0]?.transfer
    ).toEqual({
      originDirectory: '/repo',
      available: true,
      hiddenOrigins: ['/repo'],
    });

    await restored.remember('server-a', { ...moved, directory: '/final' }, '/repo', ['/repo']);
    expect(new SessionTransferCatalog(persistence).list('server-a', ['/repo'])).toEqual([]);
    expect(restored.list('server-a', ['/other'])[0]?.directory).toBe('/final');
  });

  it('does not hide a destination, foreign server, unrelated origin, or unknown session', async () => {
    const persistence = createStorage();
    const catalog = new SessionTransferCatalog(persistence);
    await catalog.remember('server-a', moved, '/repo', ['/repo', '/outside']);
    vi.mocked(persistence.set).mockClear();
    expect(await catalog.hide('server-a', ['/outside'], moved.id)).toBe(false);
    expect(await catalog.hide('server-b', ['/repo'], moved.id)).toBe(false);
    expect(await catalog.hide('server-a', ['/unrelated'], moved.id)).toBe(false);
    expect(await catalog.hide('server-a', ['/repo'], 'unknown')).toBe(false);
    expect(persistence.set).not.toHaveBeenCalled();
    expect(catalog.list('server-a', ['/repo'])).toHaveLength(1);
  });

  it('keeps a link visible when saving the hide preference fails', async () => {
    const persistence = createStorage();
    const catalog = new SessionTransferCatalog(persistence);
    await catalog.remember('server-a', moved, '/repo', ['/repo']);
    vi.mocked(persistence.set).mockRejectedValueOnce(new Error('Storage unavailable'));
    await expect(catalog.hide('server-a', ['/repo'], moved.id)).rejects.toThrow(
      'Storage unavailable'
    );
    expect(catalog.list('server-a', ['/repo'])).toHaveLength(1);
    expect(new SessionTransferCatalog(persistence).list('server-a', ['/repo'])).toHaveLength(1);
  });
});
