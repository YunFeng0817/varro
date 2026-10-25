import type { Persistence } from '../shared/persistence';
import type { FollowupSuggestionSet } from '../shared/followups';
import { EMPTY_FOLLOWUP_SUGGESTIONS, parseFollowupSuggestions } from '../shared/followups';
import { asRecord, isString } from '../shared/type-utils';

const STORAGE_KEY = 'varro.followupCache.v1';
const MAX_TURNS = 512;
type Entry = {
  sessionKey: string;
  digest: string;
  dismissed: boolean;
  suggestions: FollowupSuggestionSet;
};
type Entries = Record<string, Entry>;

/** Host-owned cache. Attempts, abstentions, failures, and dismissals never expire on a timer. */
export class FollowupCache {
  private memory: Entries = {};
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence?: Persistence) {}

  get(key: string, digest: string): FollowupSuggestionSet | undefined {
    const entry = this.read()[key];
    if (!entry) return undefined;
    return entry.digest === digest && !entry.dismissed
      ? entry.suggestions
      : EMPTY_FOLLOWUP_SUGGESTIONS;
  }

  async claim(key: string, digest: string, sessionKey: string): Promise<boolean> {
    let claimed = false;
    await this.change((entries) => {
      if (entries[key]) return false;
      entries[key] = {
        sessionKey,
        digest,
        dismissed: false,
        suggestions: EMPTY_FOLLOWUP_SUGGESTIONS,
      };
      claimed = true;
      return true;
    });
    return claimed;
  }

  complete(key: string, digest: string, suggestions: FollowupSuggestionSet): Promise<void> {
    return this.change((entries) => {
      const entry = entries[key];
      if (!entry || entry.digest !== digest || entry.dismissed) return false;
      entry.suggestions = suggestions;
      return true;
    });
  }

  dismiss(key: string, digest: string): Promise<void> {
    return this.change((entries) => {
      const entry = entries[key];
      if (!entry || entry.digest !== digest || entry.dismissed) return false;
      entry.dismissed = true;
      entry.suggestions = EMPTY_FOLLOWUP_SUGGESTIONS;
      return true;
    });
  }

  clearSession(sessionKey: string, exceptKey?: string): Promise<void> {
    return this.change((entries) => {
      let changed = false;
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.sessionKey !== sessionKey || key === exceptKey || entry.dismissed) continue;
        entry.dismissed = true;
        entry.suggestions = EMPTY_FOLLOWUP_SUGGESTIONS;
        changed = true;
      }
      return changed;
    });
  }

  private change(update: (entries: Entries) => boolean): Promise<void> {
    const result = this.queue.then(async () => {
      const entries = this.read();
      if (!update(entries)) return;
      const bounded = Object.fromEntries(Object.entries(entries).slice(-MAX_TURNS));
      if (this.persistence) await this.persistence.set(STORAGE_KEY, bounded);
      else this.memory = bounded;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private read() {
    if (!this.persistence) return structuredClone(this.memory);
    const stored = asRecord(this.persistence.get<unknown>(STORAGE_KEY));
    const entries: Entries = {};
    for (const [key, value] of Object.entries(stored ?? {}).slice(-MAX_TURNS)) {
      const entry = asRecord(value);
      if (
        !/^[a-f0-9]{64}$/.test(key) ||
        !isString(entry?.digest) ||
        !/^[a-f0-9]{64}$/.test(entry.digest) ||
        !isString(entry.sessionKey) ||
        !/^[a-f0-9]{64}$/.test(entry.sessionKey)
      )
        continue;
      try {
        entries[key] = {
          sessionKey: entry.sessionKey,
          digest: entry.digest,
          dismissed: entry.dismissed === true,
          suggestions: parseFollowupSuggestions(JSON.stringify(entry.suggestions)),
        };
      } catch {
        // Corrupt presentation must not erase the admission and allow another billed attempt.
        entries[key] = {
          sessionKey: entry.sessionKey,
          digest: entry.digest,
          dismissed: true,
          suggestions: EMPTY_FOLLOWUP_SUGGESTIONS,
        };
      }
    }
    return entries;
  }
}
