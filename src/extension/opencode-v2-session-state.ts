import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { asRecord, type UnknownRecord } from '../shared/type-utils';
import { acquireFileLock } from './file-lock';
import {
  getLegacyVarroStateDirectory,
  getVarroStateDirectory,
  prepareVarroStateDirectory,
} from './varro-state-paths';

/** Varro metadata and fallback state for servers without native archive support. */
export class OpenCodeV2SessionState {
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly legacyDirectory: string | undefined;
  private prepared: Promise<string> | undefined;

  readonly directory: string;

  constructor(directory?: string) {
    this.directory = directory ?? getVarroStateDirectory('opencode-v2');
    this.legacyDirectory =
      directory === undefined ? getLegacyVarroStateDirectory('opencode-v2') : undefined;
  }

  private async prepareDirectory(): Promise<string> {
    this.prepared ??= prepareVarroStateDirectory(this.directory, this.legacyDirectory);
    try {
      return await this.prepared;
    } catch (error) {
      this.prepared = undefined;
      throw error;
    }
  }

  async read(sessionID: string): Promise<UnknownRecord> {
    const path = this.path(sessionID);
    await this.prepareDirectory();
    try {
      return asRecord(JSON.parse(await readFile(path, 'utf8'))) ?? {};
    } catch (error) {
      if (asRecord(error)?.code === 'ENOENT') return {};
      throw new Error('Could not read Varro OpenCode v2 session annotations', { cause: error });
    }
  }

  async update(
    sessionID: string,
    patch: UnknownRecord,
    signal?: AbortSignal,
    onlyIfMissing?: string
  ): Promise<void> {
    signal?.throwIfAborted();
    return this.mutate(
      sessionID,
      async () => {
        signal?.throwIfAborted();
        const current = await this.read(sessionID);
        if (onlyIfMissing !== undefined && Object.hasOwn(current, onlyIfMissing)) return;
        signal?.throwIfAborted();
        const next = {
          ...current,
          ...patch,
          time: { ...asRecord(current.time), ...asRecord(patch.time) },
        };
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const path = this.path(sessionID);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(next), { mode: 0o600, signal });
          signal?.throwIfAborted();
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      signal
    );
  }

  async remove(sessionID: string): Promise<void> {
    return this.mutate(sessionID, () => rm(this.path(sessionID), { force: true }));
  }

  private async mutate(
    sessionID: string,
    run: () => Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    const previous = this.operations.get(sessionID);
    const operation = (async () => {
      // A failed operation must not block a later update or cleanup.
      await previous?.catch(() => {});
      await this.prepareDirectory();
      const release = await acquireFileLock(
        `${this.path(sessionID)}.lock`,
        signal,
        'Timed out waiting to update Varro session annotations'
      );
      try {
        signal?.throwIfAborted();
        await run();
      } finally {
        await release();
      }
    })();
    this.operations.set(sessionID, operation);
    try {
      await operation;
    } finally {
      if (this.operations.get(sessionID) === operation) this.operations.delete(sessionID);
    }
  }

  private path(sessionID: string): string {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(sessionID)) throw new Error('Invalid OpenCode session ID');
    return join(this.directory, `${sessionID}.json`);
  }
}
