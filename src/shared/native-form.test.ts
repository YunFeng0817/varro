import { describe, expect, it } from 'vitest';
import {
  activeNativeFormFields,
  isNativeFormAnswer,
  nativeFormAnswer,
  nativeFormDefaults,
  nativeFormFieldError,
  parseNativeForm,
  safeNativeFormURL,
} from './native-form';
import type { NativeForm, NativeFormField } from './native-form';

const form: NativeForm = {
  id: 'frm_test',
  sessionID: 'ses_child',
  title: 'Connection',
  metadata: { source: 'fixture' },
  fields: [
    { key: 'proxy', type: 'boolean', required: true, default: false },
    {
      key: 'url',
      type: 'string',
      required: true,
      format: 'uri',
      default: 'https://proxy.test',
      when: [{ key: 'proxy', op: 'eq', value: true }],
    },
    { key: 'dependent', type: 'string', when: [{ key: 'url', op: 'neq', value: '' }] },
    { key: 'retries', type: 'integer', minimum: 0, maximum: 5 },
    {
      key: 'region',
      type: 'string',
      options: [
        { value: 'a', label: 'Same' },
        { value: 'b', label: 'Same' },
      ],
    },
    { key: 'features', type: 'multiselect', options: [{ value: 'a', label: 'A' }], default: [] },
  ],
};

describe('native form protocol', () => {
  it('round trips all native metadata without flattening field identity', () => {
    expect(parseNativeForm(JSON.parse(JSON.stringify(form)))).toEqual(form);
  });
  it('omits inactive defaults and cascading dependents but retains their draft', () => {
    const draft = { ...nativeFormDefaults(form), dependent: 'retained', retries: 0, region: 'b' };
    expect(nativeFormAnswer(form, draft)).toEqual({
      proxy: false,
      retries: 0,
      region: 'b',
      features: [],
    });
    expect(nativeFormAnswer(form, { ...draft, proxy: true })).toEqual({ ...draft, proxy: true });
    expect(draft.dependent).toBe('retained');
  });
  it('makes unanswered references false for neq as well as eq', () => {
    expect(activeNativeFormFields(form, {}).map((field) => field.key)).not.toContain('dependent');
  });
  it('keeps absent, empty string, false, zero and empty selection distinct', () => {
    expect(nativeFormAnswer(form, {})).toEqual({});
    expect(nativeFormAnswer(form, { proxy: false, region: '', retries: 0, features: [] })).toEqual({
      proxy: false,
      region: '',
      retries: 0,
      features: [],
    });
  });
  it('matches multiselect conditions by inclusion with AND semantics', () => {
    const selectionForm: NativeForm = {
      ...form,
      fields: [
        { key: 'choices', type: 'multiselect', options: [] },
        {
          key: 'detail',
          type: 'string',
          when: [
            { key: 'choices', op: 'eq', value: 'a' },
            { key: 'choices', op: 'neq', value: 'b' },
          ],
        },
      ],
    };
    expect(nativeFormAnswer(selectionForm, { choices: ['a'], detail: '' })).toEqual({
      choices: ['a'],
      detail: '',
    });
    expect(nativeFormAnswer(selectionForm, { choices: ['a', 'b'], detail: '' })).toEqual({
      choices: ['a', 'b'],
    });
  });
  it.each([
    { key: 'secret', type: 'password' },
    { key: 'secret', type: 'string', format: 'password' },
    { key: 'secret', type: 'string', password: true },
    { key: 'broken', type: 'multiselect', options: 'wrong' },
    { key: 'broken', type: 'number', default: 'not a number' },
  ])('keeps unknown or malformed fields visible and unsupported: %j', (field) => {
    const result = parseNativeForm({ ...form, fields: [field] });
    expect(result?.fields[0]).toMatchObject({ key: field.key, type: 'unsupported', raw: field });
    expect(parseNativeForm(result)).toEqual(result);
  });
  it('rejects non-finite numbers and non-native answer shapes', () => {
    for (const value of [{ n: NaN }, { n: Infinity }, { n: null }, { n: {} }, { n: [1] }, [], null])
      expect(isNativeFormAnswer(value)).toBe(false);
    expect(isNativeFormAnswer({ s: '', b: false, n: 0, m: [] })).toBe(true);
  });
  it('treats prototype-looking field keys as ordinary identities', () => {
    const special: NativeForm = {
      ...form,
      fields: [
        { key: '__proto__', type: 'boolean' },
        {
          key: 'constructor',
          type: 'string',
          when: [{ key: '__proto__', op: 'eq', value: false }],
        },
      ],
    };
    expect(nativeFormAnswer(special, JSON.parse('{"__proto__":false,"constructor":"ok"}'))).toEqual(
      JSON.parse('{"__proto__":false,"constructor":"ok"}')
    );
    expect(nativeFormAnswer(special, {})).toEqual({});
  });
  it('does not require optional omitted values but validates explicit empty selections', () => {
    const field: NativeFormField = {
      key: 'choices',
      type: 'multiselect',
      options: [],
      minItems: 1,
    };
    expect(nativeFormFieldError(field, undefined)).toBeUndefined();
    expect(nativeFormFieldError(field, [])).toContain('at least 1');
    expect(nativeFormFieldError({ key: 'n', type: 'integer' }, 0.5)).toContain('whole');
    expect(
      nativeFormFieldError({ key: 'ok', type: 'boolean', required: true }, false)
    ).toBeUndefined();
  });
  it('requires a user acknowledgment for external fields', () => {
    const field = { key: 'external', type: 'external', url: 'https://example.test' } as const;
    expect(nativeFormFieldError(field, undefined)).toBeDefined();
    expect(nativeFormFieldError(field, false)).toBeDefined();
    expect(nativeFormFieldError(field, true)).toBeUndefined();
  });
  it('opens only credential-free HTTP(S) external URLs', () => {
    expect(safeNativeFormURL('https://example.test/setup')).toBe(true);
    for (const url of [
      'javascript:alert(1)',
      'file:///secret',
      'vscode://command',
      'https://user:pass@example.test',
      '/relative',
    ])
      expect(safeNativeFormURL(url)).toBe(false);
  });
});
