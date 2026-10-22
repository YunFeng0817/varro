import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  findListeningPids,
  isProcessAlive,
  isProcessOrDescendant,
  readProcessBirthIdentity,
  readProcessExecutable,
  readProcessGroupId,
  readWindowsProcessIdentity,
  runProcess,
} from './process-inspection';

type ProcessIdentity = { pid: number; birth: string; executable: string };

/** Attempt every resource cleanup, even when an earlier disposal or evidence write fails. */
export async function completeTestCleanup(
  operations: Array<() => void | Promise<void>>,
  primaryFailure?: Error
): Promise<void> {
  const failures: unknown[] = [];
  for (const operation of operations) {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(
      primaryFailure ? [primaryFailure, ...failures] : failures,
      primaryFailure
        ? `Isolated fixture cleanup failed after: ${primaryFailure.message}`
        : 'Isolated fixture cleanup failed'
    );
}

/** The fixture owns these launches, independently of the simulated editor's lease. */
export class IsolatedProcessTree {
  private readonly identities = new Map<number, ProcessIdentity>();
  private readonly launchIdentity: Promise<void>;

  constructor(private readonly child: ChildProcess) {
    this.launchIdentity = child.pid ? this.remember(child.pid) : Promise.resolve();
    // stop/capture still surface inspection failure, including launches that fail early.
    void this.launchIdentity.catch(() => {});
  }

  async captureListener(port: number): Promise<void> {
    await this.launchIdentity;
    const listeners = await findListeningPids(port);
    for (const pid of listeners) {
      if (!this.child.pid || !(await isProcessOrDescendant(pid, this.child.pid)))
        throw new Error(`Fixture listener ${pid} on port ${port} is not a child of its launch`);
      await this.remember(pid);
    }
    if (listeners.length !== 1) throw new Error(`Expected one fixture listener on port ${port}`);
  }

  private async remember(pid: number): Promise<void> {
    if (process.platform === 'win32') {
      // Keep birth and executable in one verified snapshot, including the CIM fallback.
      const { birthIdentity: birth, executable } = await readWindowsProcessIdentity(pid);
      if (!birth || !executable)
        throw new Error(`Could not record isolated process identity for ${pid}`);
      this.identities.set(pid, { pid, birth, executable });
      return;
    }
    const birth = await readProcessBirthIdentity(pid);
    const executable = await readProcessExecutable(pid);
    if (!birth || !executable || (await readProcessBirthIdentity(pid)) !== birth)
      throw new Error(`Could not record isolated process identity for ${pid}`);
    this.identities.set(pid, { pid, birth, executable });
  }

  private async matches(identity: ProcessIdentity): Promise<boolean> {
    // A confirmed exit needs no CIM fallback. In particular, repeated cleanup must
    // not start PowerShell to inspect processes that this fixture already stopped.
    if (!isProcessAlive(identity.pid)) return false;
    if (process.platform === 'win32') {
      const current = await readWindowsProcessIdentity(identity.pid);
      return current.birthIdentity === identity.birth && current.executable === identity.executable;
    }
    return (
      (await readProcessBirthIdentity(identity.pid)) === identity.birth &&
      (await readProcessExecutable(identity.pid)) === identity.executable &&
      (await readProcessBirthIdentity(identity.pid)) === identity.birth
    );
  }

  async stop(): Promise<void> {
    await this.launchIdentity;
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      for (const identity of this.identities.values()) {
        if (!(await this.matches(identity))) continue;
        if (process.platform === 'win32') {
          const result = await runProcess('taskkill.exe', [
            '/PID',
            String(identity.pid),
            '/T',
            '/F',
          ]);
          if (result.code !== 0 && (await this.matches(identity)))
            throw new Error(
              `Could not stop isolated process tree ${identity.pid}: ${result.stderr}`
            );
        } else {
          // Only signal the detached launch group while a recorded member still belongs to it.
          const group = await readProcessGroupId(identity.pid);
          const target = group === this.child.pid ? -group : identity.pid;
          if (!(await this.matches(identity))) continue;
          try {
            process.kill(target, signal);
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
              throw error;
          }
        }
      }
      const deadline = Date.now() + 3000;
      do {
        const alive = await Promise.all(
          [...this.identities.values()].map((value) => this.matches(value))
        );
        if (alive.every((value) => !value)) return;
        await delay(50);
      } while (Date.now() < deadline);
    }
    throw new Error(`Isolated process tree ${this.child.pid} survived teardown`);
  }
}
