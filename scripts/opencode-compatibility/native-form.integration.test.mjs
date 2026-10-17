import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { build, transform } from 'esbuild';

// Execute the checkout's actual pure validator without loading Core services, opening
// a database, or changing the upstream fixture. A missing fixture is not a pass.
const root = resolve(import.meta.dirname, '../..');
const source = await readFile(resolve(root, 'tmp/opencode/packages/core/src/form.ts'), 'utf8');
const start = source.indexOf('export function validateAnswer(');
assert.ok(
  start >= 0,
  'Native validator entrypoint changed; review the fixture before updating this test'
);
const compiled = await transform(source.slice(start), { loader: 'ts', format: 'esm' });
const native = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`
);
const built = await build({
  entryPoints: [resolve(root, 'src/shared/native-form.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const forms = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
);
process.stdout.write(
  `Native form validator SHA-256: ${createHash('sha256').update(source).digest('hex')}\n`
);

function form(fields) {
  assert.equal(native.validateFields(fields), undefined);
  return forms.parseNativeForm({
    id: 'frm_isolated',
    sessionID: 'ses_disposable',
    title: 'Acceptance fixture',
    fields,
  });
}

test('native validator reproduces the inactive-field rejection and accepts Varro omission', () => {
  const request = form([
    { key: 'proxy', type: 'boolean', required: true, default: false },
    {
      key: 'url',
      type: 'string',
      required: true,
      format: 'uri',
      default: 'https://proxy.test',
      when: [{ key: 'proxy', op: 'eq', value: true }],
    },
  ]);
  const draft = forms.nativeFormDefaults(request);
  assert.equal(native.validateAnswer(request.fields, draft), 'Form field is not active: url');
  const answer = forms.nativeFormAnswer(request, draft);
  assert.deepEqual(answer, { proxy: false });
  assert.equal(native.validateAnswer(request.fields, answer), undefined);
});

test('native validator distinguishes optional missing numbers, zero and invalid coercion', () => {
  const request = form([{ key: 'n', type: 'integer', minimum: 0 }]);
  for (const draft of [{}, { n: 0 }])
    assert.equal(
      native.validateAnswer(request.fields, forms.nativeFormAnswer(request, draft)),
      undefined
    );
  assert.equal(
    native.validateAnswer(request.fields, { n: NaN }),
    'Expected number for form field: n'
  );
});

test('native validator accepts original option values with duplicate labels and required defaults', () => {
  const request = form([
    {
      key: 'region',
      type: 'string',
      required: true,
      options: [
        { value: 'a', label: 'Same' },
        { value: 'b', label: 'Same' },
      ],
      default: 'b',
    },
    {
      key: 'features',
      type: 'multiselect',
      required: true,
      minItems: 1,
      options: [{ value: 'x', label: 'X' }],
      default: ['x'],
    },
  ]);
  const answer = forms.nativeFormAnswer(request, forms.nativeFormDefaults(request));
  assert.deepEqual(answer, { region: 'b', features: ['x'] });
  assert.equal(native.validateAnswer(request.fields, {}), 'Missing required form field: region');
  assert.equal(native.validateAnswer(request.fields, answer), undefined);
  assert.equal(
    native.validateAnswer(request.fields, { ...answer, region: 'Same' }),
    'Invalid option for form field: region'
  );
});

test('native external fields require explicit true, never an empty answer or URL opening', () => {
  const request = form([{ key: 'setup', type: 'external', url: 'https://example.test/setup' }]);
  assert.equal(
    native.validateAnswer(request.fields, {}),
    'External form field must be acknowledged: setup'
  );
  assert.equal(
    native.validateAnswer(request.fields, { setup: false }),
    'External form field must be acknowledged: setup'
  );
  assert.equal(
    native.validateAnswer(request.fields, forms.nativeFormAnswer(request, { setup: true })),
    undefined
  );
});

test('native validator agrees on unanswered neq and cascaded multiselect conditions', () => {
  const request = form([
    { key: 'enabled', type: 'boolean' },
    {
      key: 'choices',
      type: 'multiselect',
      options: [{ value: 'a', label: 'A' }],
      when: [{ key: 'enabled', op: 'neq', value: false }],
    },
    {
      key: 'detail',
      type: 'string',
      required: true,
      when: [{ key: 'choices', op: 'eq', value: 'a' }],
    },
  ]);
  const answer = forms.nativeFormAnswer(request, { choices: ['a'], detail: 'retained' });
  assert.deepEqual(answer, {});
  assert.equal(native.validateAnswer(request.fields, answer), undefined);
});
