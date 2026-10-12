import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'vite';

test('webview preload hints contain transitive static chunks but no lazy chunks', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varro-preloads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, 'entry.js'),
    "import { value } from './first.js'; document.body.textContent = value(); document.body.onclick = () => import('./optional.js');"
  );
  await writeFile(
    path.join(root, 'first.js'),
    "import { value as nested } from './nested.js'; export const value = () => nested() + 'first';"
  );
  await writeFile(path.join(root, 'nested.js'), "export const value = () => 'nested';");
  await writeFile(path.join(root, 'optional.js'), "document.body.dataset.optional = 'loaded';");
  const output = path.join(root, 'out');
  await build({
    root,
    configFile: fileURLToPath(new URL('../vite.config.mts', import.meta.url)),
    logLevel: 'silent',
    build: {
      outDir: output,
      rollupOptions: {
        input: path.join(root, 'entry.js'),
        output: {
          codeSplitting: {
            groups: ['first', 'nested', 'optional'].map((name) => ({
              name,
              test: new RegExp(`/${name}\\.js$`),
              includeDependenciesRecursively: false,
            })),
          },
        },
      },
    },
  });
  const hints = JSON.parse(await readFile(path.join(output, 'webview.imports.json'), 'utf8'));
  assert.deepEqual(
    hints.map((name) => name.split('-')[0]),
    ['chunks/first', 'chunks/nested']
  );
  for (const name of hints) assert.ok((await readFile(path.join(output, name))).length > 0);
  assert.match(await readFile(path.join(output, 'webview.version'), 'utf8'), /^[a-f0-9]{16}$/);
});
