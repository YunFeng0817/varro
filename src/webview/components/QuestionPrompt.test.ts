import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createComponent, render } from 'solid-js/web';
import type * as UseOpenCodeModule from '../hooks/useOpenCode';
import { setState } from '../lib/state';
import type { QuestionRequest } from '../types';
import { QuestionPrompt } from './QuestionPrompt';
import type { NativeForm, NativeFormField } from '../../shared/protocol';
import { nativeFormDrafts } from '../lib/native-form-drafts';

const { rejectQuestionMock, respondQuestionMock } = vi.hoisted(() => ({
  rejectQuestionMock: vi.fn(async () => {}),
  respondQuestionMock: vi.fn(async () => {}),
}));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise QuestionPrompt's useOpenCode module integration. */
vi.mock('../hooks/useOpenCode', async () => {
  const actual = await vi.importActual<typeof UseOpenCodeModule>('../hooks/useOpenCode');
  return {
    ...actual,
    rejectQuestion: rejectQuestionMock,
    respondQuestion: respondQuestionMock,
  };
});

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

describe('native QuestionPrompt', () => {
  let nextID = 0;
  function nativeRequest(fields: NativeFormField[], question = false): QuestionRequest {
    const id = `frm_component_${nextID++}`;
    const form: NativeForm = { id, sessionID: 'ses_child', title: 'Native input', fields };
    if (question) form.metadata = { kind: 'question' };
    return {
      id,
      sessionID: 'ses_child',
      questions: [],
      kind: 'native-form',
      form,
    };
  }
  function control<T extends HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>(
    key: string
  ): T {
    const element = container!.querySelector<T>(
      `[data-field-key="${key}"] input, [data-field-key="${key}"] textarea, [data-field-key="${key}"] [role="combobox"]`
    );
    if (!element) throw new Error(`Missing control: ${key}`);
    return element;
  }
  function change(key: string, value: string) {
    const element = control(key);
    if (element.getAttribute('role') === 'combobox') {
      element.click();
      const list = document.getElementById(element.getAttribute('aria-controls')!);
      const option = Array.from(list!.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
        (item) => item.dataset.value === value
      );
      if (!option) throw new Error(`Missing option: ${value}`);
      option.click();
      return;
    }
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
  async function submitNative() {
    container!
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await Promise.resolve();
    await Promise.resolve();
  }

  it('shows native question choices and descriptions as radios without flattening duplicate labels', async () => {
    const active = nativeRequest(
      [
        {
          key: 'choice',
          type: 'string',
          title: 'Choose a region',
          required: true,
          options: [
            { value: 'east', label: 'Same', description: 'East region description' },
            { value: 'west', label: 'Same', description: 'West region description' },
          ],
        },
      ],
      true
    );
    renderQuestionPrompt(active);
    expect(container!.querySelector('[role="combobox"]')).toBeNull();
    const group = container!.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-label')).toBe('Choose a region');
    const radios = group.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios).toHaveLength(2);
    expect(Array.from(radios).every((radio) => !radio.checked)).toBe(true);
    expect(container!.textContent).toContain('East region description');
    expect(container!.textContent).toContain('West region description');
    await submitNative();
    expect(document.activeElement).toBe(radios[0]);
    radios[1]!.click();
    expect(radios[1]!.checked).toBe(true);
    expect(radios[0]!.checked).toBe(false);
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      { kind: 'native-form', sessionID: 'ses_child', answer: { choice: 'west' } },
      { rethrow: true }
    );
  });

  it('keeps a labeled native custom answer separate from declared radio choices and retains it on remount', async () => {
    const active = nativeRequest(
      [
        {
          key: 'choice',
          type: 'string',
          title: 'Rollout',
          custom: true,
          options: [
            { value: 'canary', label: 'Canary' },
            { value: 'all', label: 'Everywhere' },
          ],
          default: 'initial custom answer',
        },
      ],
      true
    );
    setState('questions', [active]);
    renderQuestionPrompt(active);
    const custom = container!.querySelector<HTMLTextAreaElement>(
      '[aria-label="Rollout: custom answer"]'
    )!;
    const customRadio = container!.querySelector<HTMLInputElement>(
      'input[aria-label="Custom answer"]'
    )!;
    expect(custom.value).toBe('initial custom answer');
    expect(custom.placeholder).toBe('Type your own answer');
    expect(container!.querySelector('.question-option-custom .question-option-label')).toBeNull();
    expect(customRadio.checked).toBe(true);
    const canary = container!.querySelector<HTMLInputElement>('input[aria-label="Canary"]')!;
    canary.click();
    expect(canary.checked).toBe(true);
    expect(customRadio.checked).toBe(false);
    customRadio.click();
    expect(document.activeElement).toBe(custom);
    expect(custom.value).toBe('initial custom answer');
    custom.value = 'Custom plan\nwith monitoring';
    custom.dispatchEvent(new Event('input', { bubbles: true }));
    canary.click();
    expect(canary.checked).toBe(true);
    expect(customRadio.checked).toBe(false);
    expect(custom.value).toBe('Custom plan\nwith monitoring');
    customRadio.click();
    cleanup?.();
    cleanup = undefined;
    renderQuestionPrompt(active);
    expect(
      container!.querySelector<HTMLTextAreaElement>('[aria-label="Rollout: custom answer"]')!.value
    ).toBe('Custom plan\nwith monitoring');
    expect(
      container!.querySelector<HTMLInputElement>('input[aria-label="Custom answer"]')!.checked
    ).toBe(true);
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      {
        kind: 'native-form',
        sessionID: 'ses_child',
        answer: { choice: 'Custom plan\nwith monitoring' },
      },
      { rethrow: true }
    );
  });

  it('keeps question radio groups independent and submits boolean false as a boolean', async () => {
    const active = nativeRequest(
      [
        { key: 'proxy', type: 'boolean', title: 'Use proxy?', default: true },
        {
          key: 'url',
          type: 'string',
          required: true,
          when: [{ key: 'proxy', op: 'eq', value: true }],
        },
        {
          key: 'first',
          type: 'string',
          options: [
            { value: 'a', label: 'First A' },
            { value: 'b', label: 'First B' },
          ],
        },
        {
          key: 'second',
          type: 'string',
          options: [
            { value: 'a', label: 'Second A' },
            { value: 'b', label: 'Second B' },
          ],
        },
      ],
      true
    );
    renderQuestionPrompt(active);
    const radio = (name: string) =>
      container!.querySelector<HTMLInputElement>(`input[type="radio"][aria-label="${name}"]`)!;
    radio('No').click();
    radio('First A').click();
    radio('Second B').click();
    expect(radio('First A').checked).toBe(true);
    expect(radio('Second B').checked).toBe(true);
    expect(container!.querySelector('[data-field-key="url"]')).toBeNull();
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      {
        kind: 'native-form',
        sessionID: 'ses_child',
        answer: { proxy: false, first: 'a', second: 'b' },
      },
      { rethrow: true }
    );
  });

  it('renders free-text questions directly without radio or custom-answer wrappers', async () => {
    const active = nativeRequest(
      [
        { key: 'notes', type: 'string', title: 'Notes', required: true },
        { key: 'empty', type: 'string', title: 'Other', options: [], custom: true },
      ],
      true
    );
    setState('questions', [active]);
    renderQuestionPrompt(active);
    expect(container!.querySelector('[role="radiogroup"]')).toBeNull();
    expect(container!.querySelector('input[type="radio"]')).toBeNull();
    expect(container!.querySelector('.question-option-custom')).toBeNull();
    const notes = control<HTMLTextAreaElement>('notes');
    expect(notes.tagName).toBe('TEXTAREA');
    expect(notes.rows).toBe(1);
    await submitNative();
    expect(document.activeElement).toBe(notes);
    change('notes', 'First line\nSecond line');
    change('empty', 'Another answer');
    expect(control('notes')).toBe(notes);
    cleanup?.();
    cleanup = undefined;
    renderQuestionPrompt(active);
    expect(control('notes').value).toBe('First line\nSecond line');
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      {
        kind: 'native-form',
        sessionID: 'ses_child',
        answer: { notes: 'First line\nSecond line', empty: 'Another answer' },
      },
      { rethrow: true }
    );
  });

  it('submits false without the required conditional URL and retains hidden drafts for redisplay', async () => {
    const active = nativeRequest([
      { key: 'proxy', type: 'boolean', required: true, default: false },
      {
        key: 'url',
        type: 'string',
        required: true,
        format: 'uri',
        when: [{ key: 'proxy', op: 'eq', value: true }],
      },
    ]);
    setState('questions', [active]);
    renderQuestionPrompt(active);
    expect(container!.querySelector('[data-field-key="url"]')).toBeNull();
    change('proxy', 'true');
    change('url', 'https://proxy.test');
    change('proxy', 'false');
    change('proxy', 'true');
    expect(control('url').value).toBe('https://proxy.test');
    change('proxy', 'false');
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      { kind: 'native-form', sessionID: 'ses_child', answer: { proxy: false } },
      { rethrow: true }
    );
  });
  it('distinguishes optional absence and zero, and submits duplicate-label choices by value', async () => {
    const active = nativeRequest([
      { key: 'n', type: 'number' },
      { key: 'optional', type: 'integer' },
      {
        key: 'choice',
        type: 'string',
        options: [
          { label: 'Same', value: 'a' },
          { label: 'Same', value: 'b' },
        ],
      },
    ]);
    renderQuestionPrompt(active);
    change('n', '0');
    change('choice', 'value:b');
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      { kind: 'native-form', sessionID: 'ses_child', answer: { n: 0, choice: 'b' } },
      { rethrow: true }
    );
  });
  it('does not show Clear buttons for selected question answers', async () => {
    const active = nativeRequest(
      [
        { key: 'choice', type: 'string', options: [{ value: 'a', label: 'Option A' }] },
        { key: 'tags', type: 'multiselect', options: [{ value: 'search', label: 'Search' }] },
      ],
      true
    );
    renderQuestionPrompt(active);
    container!
      .querySelector<HTMLInputElement>('input[type="radio"][aria-label="Option A"]')!
      .click();
    container!
      .querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="Search"]')!
      .click();
    expect(container!.querySelector('.native-form-clear')).toBeNull();
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      { kind: 'native-form', sessionID: 'ses_child', answer: { choice: 'a', tags: ['search'] } },
      { rethrow: true }
    );
  });

  it('clears an optional value from its label row without a separate unanswered action', async () => {
    const active = nativeRequest([
      { key: 'count', type: 'integer', title: 'Retry count', default: 0 },
    ]);
    renderQuestionPrompt(active);
    const clear = container!.querySelector<HTMLButtonElement>('[aria-label="Clear Retry count"]')!;
    expect(clear.closest('.native-form-field-heading')).not.toBeNull();
    expect(container!.textContent).not.toContain('Leave unanswered');
    clear.click();
    expect(control('count').value).toBe('');
    expect(respondQuestionMock).not.toHaveBeenCalled();
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      { kind: 'native-form', sessionID: 'ses_child', answer: {} },
      { rethrow: true }
    );
  });
  it('marks required labels with a muted asterisk and omits trailing validation punctuation', async () => {
    renderQuestionPrompt(
      nativeRequest([{ key: 'confirm', type: 'boolean', title: 'Confirm', required: true }])
    );
    const marker = container!.querySelector('.native-form-required')!;
    expect(marker.textContent?.trim()).toBe('*');
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    expect(container!.querySelector('.native-form-field-heading')!.textContent).not.toContain(
      '(required)'
    );
    expect(control('confirm').getAttribute('aria-required')).toBe('true');
    await submitNative();
    expect(container!.querySelector('.native-form-error')!.textContent).toBe('Answer required');
  });
  it('preserves required multiselect defaults, original option values, and custom selections', async () => {
    const active = nativeRequest([
      {
        key: 'choices',
        type: 'multiselect',
        title: 'Selections',
        required: true,
        minItems: 1,
        custom: true,
        options: [
          { value: 'a', label: 'Same' },
          { value: 'b', label: 'Same' },
        ],
        default: ['b'],
      },
    ]);
    renderQuestionPrompt(active);
    const choices = container!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(choices[0]!.checked).toBe(false);
    expect(choices[1]!.checked).toBe(true);
    const custom = container!.querySelector<HTMLTextAreaElement>(
      '[aria-label="Selections: custom option"]'
    )!;
    custom.value = 'custom value';
    custom.dispatchEvent(new Event('input', { bubbles: true }));
    container!
      .querySelector<HTMLInputElement>('[aria-label="Selections: select custom value 1"]')!
      .click();
    custom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    expect(respondQuestionMock).not.toHaveBeenCalled();
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      { kind: 'native-form', sessionID: 'ses_child', answer: { choices: ['b', 'custom value'] } },
      { rethrow: true }
    );
  });

  it('grows custom checkbox rows while retaining input identity and explicit selection', async () => {
    const active = nativeRequest(
      [
        {
          key: 'choices',
          type: 'multiselect',
          title: 'Selections',
          custom: true,
          options: [{ value: 'search', label: 'Search', description: 'Search files' }],
        },
      ],
      true
    );
    renderQuestionPrompt(active);
    const checkbox = container!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.getAttribute('aria-describedby')).toContain('-option-0-description');
    expect(checkbox.closest('label')!.textContent).toContain('Search files');
    const custom = container!.querySelector<HTMLTextAreaElement>(
      '[aria-label="Selections: custom option"]'
    )!;
    const firstCheckbox = container!.querySelector<HTMLInputElement>(
      '[aria-label="Selections: select custom value 1"]'
    )!;
    expect(firstCheckbox.disabled).toBe(true);
    expect(custom.placeholder).toBe('Type your own answer');
    expect(container!.querySelector('[data-custom-remove]')).toBeNull();
    expect(container!.querySelector('.native-multiselect-add')).toBeNull();
    custom.focus();
    custom.value = 'Line one\nLine two';
    custom.dispatchEvent(new Event('input', { bubbles: true }));
    expect(firstCheckbox.disabled).toBe(false);
    expect(firstCheckbox.checked).toBe(false);
    expect(container!.querySelector('[aria-label="Selections: custom option"]')).toBe(custom);
    expect(document.activeElement).toBe(custom);
    expect(container!.querySelectorAll('[data-custom-row]')).toHaveLength(2);
    for (const modifiers of [{}, { shiftKey: true }, { isComposing: true }]) {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...modifiers,
      });
      custom.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(container!.querySelectorAll('[data-custom-row]')).toHaveLength(2);
    }
    firstCheckbox.click();
    expect(firstCheckbox.checked).toBe(true);
    custom.value = 'Edited selected value';
    custom.dispatchEvent(new Event('input', { bubbles: true }));
    expect(firstCheckbox.checked).toBe(true);
    const second = container!.querySelector<HTMLTextAreaElement>(
      '[aria-label="Selections: custom option 2"]'
    )!;
    second.value = 'Keep unchecked';
    second.dispatchEvent(new Event('input', { bubbles: true }));
    expect(container!.querySelectorAll('[data-custom-row]')).toHaveLength(3);
    expect(
      container!.querySelector<HTMLInputElement>(
        '[aria-label="Selections: select custom value 3"]'
      )!.disabled
    ).toBe(true);
    expect(container!.querySelector('[data-custom-row] button')).toBeNull();
    second.value = '';
    second.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
    expect(container!.querySelectorAll('[data-custom-row]')).toHaveLength(2);
    expect(document.activeElement).toBe(
      container!.querySelector('[aria-label="Selections: custom option 2"]')
    );
    checkbox.click();
    expect(respondQuestionMock).not.toHaveBeenCalled();
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      {
        kind: 'native-form',
        sessionID: 'ses_child',
        answer: { choices: ['search', 'Edited selected value'] },
      },
      { rethrow: true }
    );
  });

  it('keeps decimal input editable and focuses the first invalid answer', async () => {
    renderQuestionPrompt(nativeRequest([{ key: 'n', type: 'number', minimum: 1 }]));
    change('n', '1.');
    expect(control('n').value).toBe('1.');
    change('n', '1.5');
    expect(control('n').value).toBe('1.5');
    change('n', '-');
    await submitNative();
    expect(respondQuestionMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(control('n'));
    expect(control('n').getAttribute('aria-invalid')).toBe('true');
  });

  it('restores existing custom selections and legacy custom drafts as checked editable rows', async () => {
    const active = nativeRequest([
      { key: 'choices', type: 'multiselect', title: 'Selections', options: [], custom: true },
    ]);
    nativeFormDrafts.save({
      id: active.id,
      sessionID: active.sessionID,
      values: { choices: ['Saved value'] },
      custom: { choices: 'Previously unfinished' },
    });
    renderQuestionPrompt(active);
    const rows = container!.querySelectorAll('[data-custom-row]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    expect(rows[1]!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
      'Previously unfinished'
    );
    expect(rows[1]!.querySelector<HTMLInputElement>('input')!.checked).toBe(true);
    container!.querySelector<HTMLButtonElement>('[aria-label="Clear Selections"]')!.click();
    expect(container!.querySelectorAll('[data-custom-row]')).toHaveLength(1);
    expect(container!.querySelector<HTMLTextAreaElement>('[data-custom-input]')!.value).toBe('');
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      { kind: 'native-form', sessionID: 'ses_child', answer: {} },
      { rethrow: true }
    );
  });

  it('clears checked custom text without leaving an invisible submitted value', async () => {
    const active = nativeRequest([
      { key: 'choices', type: 'multiselect', title: 'Selections', options: [], custom: true },
    ]);
    renderQuestionPrompt(active);
    const input = container!.querySelector<HTMLTextAreaElement>('[data-custom-input]')!;
    input.value = 'Temporary';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const checkbox = container!.querySelector<HTMLInputElement>(
      '[aria-label="Selections: select custom value 1"]'
    )!;
    checkbox.click();
    expect(checkbox.checked).toBe(true);
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
    expect(container!.querySelectorAll('[data-custom-row]')).toHaveLength(1);
    expect(container!.contains(input)).toBe(false);
    const blankCheckbox = container!.querySelector<HTMLInputElement>(
      '[aria-label="Selections: select custom value 1"]'
    )!;
    expect(blankCheckbox.checked).toBe(false);
    expect(blankCheckbox.disabled).toBe(true);
    const blank = container!.querySelector<HTMLTextAreaElement>('[data-custom-input]')!;
    expect(document.activeElement).toBe(blank);
    blank.dispatchEvent(new Event('input', { bubbles: true }));
    expect(container!.querySelectorAll('[data-custom-row]')).toHaveLength(1);
    expect(container!.querySelector('[data-custom-input]')).toBe(blank);
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      { kind: 'native-form', sessionID: 'ses_child', answer: { choices: [] } },
      { rethrow: true }
    );
  });

  it('focuses the custom input rather than its disabled checkbox when a required selection is missing', async () => {
    renderQuestionPrompt(
      nativeRequest([
        {
          key: 'choices',
          type: 'multiselect',
          title: 'Selections',
          options: [],
          custom: true,
          required: true,
          minItems: 1,
        },
      ])
    );
    await submitNative();
    expect(respondQuestionMock).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(container!.querySelector('[data-custom-input]'));
  });

  it('removes an emptied first row without replacing the next row or losing its selection', async () => {
    const active = nativeRequest([
      { key: 'choices', type: 'multiselect', title: 'Selections', options: [], custom: true },
    ]);
    renderQuestionPrompt(active);
    const first = container!.querySelector<HTMLTextAreaElement>('[data-custom-input]')!;
    first.value = 'First';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    const second = container!.querySelectorAll<HTMLTextAreaElement>('[data-custom-input]')[1]!;
    second.value = 'Keep this';
    second.dispatchEvent(new Event('input', { bubbles: true }));
    const secondCheckbox = container!.querySelector<HTMLInputElement>(
      '[aria-label="Selections: select custom value 2"]'
    )!;
    secondCheckbox.click();
    first.value = '';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
    expect(container!.querySelectorAll('[data-custom-row]')).toHaveLength(2);
    expect(container!.querySelector('[data-custom-input]')).toBe(second);
    expect(document.activeElement).toBe(second);
    expect(secondCheckbox.checked).toBe(true);
    expect(second.value).toBe('Keep this');
    secondCheckbox.click();
    expect(second.value).toBe('Keep this');
    expect(container!.querySelectorAll('[data-custom-row]')).toHaveLength(2);
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      { kind: 'native-form', sessionID: 'ses_child', answer: { choices: [] } },
      { rethrow: true }
    );
  });
  it('retains typed values after server rejection and virtual remount', async () => {
    const active = nativeRequest([{ key: 'answer', type: 'string', required: true }]);
    setState('questions', [active]);
    respondQuestionMock.mockRejectedValueOnce(
      new Error('400 Invalid option for form field: answer')
    );
    renderQuestionPrompt(active);
    change('answer', 'keep this');
    await submitNative();
    expect(container!.textContent).toContain('server did not accept');
    expect(document.activeElement).toBe(control('answer'));
    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();
    renderQuestionPrompt(active);
    expect(control('answer').value).toBe('keep this');
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledTimes(2);
  });
  it('retains unchecked custom rows across remount without submitting their text', async () => {
    const active = nativeRequest([
      { key: 'choices', type: 'multiselect', title: 'Selections', options: [], custom: true },
    ]);
    setState('questions', [active]);
    renderQuestionPrompt(active);
    const custom = container!.querySelector<HTMLTextAreaElement>(
      '[aria-label="Selections: custom option"]'
    )!;
    custom.value = 'pending value';
    custom.dispatchEvent(new Event('input', { bubbles: true }));
    const second = container!.querySelector<HTMLTextAreaElement>(
      '[aria-label="Selections: custom option 2"]'
    )!;
    second.value = 'selected value';
    second.dispatchEvent(new Event('input', { bubbles: true }));
    container!
      .querySelector<HTMLInputElement>('[aria-label="Selections: select custom value 2"]')!
      .click();
    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();
    renderQuestionPrompt(active);
    expect(
      container!.querySelector<HTMLTextAreaElement>('[aria-label="Selections: custom option"]')!
        .value
    ).toBe('pending value');
    expect(
      container!.querySelector<HTMLInputElement>(
        '[aria-label="Selections: select custom value 1"]'
      )!.checked
    ).toBe(false);
    expect(
      container!.querySelector<HTMLInputElement>(
        '[aria-label="Selections: select custom value 2"]'
      )!.checked
    ).toBe(true);
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      active.id,
      { kind: 'native-form', sessionID: 'ses_child', answer: { choices: ['selected value'] } },
      { rethrow: true }
    );
  });

  it('retains a pending draft while workspace reconnection temporarily clears questions', async () => {
    const active = nativeRequest([
      { key: 'answer', type: 'string', required: true },
      { key: 'choices', type: 'multiselect', title: 'Selections', options: [], custom: true },
    ]);
    setState('questions', [active]);
    renderQuestionPrompt(active);
    change('answer', 'keep this');
    const custom = container!.querySelector<HTMLTextAreaElement>(
      '[aria-label="Selections: custom option"]'
    )!;
    custom.value = 'unfinished';
    custom.dispatchEvent(new Event('input', { bubbles: true }));

    setState('questions', []);
    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();
    setState('questions', [active]);
    renderQuestionPrompt(active);

    expect(control('answer').value).toBe('keep this');
    expect(
      container!.querySelector<HTMLTextAreaElement>('[aria-label="Selections: custom option"]')!
        .value
    ).toBe('unfinished');
    expect(respondQuestionMock).not.toHaveBeenCalled();
    expect(rejectQuestionMock).not.toHaveBeenCalled();
  });

  it('prevents duplicate submission across remount while awaiting acknowledgment', async () => {
    const active = nativeRequest([{ key: 'answer', type: 'boolean', default: false }]);
    setState('questions', [active]);
    let resolve!: () => void;
    respondQuestionMock.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        })
    );
    renderQuestionPrompt(active);
    await submitNative();
    cleanup?.();
    cleanup = undefined;
    renderQuestionPrompt(active);
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledTimes(1);
    expect(container!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(
      true
    );
    resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  it('never auto-acknowledges external actions and blocks unsupported types without hiding skip', async () => {
    const external = nativeRequest([
      { key: 'setup', type: 'external', url: 'javascript:alert(1)' },
    ]);
    renderQuestionPrompt(external);
    expect(container!.textContent).toContain('unsafe or unsupported URL');
    expect(container!.textContent).not.toContain('Open external action');
    await submitNative();
    expect(respondQuestionMock).not.toHaveBeenCalled();
    const checkbox = control<HTMLInputElement>('setup');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    await submitNative();
    expect(respondQuestionMock).toHaveBeenCalledWith(
      external.id,
      { kind: 'native-form', sessionID: 'ses_child', answer: { setup: true } },
      { rethrow: true }
    );
    cleanup?.();
    cleanup = undefined;
    renderQuestionPrompt(
      nativeRequest([
        { key: 'new', type: 'unsupported', nativeType: 'password', raw: { type: 'password' } },
      ])
    );
    expect(container!.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(
      true
    );
    const skip = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent === 'Skip'
    )!;
    skip.click();
    await Promise.resolve();
    expect(rejectQuestionMock).toHaveBeenCalled();
  });
});

