import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { ExtensionMessage } from '../shared/protocol';

const runFile = promisify(execFile);
const PROCESS_TIMEOUT_MS = 2_000;
type HandyStatus = Omit<
  Extract<ExtensionMessage, { type: 'handy/result' }>['payload'],
  'requestId'
>;
type HandyAction = 'status' | 'toggle' | 'cancel';

export class HandyIntegration {
  private pending: Promise<HandyStatus> | undefined;

  request(action: HandyAction): Promise<HandyStatus> {
    if (vscode.env.remoteName) return Promise.resolve({ available: false, running: false });
    if (this.pending) {
      return this.pending.then(({ available, running }) => {
        const status: HandyStatus = { available, running };
        if (action !== 'status') status.error = 'Another Handy command is still pending.';
        return status;
      });
    }
    // Claim before discovery as well, so concurrent views cannot both pass the guard.
    const operation = this.performRequest(action);
    this.pending = operation;
    void operation.then(() => {
      if (this.pending === operation) this.pending = undefined;
    });
    return operation;
  }

  private async performRequest(action: HandyAction): Promise<HandyStatus> {
    let available = false;
    let running = false;
    try {
      const executable = await this.findExecutable();
      available = executable !== undefined;
      if (!executable) return { available, running };
      running = await this.isRunning();
      if (action === 'status') return { available, running };
      if (!running) {
        return {
          available,
          running,
          error: 'Start Handy and configure its model and permissions first.',
        };
      }
      await runFile(executable, [action === 'toggle' ? '--toggle-transcription' : '--cancel'], {
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      return { available, running };
    } catch (error) {
      return {
        available,
        running,
        error: `Handy ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async findExecutable(): Promise<string | undefined> {
    const deadline = AbortSignal.timeout(PROCESS_TIMEOUT_MS);
    const configured = vscode.workspace
      .getConfiguration('varro')
      .get<string>('dictation.handyPath', '')
      .trim();
    if (configured && !isAbsolute(configured)) {
      throw new Error('varro.dictation.handyPath must be an absolute executable path.');
    }
    const name = process.platform === 'win32' ? 'handy.exe' : 'handy';
    const standard =
      process.platform === 'darwin'
        ? [
            '/Applications/Handy.app/Contents/MacOS/Handy',
            join(homedir(), 'Applications/Handy.app/Contents/MacOS/Handy'),
          ]
        : process.platform === 'win32'
          ? [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
              .filter((directory): directory is string => !!directory)
              .map((directory) => join(directory, 'Handy', name))
          : [join(homedir(), '.local/bin/handy'), '/usr/bin/handy', '/usr/local/bin/handy'];
    const candidates = configured
      ? [configured]
      : [
          ...standard,
          ...(process.env.PATH ?? '')
            .split(delimiter)
            .filter(isAbsolute)
            .map((directory) => join(directory, name)),
        ];
    for (const candidate of new Set(candidates)) {
      deadline.throwIfAborted();
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      } catch {
        // Missing or non-executable candidates are normal during optional discovery.
        continue;
      }
      // A late filesystem read must never activate dictation after discovery expired.
      deadline.throwIfAborted();
      return candidate;
    }
    deadline.throwIfAborted();
    return undefined;
  }

  private async isRunning(): Promise<boolean> {
    const options = { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true };
    if (process.platform === 'win32') {
      const { stdout } = await runFile(
        'tasklist.exe',
        ['/FI', 'IMAGENAME eq handy.exe', '/FO', 'CSV', '/NH'],
        options
      );
      return /^"handy\.exe",/im.test(stdout);
    }
    try {
      const { stdout } = await runFile(
        '/usr/bin/pgrep',
        ['-u', String(process.getuid!()), '-x', 'Handy|handy'],
        options
      );
      return /^\d+$/m.test(stdout.trim());
    } catch (error) {
      // pgrep exits 1 when there are no matching processes, not on inspection failure.
      if (error instanceof Error && 'code' in error && error.code === 1) return false;
      throw error;
    }
  }
}
