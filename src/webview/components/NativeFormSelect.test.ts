import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { createComponent, render } from 'solid-js/web';
import { NativeFormSelect } from './NativeFormSelect';

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
});

function setup(initial = '') {
  const [value, setValue] = createSignal(initial);
  const [disabled, setDisabled] = createSignal(false);
  const changed = vi.fn((next: string) => setValue(next));
  cleanup = render(
    () =>
      createComponent(NativeFormSelect, {
        label: 'Region',
        get value() {
          return value();
        },
        get disabled() {
          return disabled();
        },
        invalid: false,
        describedBy: 'region-description',
        onChange: changed,
        options: [
          { value: '', label: 'Unanswered' },
          { value: 'a', label: 'Same', description: 'First region' },
          { value: 'b', label: 'Same', description: 'Second region' },
        ],
      }),
    container
  );
  const trigger = container.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  const press = (key: string) =>
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return { trigger, press, value, changed, setDisabled };
}

describe('native form themed select', () => {
  it('renders a custom listbox and preserves identity for duplicate labels', () => {
    const { trigger, value, changed } = setup();
    trigger.click();
    const menu = document.getElementById(trigger.getAttribute('aria-controls')!)!;
    expect(menu.getAttribute('role')).toBe('listbox');
    expect(document.querySelector('select')).toBeNull();
    expect(menu.querySelector('[aria-selected="true"]')?.textContent).toContain('Unanswered');
    menu.querySelector<HTMLButtonElement>('[data-value="b"]')!.click();
    expect(value()).toBe('b');
    expect(changed).toHaveBeenCalledOnce();
    expect(trigger.textContent).toContain('Same');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('supports arrows, Home, End, Enter and typeahead without implicitly selecting or submitting', () => {
    const { trigger, press, changed, value } = setup();
    trigger.focus();
    press('ArrowDown');
    press('End');
    expect(changed).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-activedescendant')).toMatch(/-2$/);
    press('Enter');
    expect(value()).toBe('b');
    press(' ');
    press('Home');
    press('Enter');
    expect(value()).toBe('');
    press('s');
    press('Enter');
    expect(value()).toBe('a');
    press('ArrowUp');
    press('ArrowUp');
    press('Enter');
    expect(value()).toBe('');
  });

  it('dismisses on Escape, Tab, outside pointer and transcript scroll without changing the answer', () => {
    const { trigger, press, changed, value } = setup('a');
    trigger.focus();
    for (const key of ['Escape', 'Tab']) {
      trigger.click();
      press(key);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
    }
    trigger.click();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.click();
    document.dispatchEvent(new Event('scroll'));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(value()).toBe('a');
    expect(changed).not.toHaveBeenCalled();
  });

  it('closes and disables the menu while the form response is pending', () => {
    const { trigger, press, changed, setDisabled } = setup();
    trigger.click();
    setDisabled(true);
    expect(trigger.disabled).toBe(true);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    press('ArrowDown');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(changed).not.toHaveBeenCalled();
  });
});
