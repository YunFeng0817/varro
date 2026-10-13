import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { completeTestCleanup, IsolatedProcessTree } from './isolated-process.test-support';
import { findListeningPids } from './process-inspection';

// Only the editor-owned output channel is replaced; process and listener inspection stay real.
// oxlint-disable-next-line anti-slop/no-module-mocking
vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const serverSource = `
  const server = require('node:net').createServer();
  process.on('SIGTERM', () => {});
  server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;

describe('isolated process teardown', () => {
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
