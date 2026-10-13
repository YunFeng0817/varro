/* oxlint-disable anti-slop/no-module-mocking -- Exercise dictation UI without a real extension host or microphone. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { ExtensionMessage, WebviewMessage } from '../../../shared/protocol';
import { microphoneIcon, microphoneSpeakingSolidIcon } from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';

interface TestBridgeContext {
  handler?: (message: ExtensionMessage) => void;
}

const mocks = vi.hoisted(() => {
  const context: TestBridgeContext = {};
  return {
    post: vi.fn<(message: WebviewMessage) => boolean>(),
    feedback: vi.fn(),
    context,
    unsubscribe: vi.fn(),
  };
});
vi.mock('../../lib/bridge', () => ({
  postMessage: mocks.post,
  onMessage: (handler: (message: ExtensionMessage) => void) => {
    mocks.context.handler = handler;
    return mocks.unsubscribe;
  },
}));
vi.mock('../chat/SessionActionFeedback', () => ({ showSessionActionFeedback: mocks.feedback }));
import { DictationButton } from './DictationButton';

let container: HTMLDivElement;
let dispose: (() => void) | undefined;
const focus = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.post.mockReturnValue(true);
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  vi.useRealTimers();
});

function reply(available = true, running = true, error?: string) {
  const message = mocks.post.mock.calls.at(-1)?.[0];
  if (message?.type !== 'handy/request') throw new Error('Missing Handy request');
  const payload: Extract<ExtensionMessage, { type: 'handy/result' }>['payload'] = {
    requestId: message.payload.requestId,
    available,
    running,
  };
  if (error) payload.error = error;
  mocks.context.handler?.({ type: 'handy/result', payload });
}
function button() {
  const result = container.querySelector('button');
  if (!result) throw new Error('Missing dictation button');
  return result;
}
function mount(remote = false) {
  dispose = render(() => <DictationButton focusComposer={focus} remote={remote} />, container);
}

describe('DictationButton', () => {
  it('is hidden without Handy and never probes remote hosts', () => {
    mount(true);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(container.querySelector('button')).toBeNull();
    dispose?.();
    mount();
    reply(false, false);
    expect(container.querySelector('button')).toBeNull();
  });

  it('shows the microphone disabled when Handy is installed but stopped', () => {
    mount();
    reply(true, false);
    expect(button().disabled).toBe(true);
    expect(
      button().querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(microphoneIcon));
  });

  it('focuses the composer, prevents repeat clicks, and changes icons only after acknowledgement', () => {
    mount();
    reply();
    button().click();
    expect(focus).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { action: 'toggle' } });
    expect(button().disabled).toBe(true);
    expect(button().getAttribute('aria-pressed')).toBe('false');
    button().click();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    reply();
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(
      button().querySelector<HTMLElement>('.ui-icon')?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(microphoneSpeakingSolidIcon));
    button().click();
    reply();
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('preserves mouse focus and supports cancellation with right-click', () => {
    mount();
    reply();
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    button().click();
    reply();
    button().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(mocks.post.mock.calls.at(-1)?.[0]).toMatchObject({ payload: { action: 'cancel' } });
    reply();
    expect(button().getAttribute('aria-pressed')).toBe('false');
  });

  it('ignores unrelated responses and reports failures without replaying commands', () => {
    mount();
    reply();
    button().click();
    mocks.context.handler?.({
      type: 'handy/result',
      payload: { requestId: 'other', available: true, running: true },
    });
    expect(button().disabled).toBe(true);
    reply(true, true, 'CLI failed');
    expect(mocks.feedback).toHaveBeenCalledWith('CLI failed', 'warning');
    expect(button().getAttribute('aria-pressed')).toBe('false');
    button().click();
    vi.advanceTimersByTime(8_000);
    expect(mocks.feedback).toHaveBeenLastCalledWith(
      expect.stringContaining('Check its recording state'),
      'warning'
    );
    expect(mocks.post).toHaveBeenCalledTimes(3);
  });

  it('refreshes availability and stops all work on unmount', () => {
    mount();
    reply(false, false);
    window.dispatchEvent(new Event('focus'));
    reply();
    expect(button().disabled).toBe(false);
    vi.advanceTimersByTime(30_000);
    reply(true, false);
    expect(button().disabled).toBe(true);
    dispose?.();
    dispose = undefined;
    const calls = mocks.post.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event('focus'));
    expect(mocks.post).toHaveBeenCalledTimes(calls);
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
