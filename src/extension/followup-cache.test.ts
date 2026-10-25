import { describe, expect, it } from 'vitest';
import { FollowupCache } from './followup-cache';
import { EMPTY_FOLLOWUP_SUGGESTIONS } from '../shared/followups';

const suggestions = {
  summary: 'The parser still needs a focused regression test.',
  actions: [{ title: 'Add a test', prompt: 'Add a parser regression test.' }],
};

describe('FollowupCache', () => {
  it('admits each turn once, including concurrent claims', async () => {
    const cache = new FollowupCache();
    expect(
      await Promise.all([
        cache.claim('turn', 'digest', 'session'),
        cache.claim('turn', 'digest', 'session'),
      ])
    ).toEqual([true, false]);
    expect(cache.get('turn', 'digest')).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    await cache.complete('turn', 'digest', suggestions);
    expect(cache.get('turn', 'digest')).toEqual(suggestions);
  });

  it('does not resurrect a dismissed card when a pending completion arrives', async () => {
    const cache = new FollowupCache();
    await cache.claim('turn', 'digest', 'session');
    await cache.dismiss('turn', 'digest');
    await cache.complete('turn', 'digest', suggestions);
    expect(cache.get('turn', 'digest')).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(await cache.claim('turn', 'digest', 'session')).toBe(false);
  });

  it('clears old content and pending results while preserving the new turn and other sessions', async () => {
    const cache = new FollowupCache();
    for (const turn of ['old', 'pending', 'new']) await cache.claim(turn, 'digest', 'session');
    await cache.claim('other', 'digest', 'other-session');
    for (const turn of ['old', 'new', 'other']) await cache.complete(turn, 'digest', suggestions);
    await cache.clearSession('session', 'new');
    await cache.complete('pending', 'digest', suggestions);
    expect(cache.get('old', 'digest')).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(cache.get('pending', 'digest')).toEqual(EMPTY_FOLLOWUP_SUGGESTIONS);
    expect(cache.get('new', 'digest')).toEqual(suggestions);
    expect(cache.get('other', 'digest')).toEqual(suggestions);
    expect(await cache.claim('old', 'digest', 'session')).toBe(false);
    expect(await cache.claim('next', 'digest', 'session')).toBe(true);
  });
});
