/* oxlint-disable anti-slop/no-module-mocking -- Verify fixture cleanup decisions without signaling real processes. */
import { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeTestCleanup, IsolatedProcessTree } from './isolated-process.test-support';
import { isProcessAlive, readWindowsProcessIdentity, runProcess } from './process-inspection';

vi.mock('./process-inspection', () => ({
  isProcessAlive: vi.fn(),
  readWindowsProcessIdentity: vi.fn(),
  runProcess: vi.fn(),
}));

const platform = process.platform;
const identity = { birthIdentity: 'win32:123', executable: 'C:\\node.exe' };

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  vi.mocked(isProcessAlive).mockReturnValue(true);
  vi.mocked(readWindowsProcessIdentity).mockResolvedValue(identity);
  vi.mocked(runProcess).mockImplementation(async () => {
    vi.mocked(isProcessAlive).mockReturnValue(false);
    return { stdout: '', stderr: '', code: 0 };
  });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.resetAllMocks();
});

describe('isolated fixture cleanup failures', () => {
  it('preserves the scenario failure and attempts every cleanup operation', async () => {
    const scenario = new Error('managed restart failed');
    const cleanup = new Error('ownership lease mismatch');
    const finished = vi.fn();
    const result = completeTestCleanup(
      [
        () => {
          throw cleanup;
        },
        finished,
      ],
      scenario
    );
    await expect(result).rejects.toMatchObject({
      message: 'Isolated fixture cleanup failed after: managed restart failed',
      errors: [scenario, cleanup],
    });
    expect(finished).toHaveBeenCalledOnce();
  });

  it('does not replace a scenario failure when cleanup succeeds', async () => {
    const cleanup = vi.fn();
    await expect(
      completeTestCleanup([cleanup], new Error('scenario failed'))
    ).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe('Windows isolated fixture cleanup', () => {
  it('rechecks a coherent identity before termination and avoids inspection after exit', async () => {
    const child = Object.assign(new ChildProcess(), { pid: 1234 });
    const tree = new IsolatedProcessTree(child);
    await tree.stop();
    expect(readWindowsProcessIdentity).toHaveBeenCalledTimes(2);
    expect(runProcess).toHaveBeenCalledExactlyOnceWith('taskkill.exe', [
      '/PID',
      '1234',
      '/T',
      '/F',
    ]);
    await tree.stop();
    expect(readWindowsProcessIdentity).toHaveBeenCalledTimes(2);
    expect(runProcess).toHaveBeenCalledOnce();
  });

  it('does not inspect or signal an already exited launch during cleanup', async () => {
    const child = Object.assign(new ChildProcess(), { pid: 1234 });
    const tree = new IsolatedProcessTree(child);
    vi.mocked(isProcessAlive).mockReturnValue(false);
    await tree.stop();
    expect(readWindowsProcessIdentity).toHaveBeenCalledOnce();
    expect(runProcess).not.toHaveBeenCalled();
  });

  it.each([
    { ...identity, birthIdentity: 'win32:456' },
    { ...identity, executable: 'C:\\other.exe' },
  ])(
    'does not signal a PID whose identity changed to $birthIdentity / $executable',
    async (changed) => {
      const child = Object.assign(new ChildProcess(), { pid: 1234 });
      const tree = new IsolatedProcessTree(child);
      vi.mocked(readWindowsProcessIdentity).mockResolvedValue(changed);
      await tree.stop();
      expect(runProcess).not.toHaveBeenCalled();
    }
  );

  it('surfaces missing launch evidence without signaling the PID', async () => {
    vi.mocked(readWindowsProcessIdentity).mockResolvedValue({ birthIdentity: '', executable: '' });
    const child = Object.assign(new ChildProcess(), { pid: 1234 });
    const tree = new IsolatedProcessTree(child);
    await expect(tree.stop()).rejects.toThrow('Could not record isolated process identity');
    expect(runProcess).not.toHaveBeenCalled();
  });
});
