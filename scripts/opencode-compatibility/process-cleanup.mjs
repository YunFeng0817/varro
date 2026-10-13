import { execFile, execFileSync } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { isAbsolute, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const executeFile = promisify(execFile);

/** Restricted to a fresh, per-run CLI installation, never the user's installed CLI. */
export class AdapterProcessCleanup {
  constructor(directory) {
    if (!isAbsolute(directory))
      throw new Error('Adapter cleanup requires an absolute installation path');
    this.directory = resolve(directory);
  }

  async inventory() {
    const options = { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
    if (process.platform === 'win32') {
      const { stdout } = await executeFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress',
        ],
        options
      );
      const values = JSON.parse(stdout || '[]');
      return (Array.isArray(values) ? values : [values]).map((value) => ({
        pid: Number(value.ProcessId),
        parent: Number(value.ParentProcessId),
        birth: value.CreationDate,
        command: value.CommandLine || '',
      }));
    }
    const { stdout } = await executeFile(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,command='],
      options
    );
    return stdout.split('\n').flatMap((line) => {
      const match = line
        .trim()
        .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+((?:\S+\s+){4}\S+)\s+(.+)$/);
      if (!match || Number(match[4]) !== process.getuid?.()) return [];
      return [
        {
          pid: Number(match[1]),
          parent: Number(match[2]),
          group: Number(match[3]),
          birth: match[5],
          command: match[6],
        },
      ];
    });
  }

  owns(value) {
    if (
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      value.pid === process.pid ||
      !value.birth
    )
      return false;
    const command = value.command.replace(/^"/, '');
    const prefix = this.directory + sep;
    const scoped =
      process.platform === 'win32'
        ? command.toLowerCase().startsWith(prefix.toLowerCase())
        : command.startsWith(prefix);
    return scoped && /(?:^|\s)serve(?:\s|$)/.test(command);
  }

  async run(command, args, options) {
    let result;
    let recoveredProcesses = [];
    try {
      result = await this.execute(command, args, options);
    } catch (error) {
      result = { stdout: '', stderr: '', status: null, signal: null, error };
    } finally {
      try {
        recoveredProcesses = await this.cleanup();
      } catch (error) {
        result ??= { stdout: '', stderr: '', status: null, signal: null };
        result.error = new AggregateError(
          [result.error, error].filter(Boolean),
          'Adapter cleanup failed'
        );
      }
    }
    return { ...result, recoveredProcesses };
  }

  execute(command, args, options) {
    return new Promise((done) => {
      const { timeout, maxBuffer, signal, ...spawnOptions } = options;
      let stdout = '';
      let stderr = '';
      let error;
      const child = crossSpawn(command, args, {
        ...spawnOptions,
        // Workers stay in the owned runner group; detached servers are covered by inventory.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stopping = false;
      const stop = (reason) => {
        if (stopping) return;
        stopping = true;
        error ??= reason;
        if (!child.pid) return;
        if (process.platform === 'win32') {
          try {
            execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
              timeout: 10_000,
            });
          } catch (failure) {
            error = new AggregateError([error, failure], 'Could not stop adapter runner');
          }
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (failure) {
            if (failure.code !== 'ESRCH') error = failure;
          }
        }
      };
      const abort = () => stop(signal.reason);
      const timer = setTimeout(
        () => stop(new Error('Adapter runner exceeded its timeout')),
        timeout
      );
      signal?.addEventListener('abort', abort, { once: true });
      const collect = (data, stream) => {
        if (stream === 'stdout') stdout += data.toString();
        else stderr += data.toString();
        if (stdout.length + stderr.length > maxBuffer)
          stop(new Error('Adapter runner exceeded its output limit'));
      };
      child.stdout.on('data', (data) => collect(data, 'stdout'));
      child.stderr.on('data', (data) => collect(data, 'stderr'));
      child.once('error', (failure) => {
        error = failure;
      });
      child.once('close', (status, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        done({ stdout, stderr, error, status, signal: exitSignal });
      });
      if (signal?.aborted) abort();
    });
  }

  async cleanup() {
    const inventory = await this.inventory();
    const original = inventory.filter((value) => this.owns(value));
    const ownedPids = new Set(original.map((value) => value.pid));
    // Record descendants before stopping their parent, including tools outside the CLI directory.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const value of inventory) {
        if (value.pid === process.pid || ownedPids.has(value.pid) || !ownedPids.has(value.parent))
          continue;
        ownedPids.add(value.pid);
        original.push(value);
        expanded = true;
      }
    }
    const remaining = async () => {
      const current = await this.inventory();
      return original.filter((value) =>
        current.some(
          (candidate) =>
            candidate.pid === value.pid &&
            candidate.birth === value.birth &&
            candidate.group === value.group &&
            candidate.command === value.command
        )
      );
    };
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      for (const value of await remaining()) {
        // Revalidate birth and command before each signal, including escalation.
        if (!(await remaining()).some((candidate) => candidate.pid === value.pid)) continue;
        if (process.platform === 'win32') {
          await executeFile('taskkill.exe', ['/PID', String(value.pid), '/T', '/F'], {
            timeout: 10_000,
          }).catch(async (error) => {
            if ((await remaining()).some((candidate) => candidate.pid === value.pid)) throw error;
          });
        } else {
          try {
            process.kill(
              this.owns(value) && value.group === value.pid ? -value.pid : value.pid,
              signal
            );
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
      }
      const deadline = Date.now() + 3000;
      while ((await remaining()).length && Date.now() < deadline) await delay(50);
      if ((await remaining()).length === 0) break;
    }
    const survivors = [
      ...(await remaining()),
      ...(await this.inventory()).filter((value) => this.owns(value)),
    ];
    if (survivors.length)
      throw new Error(
        `Adapter servers survived cleanup: ${survivors.map((value) => value.pid).join(', ')}`
      );
    return original.map((value) => value.pid);
  }
}
