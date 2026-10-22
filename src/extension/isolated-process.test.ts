import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { completeTestCleanup, IsolatedProcessTree } from './isolated-process.test-support';
import {
  disposeProcessInspection,
  findListeningPids,
  prepareProcessInspection,
  readWindowsProcessIdentity,
} from './process-inspection';

// Only the editor-owned output channel is replaced; process and listener inspection stay real.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('./logger', () => ({
  // oxlint-disable-next-line no-console -- Keep native inspection failures visible in CI logs.
  logger: { info: vi.fn(), warn: console.warn, error: console.error },
}));

const serverSource = `
  const server = require('node:net').createServer();
  process.on('SIGTERM', () => {});
  server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

describe('isolated process teardown', () => {
  // Compile the Windows helper before launching fixtures, not inside an identity read.
  // Preparation grants no process evidence; capture and teardown still inspect afresh.
  beforeAll(async () => {
    await prepareProcessInspection();
    if (process.platform === 'win32') {
      // Exercise the complete request/response path before creating a process to clean up.
      // This observation is only setup evidence, never a fixture's identity.
      const identity = await readWindowsProcessIdentity(process.pid);
      expect(identity.birthIdentity).toMatch(/^win32:\d+$/);
      expect(identity.executable.toLowerCase()).toBe(process.execPath.toLowerCase());
    }
  }, 40_000);
  afterAll(() => disposeProcessInspection());

  it('attempts subsequent cleanup after disposal and evidence failures', async () => {
    const completed: string[] = [];
    await expect(
      completeTestCleanup([
        () => {
          throw new Error('disposal failed');
        },
        () => {
          completed.push('server stopped');
        },
        () => {
          throw new Error('evidence write failed');
        },
        () => {
          completed.push('environment restored');
        },
      ])
    ).rejects.toThrow('Isolated fixture cleanup failed');
    expect(completed).toEqual(['server stopped', 'environment restored']);
  });
  it.for(['direct', 'wrapper', 'exited-wrapper'] as const)(
    'stops the actual listener for a %s launch',
    { timeout: 20000 },
    async (mode, context) => {
      const source =
        mode === 'direct'
          ? serverSource
          : `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(serverSource)}], {
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        child.stdout.pipe(process.stdout);
        setInterval(() => {}, 1000);
      `;
      const child = spawn(process.execPath, ['-e', source], {
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const tree = new IsolatedProcessTree(child);
      context.onTestFinished(() => tree.stop());
      const [chunk] = await once(child.stdout!, 'data');
      const port = Number(String(chunk).trim());
      expect(port).toBeGreaterThan(0);
      await tree.captureListener(port);
      if (mode === 'exited-wrapper') {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
      await tree.stop();
      expect(await findListeningPids(port)).toEqual([]);
      // Repeated cleanup must not signal a new process through a stale PID.
      await tree.stop();
    }
  );

  it('rejects an unrelated listener without stopping it', { timeout: 20000 }, async (context) => {
    const unrelated = spawn(process.execPath, ['-e', serverSource], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    context.onTestFinished(async () => {
      const exited = once(unrelated, 'exit');
      unrelated.kill('SIGKILL');
      await exited;
    });
    const [chunk] = await once(unrelated.stdout!, 'data');
    const port = Number(String(chunk).trim());
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    });
    const tree = new IsolatedProcessTree(child);
    context.onTestFinished(() => tree.stop());
    await expect(tree.captureListener(port)).rejects.toThrow('not a child');
    await tree.stop();
    expect(await findListeningPids(port)).toEqual([unrelated.pid]);
  });
});