function request(id = 'question-1'): QuestionRequest {
  return {
    id,
    sessionID: 'session-1',
    questions: [
      {
        question: 'How should this proceed?',
        header: 'Follow-up',
        options: [{ label: 'Option A', description: 'Use the default path' }],
      },
    ],
  };
}

function renderQuestionPrompt(activeRequest: QuestionRequest) {
  cleanup = render(() => createComponent(QuestionPrompt, { request: activeRequest }), container!);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  setState('questions', []);
  rejectQuestionMock.mockReset();
  rejectQuestionMock.mockResolvedValue(undefined);
  respondQuestionMock.mockReset();
  respondQuestionMock.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setState('questions', []);
});

describe('QuestionPrompt draft retention', () => {
  it('keeps drafts while the question is still active', async () => {
    const activeRequest = request();
    setState('questions', [activeRequest]);

    renderQuestionPrompt(activeRequest);

    const input = container?.querySelector<HTMLTextAreaElement>('.question-custom-input');
    expect(input).not.toBeNull();

    input!.value = 'Keep this draft';
    input!.dispatchEvent(new Event('input', { bubbles: true }));

    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();

    renderQuestionPrompt(activeRequest);

    expect(container?.querySelector<HTMLTextAreaElement>('.question-custom-input')?.value).toBe(
      'Keep this draft'
    );
  });

  it('drops drafts once the question is no longer present', async () => {
    const activeRequest = request();
    setState('questions', [activeRequest]);

    renderQuestionPrompt(activeRequest);

    const input = container?.querySelector<HTMLTextAreaElement>('.question-custom-input');
    expect(input).not.toBeNull();

    input!.value = 'Discard this draft';
    input!.dispatchEvent(new Event('input', { bubbles: true }));

    setState('questions', []);
    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();

    renderQuestionPrompt(activeRequest);

    expect(container?.querySelector<HTMLTextAreaElement>('.question-custom-input')?.value).toBe('');
  });

  it('evicts the oldest draft after retaining 100 pending questions', async () => {
    const activeRequests = Array.from({ length: 101 }, (_, index) =>
      request(`bounded-draft-${index}`)
    );
    setState('questions', activeRequests);

    for (const [index, activeRequest] of activeRequests.entries()) {
      renderQuestionPrompt(activeRequest);
      const input = container?.querySelector<HTMLTextAreaElement>('.question-custom-input');
      input!.value = `Draft ${index}`;
      input!.dispatchEvent(new Event('input', { bubbles: true }));
      cleanup?.();
      cleanup = undefined;
      await Promise.resolve();
    }

    renderQuestionPrompt(activeRequests[0]!);
    expect(container?.querySelector<HTMLTextAreaElement>('.question-custom-input')?.value).toBe('');

    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();
    renderQuestionPrompt(activeRequests.at(-1)!);
    expect(container?.querySelector<HTMLTextAreaElement>('.question-custom-input')?.value).toBe(
      'Draft 100'
    );
  });

  it('keeps the answer draft and restores controls when answering fails', async () => {
    const activeRequest = request('failed-answer');
    setState('questions', [activeRequest]);
    respondQuestionMock.mockRejectedValueOnce(new Error('answer failed'));
    renderQuestionPrompt(activeRequest);

    const input = container?.querySelector<HTMLTextAreaElement>('.question-custom-input');
    input!.value = 'Retry this answer';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    container
      ?.querySelector<HTMLButtonElement>('.question-btn-primary')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();

    expect(respondQuestionMock).toHaveBeenCalledWith(activeRequest.id, [['Retry this answer']], {
      rethrow: true,
    });
    expect(input?.value).toBe('Retry this answer');
    expect(container?.querySelector<HTMLButtonElement>('.question-btn-primary')?.disabled).toBe(
      false
    );
    expect(skipButton().disabled).toBe(false);

    cleanup?.();
    cleanup = undefined;
    await Promise.resolve();
    renderQuestionPrompt(activeRequest);
    expect(container?.querySelector<HTMLTextAreaElement>('.question-custom-input')?.value).toBe(
      'Retry this answer'
    );
  });

  it('keeps the draft and restores controls when skipping fails', async () => {
    const activeRequest = request('failed-skip');
    setState('questions', [activeRequest]);
    rejectQuestionMock.mockRejectedValueOnce(new Error('skip failed'));
    renderQuestionPrompt(activeRequest);

    const input = container?.querySelector<HTMLTextAreaElement>('.question-custom-input');
    input!.value = 'Do not discard this';
    input!.dispatchEvent(new Event('input', { bubbles: true }));
    click(skipButton());
    await Promise.resolve();
    await Promise.resolve();

    expect(rejectQuestionMock).toHaveBeenCalledWith(activeRequest.id, { rethrow: true });
    expect(input?.value).toBe('Do not discard this');
    expect(container?.querySelector<HTMLButtonElement>('.question-btn-primary')?.disabled).toBe(
      false
    );
    expect(skipButton().disabled).toBe(false);
  });
});

