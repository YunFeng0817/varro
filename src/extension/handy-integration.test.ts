/* oxlint-disable anti-slop/no-module-mocking -- Discovery and CLI activation must not touch installed apps during unit tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecFileOptions } from 'node:child_process';
import { delimiter, join } from 'node:path';

interface HandyTestEnvironment {
  remoteName: string | undefined;
}

const mocks = vi.hoisted(() => {
  const env: HandyTestEnvironment = { remoteName: undefined };
  return {
    runFile:
      vi.fn<
        (
          file: string,
          args: string[],
          options: ExecFileOptions
        ) => Promise<{ stdout: string; stderr: string }>
      >(),
    stat: vi.fn(),
    access: vi.fn(),
    get: vi.fn(),
    env,
  };
});
vi.mock('node:child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.runFile }),
}));
vi.mock('node:fs/promises', () => ({ stat: mocks.stat, access: mocks.access }));
vi.mock('vscode', () => ({
  env: mocks.env,
  workspace: { getConfiguration: () => ({ get: mocks.get }) },
}));

import { HandyIntegration } from './handy-integration';

const originalPlatform = process.platform;
const originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid');
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'getuid', { value: () => 501, configurable: true });
  mocks.env.remoteName = undefined;
  mocks.get.mockReturnValue('');
  mocks.stat.mockResolvedValue({ isFile: () => true });
  mocks.access.mockResolvedValue(undefined);
  mocks.runFile.mockResolvedValue({ stdout: '123\n', stderr: '' });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  if (originalGetuid) Object.defineProperty(process, 'getuid', originalGetuid);
  else Reflect.deleteProperty(process, 'getuid');
  vi.unstubAllEnvs();
});

describe('HandyIntegration', () => {
  it('never discovers or activates on a remote host', async () => {
    mocks.env.remoteName = 'ssh-remote';
    expect(await new HandyIntegration().request('toggle')).toEqual({
      available: false,
      running: false,
    });
    expect(mocks.stat).not.toHaveBeenCalled();
    expect(mocks.runFile).not.toHaveBeenCalled();
  });

  it('discovers a macOS bundle and inspects processes without launching Handy', async () => {
    expect(await new HandyIntegration().request('status')).toEqual({
      available: true,
      running: true,
    });
    expect(mocks.stat).toHaveBeenCalledWith('/Applications/Handy.app/Contents/MacOS/Handy');
    expect(mocks.runFile).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/pgrep',
      ['-u', String(process.getuid!()), '-x', 'Handy|handy'],
      expect.objectContaining({ timeout: 2000 })
    );
  });

  it('does not run commands when Handy is missing or stopped', async () => {
    mocks.stat.mockRejectedValue(new Error('missing'));
    expect(await new HandyIntegration().request('toggle')).toEqual({
      available: false,
      running: false,
    });
    expect(mocks.runFile).not.toHaveBeenCalled();
    mocks.stat.mockResolvedValue({ isFile: () => true });
    mocks.runFile.mockRejectedValue(Object.assign(new Error('no match'), { code: 1 }));
    expect(await new HandyIntegration().request('toggle')).toEqual({
      available: true,
      running: false,
      error: expect.stringContaining('Start Handy'),
    });
    expect(mocks.runFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['toggle', '--toggle-transcription'],
    ['cancel', '--cancel'],
  ] as const)('invokes %s with fixed arguments and a bound', async (action, flag) => {
    expect(await new HandyIntegration().request(action)).toEqual({
      available: true,
      running: true,
    });
    expect(mocks.runFile).toHaveBeenLastCalledWith(
      '/Applications/Handy.app/Contents/MacOS/Handy',
      [flag],
      { timeout: 2000, maxBuffer: 65536, windowsHide: true }
    );
  });

  it('uses a configured executable without interpreting shell syntax', async () => {
    const path = '/custom/Handy with spaces;safe';
    mocks.get.mockReturnValue(path);
    await new HandyIntegration().request('toggle');
    expect(mocks.runFile).toHaveBeenLastCalledWith(
      path,
      ['--toggle-transcription'],
      expect.any(Object)
    );
    mocks.get.mockReturnValue('relative/handy');
    expect(await new HandyIntegration().request('status')).toEqual({
      available: false,
      running: false,
      error: expect.stringContaining('absolute'),
    });
  });

  it('finds Linux executables on PATH but ignores relative entries', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    vi.stubEnv('PATH', `.${delimiter}/custom/bin`);
    mocks.stat.mockImplementation(async (path: string) => {
      if (path === join('/custom/bin', 'handy')) return { isFile: () => true };
      throw new Error('missing');
    });
    await new HandyIntegration().request('toggle');
    expect(mocks.stat).not.toHaveBeenCalledWith('handy');
    expect(mocks.runFile).toHaveBeenLastCalledWith(
      join('/custom/bin', 'handy'),
      ['--toggle-transcription'],
      expect.any(Object)
    );
  });

  it('detects Windows processes without PowerShell or shell commands', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    vi.stubEnv('LOCALAPPDATA', '/user/local');
    mocks.runFile.mockResolvedValue({
      stdout: '"handy.exe","123","Console","1","12 K"\r\n',
      stderr: '',
    });
    expect(await new HandyIntegration().request('status')).toEqual({
      available: true,
      running: true,
    });
    expect(mocks.runFile).toHaveBeenCalledExactlyOnceWith(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq handy.exe', '/FO', 'CSV', '/NH'],
      expect.objectContaining({ windowsHide: true })
    );
  });

  it('reports inspection and command failures without retrying a toggle', async () => {
    mocks.runFile.mockRejectedValue(new Error('inspection denied'));
    expect((await new HandyIntegration().request('toggle')).error).toContain('inspection denied');
    expect(mocks.runFile).toHaveBeenCalledTimes(1);
    mocks.runFile
      .mockReset()
      .mockResolvedValueOnce({ stdout: '123', stderr: '' })
      .mockRejectedValueOnce(new Error('timed out'));
    expect((await new HandyIntegration().request('toggle')).error).toContain('timed out');
    expect(mocks.runFile).toHaveBeenCalledTimes(2);
  });

  it('does not activate after a late filesystem discovery', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      mocks.stat.mockImplementationOnce(async () => {
        controller.abort(new Error('discovery expired'));
        return { isFile: () => true };
      });
      expect((await new HandyIntegration().request('toggle')).error).toContain('discovery expired');
      expect(mocks.runFile).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it('shares concurrent status discovery but rejects overlapping mutations', async () => {
    const integration = new HandyIntegration();
    const first = integration.request('toggle');
    const second = integration.request('toggle');
    const status = integration.request('status');
    expect(await first).toEqual({ available: true, running: true });
    expect((await second).error).toContain('pending');
    expect(await status).toEqual({ available: true, running: true });
    expect(mocks.runFile).toHaveBeenCalledTimes(2);
  });
});
