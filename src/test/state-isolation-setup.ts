import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll } from 'vitest';

// Each test file gets real disk state without touching the user's shared Varro directory.
const parent = resolve('artifacts/ai-test-data');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'unit-state-'));
const previous = process.env.VARRO_TEST_STATE_ROOT;
process.env.VARRO_TEST_STATE_ROOT = directory;

afterAll(async () => {
  if (previous === undefined) delete process.env.VARRO_TEST_STATE_ROOT;
  else process.env.VARRO_TEST_STATE_ROOT = previous;
  await rm(directory, { recursive: true, force: true });
});