function multiQuestionRequest(): QuestionRequest {
  return {
    id: 'question-multi',
    sessionID: 'session-1',
    questions: [
      {
        question: 'Which languages?',
        header: 'Languages',
        multiple: true,
        options: [
          { label: 'TypeScript', description: '' },
          { label: 'Rust', description: '' },
          { label: 'Go', description: '' },
        ],
      },
      {
        question: 'Which runtime?',
        header: 'Runtime',
        options: [
          { label: 'Node', description: '' },
          { label: 'Bun', description: '' },
        ],
      },
    ],
  };
}

function options() {
  return Array.from(
    container!.querySelectorAll<HTMLElement>('.question-option:not(.question-option-custom)')
  );
}

function optionByLabel(label: string) {
  const match = options().find(
    (option) => option.querySelector('.question-option-label')?.textContent === label
  );
  if (!match) throw new Error(`No option labelled ${label}`);
  return match;
}

function customOption() {
  return container!.querySelector<HTMLElement>('.question-option-custom')!;
}

function customInput() {
  return container!.querySelector<HTMLTextAreaElement>('.question-custom-input')!;
}

function primaryButton() {
  return container!.querySelector<HTMLButtonElement>('.question-btn-primary')!;
}

function backButton() {
  return (
    Array.from(
      container!.querySelectorAll<HTMLButtonElement>('.question-prompt-actions button')
    ).find((button) => button.textContent === 'Back') ?? null
  );
}

