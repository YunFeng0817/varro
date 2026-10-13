import crossSpawn from 'cross-spawn';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AdapterProcessCleanup } from './process-cleanup.mjs';

const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const sources = await readFile(join(root, 'src/shared/opencode-compatibility.ts'), 'utf8');
const floor = sources.match(/MINIMUM_SUPPORTED_OPENCODE_VERSION\s*=\s*'([^']+)'/)?.[1];
const v2Floor = sources.match(/MINIMUM_SUPPORTED_OPENCODE_V2_VERSION\s*=\s*'([^']+)'/)?.[1];
const v1 = String(manifest.dependencies['@opencode-ai/sdk']).match(/\d+\.\d+\.\d+/)?.[0];
const v2 = String(manifest.dependencies['@opencode/client']).match(/\d+\.\d+\.\d+/)?.[0];
if (!floor || !v2Floor || !v1 || !v2)
  throw new Error('Could not read the declared adapter versions');
const versions = [...new Set([floor, v1, v2Floor, v2])];
const directory = join(root, 'artifacts', 'opencode-adapters');
await mkdir(directory, { recursive: true });
const run = await mkdtemp(join(directory, 'run-'));
const results = [];
const cancellation = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    cancellation.abort(new Error(`Adapter run interrupted by ${signal}`));
  });
}
for (const version of versions) {
  cancellation.signal.throwIfAborted();
  const packageName = version.startsWith('2.') ? '@opencode/cli' : 'opencode-ai';
  const prefix = join(run, version);
  const install = crossSpawn.sync(
    'npm',
    ['install', '--prefix', prefix, `${packageName}@${version}`],
    { cwd: root, encoding: 'utf8', timeout: 120_000 }
  );
  if (install.status !== 0)
    throw new Error(
      `Could not install ${packageName}@${version}: ${install.stderr || install.error}`
    );
  const binary = join(
    prefix,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'opencode.cmd' : 'opencode'
  );
  process.stdout.write(`Testing ${packageName}@${version}\n`);
  const cleanup = new AdapterProcessCleanup(prefix);
  const test = await cleanup.run(
    process.execPath,
    [
      'scripts/run-tests.mjs',
      'src/extension/opencode-v2.integration.test.ts',
      'src/extension/opencode-startup.integration.test.ts',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      // Startup has nine serial cases with 60s budgets plus 90s recovery.
      // The outer deadline must allow Vitest to finish and report assertions.
      timeout: 900_000,
      maxBuffer: 10 * 1024 * 1024,
      signal: cancellation.signal,
      env: {
        ...process.env,
        VARRO_OPENCODE_TEST_BINARY: binary,
        VARRO_OPENCODE_TEST_VERSION: version,
      },
    }
  );
  const { recoveredProcesses } = test;
  if (recoveredProcesses.length)
    test.stderr += `\nTeardown leaked adapter servers, recovered PIDs: ${recoveredProcesses.join(', ')}\n`;
  const log = `${test.stdout ?? ''}${test.stderr ?? ''}${test.error ? `\nAdapter runner error: ${test.error.message}\n` : ''}`;
  await writeFile(join(run, `${version}.log`), log);
  results.push({
    package: packageName,
    version,
    passed: test.status === 0 && !test.error && recoveredProcesses.length === 0,
    exitCode: test.status,
    signal: test.signal,
    error: test.error?.message ?? null,
    log: join(run, `${version}.log`),
    recoveredProcesses,
  });
  process.stdout.write(log);
  if (cancellation.signal.aborted) break;
}
await writeFile(
  join(directory, 'verified.json'),
  JSON.stringify({ date: new Date().toISOString(), versions, results }, null, 2)
);
if (results.some((result) => !result.passed) && !process.exitCode) process.exitCode = 1;
process.stdout.write(`Adapter compatibility report: ${join(directory, 'verified.json')}\n`);
