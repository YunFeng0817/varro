import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { asRecord } from '../shared/type-utils';

/** Shared native lock format. Reclaim only a verifiably dead process's owner marker. */
export async function acquireFileLock(
  lock: string,
  signal?: AbortSignal,
  timeoutMessage = 'Timed out waiting for Varro state lock'
): Promise<() => Promise<void>> {
  const owner = `${process.pid}-${randomUUID()}`;
  const candidate = `${lock}.${owner}`;
  const deadline = Date.now() + 10_000;
  let contentionError: unknown;
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  while (true) {
    signal?.throwIfAborted();
    let publishing = false;
    try {
      // Publish a nonempty directory atomically, so contenders always see its owner.
      await mkdir(candidate, { mode: 0o700 });
      await writeFile(join(candidate, owner), '', { flag: 'wx', mode: 0o600 });
      publishing = true;
      await rename(candidate, lock);
      return async () => {
        await unlink(join(lock, owner));
        // A contender can replace the empty directory after we remove our owner.
        await removeEmptyLock(lock);
      };
    } catch (error) {
      const code = asRecord(error)?.code;
      if (code === 'EPERM' && publishing) {
        // Windows reports an existing destination directory as EPERM on rename.
        // An unreadable lock must never be treated as an empty one.
        try {
          await readdir(lock);
        } catch (inspectionError) {
          if (!['ENOENT', 'EPERM'].includes(String(asRecord(inspectionError)?.code))) throw error;
        }
      } else if (!['EEXIST', 'ENOTEMPTY'].includes(String(code))) throw error;
      contentionError = error;
    } finally {
      await rm(candidate, { recursive: true, force: true });
    }
    try {
      const owners = await readdir(lock);
      if (owners.length === 0) await removeEmptyLock(lock);
      const oldOwner = owners[0];
      if (owners.length === 1 && oldOwner && /^\d+-[a-f0-9-]{36}$/.test(oldOwner)) {
        const pid = Number(oldOwner.split('-')[0]);
        if (Number.isSafeInteger(pid) && pid > 0 && isDeadProcess(pid)) {
          await unlink(join(lock, oldOwner));
          await removeEmptyLock(lock);
        }
      }
    } catch (error) {
      const code = asRecord(error)?.code;
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes(String(code))) throw error;
      if (code === 'EPERM') contentionError = error;
    }
    if (Date.now() >= deadline) throw new Error(timeoutMessage, { cause: contentionError });
    await delay(25, undefined, { signal });
  }
}

function isDeadProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return asRecord(error)?.code === 'ESRCH';
  }
}

async function removeEmptyLock(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (asRecord(error)?.code === 'EPERM') {
      try {
        if ((await readdir(path)).length > 0) return;
      } catch (inspectionError) {
        if (asRecord(inspectionError)?.code === 'ENOENT') return;
      }
    }
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(asRecord(error)?.code))) throw error;
  }
}