function skipButton() {
  return Array.from(
    container!.querySelectorAll<HTMLButtonElement>('.question-prompt-actions button')
  ).find((button) => button.textContent === 'Skip')!;
}

function stepIndicator() {
  return container!.querySelector('.question-prompt-step')?.textContent;
}

function click(element: HTMLElement) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function type(input: HTMLTextAreaElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressKey(element: HTMLElement, key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

describe('QuestionPrompt single-select', () => {
  it('disables the primary action until an option is chosen', () => {
    renderQuestionPrompt(request());

    expect(primaryButton().disabled).toBe(true);

    click(optionByLabel('Option A'));

    expect(primaryButton().disabled).toBe(false);
  });

  it('submits the chosen option', async () => {
    renderQuestionPrompt(request());

    click(optionByLabel('Option A'));
    click(primaryButton());
    await Promise.resolve();

    expect(respondQuestionMock).toHaveBeenCalledWith('question-1', [['Option A']], {
      rethrow: true,
    });
  });

  it('deselects an option when it is clicked twice', () => {
    renderQuestionPrompt(request());

    click(optionByLabel('Option A'));
    click(optionByLabel('Option A'));

    expect(optionByLabel('Option A').getAttribute('aria-checked')).toBe('false');
    expect(primaryButton().disabled).toBe(true);
  });

  it('toggles an option with the keyboard', () => {
    renderQuestionPrompt(request());

    const event = pressKey(optionByLabel('Option A'), 'Enter');

    expect(event.defaultPrevented).toBe(true);
    expect(optionByLabel('Option A').getAttribute('aria-checked')).toBe('true');
  });

  it('ignores keys other than Enter and Space on an option', () => {
    renderQuestionPrompt(request());

    pressKey(optionByLabel('Option A'), 'Tab');

    expect(optionByLabel('Option A').getAttribute('aria-checked')).toBe('false');
  });

  it('renders options as radios when only one answer is allowed', () => {
    renderQuestionPrompt(request());

    expect(optionByLabel('Option A').getAttribute('role')).toBe('radio');
    expect(container!.querySelector('.question-prompt-options')?.getAttribute('role')).toBe(
      'radiogroup'
    );
  });
});

describe('QuestionPrompt custom answers', () => {
  it('submits a typed answer in place of the listed options', async () => {
    renderQuestionPrompt(request());

    type(customInput(), 'Something else\nWith more detail');
    click(primaryButton());
    await Promise.resolve();

    expect(respondQuestionMock).toHaveBeenCalledWith(
      'question-1',
      [['Something else\nWith more detail']],
      { rethrow: true }
    );
  });

  it('clears a typed answer when a listed option is picked instead', () => {
    renderQuestionPrompt(request());

    type(customInput(), 'Something else');
    click(optionByLabel('Option A'));

    expect(customInput().value).toBe('');
  });

  it('clears the selected option when a custom answer is typed', () => {
    renderQuestionPrompt(request());

    click(optionByLabel('Option A'));
    type(customInput(), 'Something else');

    expect(optionByLabel('Option A').getAttribute('aria-checked')).toBe('false');
  });

  it('ignores a whitespace-only custom answer', () => {
    renderQuestionPrompt(request());

    type(customInput(), '   ');

    expect(primaryButton().disabled).toBe(true);
  });

  it('marks the custom row as checked once it holds text', () => {
    renderQuestionPrompt(request());

    expect(customOption().getAttribute('aria-checked')).toBe('false');

    type(customInput(), 'Something else');

    expect(customOption().getAttribute('aria-checked')).toBe('true');
  });

  it('submits a custom answer on Enter', async () => {
    renderQuestionPrompt(request());

    type(customInput(), 'Something else\nWith more detail');
    const event = pressKey(customInput(), 'Enter');
    await Promise.resolve();

    expect(event.defaultPrevented).toBe(true);
    expect(respondQuestionMock).toHaveBeenCalledWith(
      'question-1',
      [['Something else\nWith more detail']],
      { rethrow: true }
    );
  });

  it('allows Shift+Enter to add a new line in the custom input', () => {
    renderQuestionPrompt(request());

    type(customInput(), 'Something else');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    customInput().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(respondQuestionMock).not.toHaveBeenCalled();
  });

  it('submits from the custom input with Ctrl+Enter', async () => {
    renderQuestionPrompt(request());

    type(customInput(), 'Something else');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    customInput().dispatchEvent(event);
    await Promise.resolve();

    expect(event.defaultPrevented).toBe(true);
    expect(respondQuestionMock).toHaveBeenCalledOnce();
  });

  it('does not submit on Enter while composing', () => {
    renderQuestionPrompt(request());

    type(customInput(), 'Something else');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    customInput().dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(respondQuestionMock).not.toHaveBeenCalled();
  });

  it('hides the custom row when the question opts out', () => {
    renderQuestionPrompt({
      id: 'question-no-custom',
      sessionID: 'session-1',
      questions: [
        {
          question: 'Pick one',
          header: 'Choice',
          custom: false,
          options: [{ label: 'Only', description: '' }],
        },
      ],
    });

    expect(container!.querySelector('.question-option-custom')).toBeNull();
  });
});

describe('QuestionPrompt multi-step flow', () => {
  it('advances and submits custom answers with Enter', async () => {
    renderQuestionPrompt(multiQuestionRequest());

    type(customInput(), 'Zig');
    pressKey(customInput(), 'Enter');

    expect(stepIndicator()).toBe('2 / 2');
    expect(respondQuestionMock).not.toHaveBeenCalled();

    type(customInput(), 'Deno');
    pressKey(customInput(), 'Enter');
    await Promise.resolve();

    expect(respondQuestionMock).toHaveBeenCalledWith('question-multi', [['Zig'], ['Deno']], {
      rethrow: true,
    });
  });

  it('shows a step indicator and advances instead of submitting', () => {
    renderQuestionPrompt(multiQuestionRequest());

    expect(stepIndicator()).toBe('1 / 2');
    expect(primaryButton().textContent).toBe('Next');

    click(optionByLabel('TypeScript'));
    click(primaryButton());

    expect(stepIndicator()).toBe('2 / 2');
    expect(primaryButton().textContent).toBe('Submit');
    expect(respondQuestionMock).not.toHaveBeenCalled();
  });

  it('accumulates several picks on a multi-select question', () => {
    renderQuestionPrompt(multiQuestionRequest());

    click(optionByLabel('TypeScript'));
    click(optionByLabel('Rust'));

    expect(optionByLabel('TypeScript').getAttribute('aria-checked')).toBe('true');
    expect(optionByLabel('Rust').getAttribute('aria-checked')).toBe('true');
    expect(optionByLabel('Go').getAttribute('aria-checked')).toBe('false');
  });

  it('renders multi-select options as checkboxes in a group', () => {
    renderQuestionPrompt(multiQuestionRequest());

    expect(optionByLabel('TypeScript').getAttribute('role')).toBe('checkbox');
    expect(container!.querySelector('.question-prompt-options')?.getAttribute('role')).toBe(
      'group'
    );
  });

  it('keeps a custom answer alongside listed picks when multiple are allowed', async () => {
    renderQuestionPrompt(multiQuestionRequest());

    click(optionByLabel('TypeScript'));
    type(customInput(), 'Zig');
    click(primaryButton());
    click(optionByLabel('Node'));
    click(primaryButton());
    await Promise.resolve();

    expect(respondQuestionMock).toHaveBeenCalledWith(
      'question-multi',
      [['TypeScript', 'Zig'], ['Node']],
      { rethrow: true }
    );
  });

  it('uses the same secondary style for Back and Skip while keeping Submit primary', () => {
    renderQuestionPrompt(multiQuestionRequest());

    expect(skipButton().className).toBe('question-btn question-btn-secondary');

    click(optionByLabel('TypeScript'));
    click(primaryButton());

    expect(backButton()!.className).toBe(skipButton().className);
    expect(primaryButton().className).toBe('question-btn question-btn-primary');
    expect(primaryButton().textContent).toBe('Submit');
  });

  it('offers Back only after the first step and restores the earlier answer', () => {
    renderQuestionPrompt(multiQuestionRequest());

    expect(backButton()).toBeNull();

    click(optionByLabel('TypeScript'));
    click(primaryButton());
    expect(backButton()).not.toBeNull();

    click(backButton()!);

    expect(stepIndicator()).toBe('1 / 2');
    expect(optionByLabel('TypeScript').getAttribute('aria-checked')).toBe('true');
  });

  it('does not advance while the current step has no answer', () => {
    renderQuestionPrompt(multiQuestionRequest());

    expect(primaryButton().disabled).toBe(true);
    click(primaryButton());

    expect(stepIndicator()).toBe('1 / 2');
  });

  it('omits the step indicator for a single question', () => {
    renderQuestionPrompt(request());

    expect(container!.querySelector('.question-prompt-step')).toBeNull();
  });
});
