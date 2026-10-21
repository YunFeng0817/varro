/* oxlint-disable anti-slop/no-runtime-typeof -- Stored permission observations are validated at this persistence boundary. */
import type { OpenCodeServerMemoryPermission } from '../shared/opencode-types';
import type { Persistence } from '../shared/persistence';
import { asRecord } from '../shared/type-utils';
import { logger } from './logger';

const STORAGE_KEY = 'varro.serverMemoryPermissions';
type Entry = { server: string; rule: OpenCodeServerMemoryPermission };

export class ServerMemoryPermissionStore {
  private readonly entries = new Map<string, Entry>();
  private pendingWrite = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const stored = persistence.get<unknown>(STORAGE_KEY);
    if (!Array.isArray(stored)) return;
    for (const value of stored) {
      const entry = asRecord(value);
      const rule = asRecord(entry?.rule);
      if (
        typeof entry?.server !== 'string' ||
        !entry.server ||
        typeof rule?.id !== 'string' ||
        !rule.id ||
        rule.id.startsWith('legacy:') ||
        typeof rule.projectID !== 'string' ||
        !rule.projectID ||
        typeof rule.permission !== 'string' ||
        typeof rule.pattern !== 'string'
      )
        continue;
      const restored = {
        id: rule.id,
        projectID: rule.projectID,
        permission: rule.permission,
        pattern: rule.pattern,
      };
      this.entries.set(this.key(entry.server, restored), { server: entry.server, rule: restored });
    }
  }

  get(server: string, projectID: string): OpenCodeServerMemoryPermission[] {
    return [...this.entries.values()]
      .filter((entry) => entry.server === server && entry.rule.projectID === projectID)
      .map((entry) => ({ ...entry.rule }));
  }

  async remember(server: string, rules: readonly OpenCodeServerMemoryPermission[]): Promise<void> {
    if (!server || !rules.length) return;
    for (const rule of rules) {
      this.entries.set(this.key(server, rule), { server, rule: { ...rule } });
    }
    if (rules.some((rule) => !rule.id.startsWith('legacy:'))) await this.persist();
  }

  async forget(server: string, rule: OpenCodeServerMemoryPermission): Promise<void> {
    if (this.entries.delete(this.key(server, rule)) && !rule.id.startsWith('legacy:')) {
      await this.persist();
    }
  }

  private key(server: string, rule: OpenCodeServerMemoryPermission): string {
    const identity = rule.id.startsWith('legacy:') ? [rule.permission, rule.pattern] : rule.id;
    return JSON.stringify([server, rule.projectID, identity]);
  }

  private persist(): Promise<void> {
    const snapshot = [...this.entries.values()]
      .filter(({ rule }) => !rule.id.startsWith('legacy:'))
      .map(({ server, rule }) => ({
        server,
        rule: {
          id: rule.id,
          projectID: rule.projectID,
          permission: rule.permission,
          pattern: rule.pattern,
        },
      }));
    this.pendingWrite = this.pendingWrite
      .then(() => this.persistence.set(STORAGE_KEY, snapshot))
      .catch((cause: unknown) => {
        // An acknowledged approval stays successful even if its management cache cannot be saved.
        logger.warn(
          `Could not persist saved-permission observations: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      });
    return this.pendingWrite;
  }
}
