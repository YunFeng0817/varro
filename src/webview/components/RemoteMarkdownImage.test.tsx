/* oxlint-disable anti-slop/no-module-mocking -- Mock the host RPC boundary while exercising image consent and lifecycle in the DOM. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { RemoteImageResponse } from '../../shared/remote-images';
import { setState } from '../lib/state';

const bridge = vi.hoisted(() => ({
  apiCall:
    vi.fn<
      (
        method: string,
        path: string,
        body: { url: string; automatic?: boolean },
        options: { signal: AbortSignal; retries: number; timeoutMs: number }
      ) => Promise<RemoteImageResponse>
    >(),
  postMessage: vi.fn(),
}));
vi.mock('../lib/bridge', () => bridge);

import { RemoteMarkdownImage } from './RemoteMarkdownImage';

const preview = { url: 'data:image/webp;base64,AAAA', hostname: 'images.test' };
let container: HTMLDivElement;
let cleanup: (() => void) | undefined;
let sequence = 0;

function mount(source = 'https://images.test/chart.png') {
  cleanup = render(() => <RemoteMarkdownImage source={source} alt="Sales chart" />, container);
}

function imageAction(root: ParentNode = container) {
  return root.querySelector<HTMLButtonElement>(
    '[data-remote-image-load], .remote-markdown-image-preview'
  );
}

beforeEach(() => {
  bridge.apiCall.mockReset().mockResolvedValue(preview);
  bridge.postMessage.mockReset();
  setState('remoteImages', 'off');
  setState('activeSessionId', `remote-image-test-${++sequence}`);
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  setState('remoteImages', 'off');
  setState('activeSessionId', null);
  vi.unstubAllGlobals();
});

describe('RemoteMarkdownImage', () => {
  it('shows only alt text while disabled', () => {
    mount();
    expect(container.textContent).toBe('Sales chart');
    expect(container.querySelector('button, img')).toBeNull();
    expect(bridge.apiCall).not.toHaveBeenCalled();
  });

  it('does not fetch when opt-in is enabled or a placeholder mounts', () => {
    mount();
    setState('remoteImages', 'ask');
    expect(container.textContent).toContain('images.test');
    expect(imageAction()?.title).toContain('extension host');
    expect(imageAction()?.textContent).toBe('Load image');
    expect(container.querySelector('img')).toBeNull();
    expect(bridge.apiCall).not.toHaveBeenCalled();
  });

  it('loads only on click and previews the data URL without further fetching', async () => {
    setState('remoteImages', 'ask');
    mount();
    imageAction()?.click();
    expect(bridge.apiCall).toHaveBeenCalledWith(
      'POST',
      '/varro/remote-image',
      { url: 'https://images.test/chart.png' },
      { signal: expect.any(AbortSignal), retries: 0, timeoutMs: 20_000 }
    );
    await vi.waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).toBe(preview.url)
    );
    imageAction()?.click();
    expect(document.body.querySelector('.chat-image-preview-img')?.getAttribute('src')).toBe(
      preview.url
    );
    document.body.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')?.click();
    expect(bridge.apiCall).toHaveBeenCalledOnce();
  });

  it('reuses an approved thumbnail on remount without a request', async () => {
    setState('remoteImages', 'ask');
    mount();
    imageAction()?.click();
    await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    cleanup?.();
    mount();
    expect(container.querySelector('img')?.getAttribute('src')).toBe(preview.url);
    expect(bridge.apiCall).toHaveBeenCalledOnce();
  });

  it('requires a new click after disabling and re-enabling', async () => {
    setState('remoteImages', 'ask');
    mount();
    imageAction()?.click();
    await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    setState('remoteImages', 'off');
    expect(container.querySelector('img')).toBeNull();
    setState('remoteImages', 'ask');
    expect(imageAction()?.textContent).toBe('Load image');
    expect(bridge.apiCall).toHaveBeenCalledOnce();
  });

  it.each(['off', 'unmount'])(
    'cancels pending requests on %s and ignores late results',
    async (action) => {
      let finish!: (value: RemoteImageResponse) => void;
      bridge.apiCall.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      setState('remoteImages', 'ask');
      mount();
      imageAction()?.click();
      const requestSignal = bridge.apiCall.mock.calls[0]![3].signal;
      if (action === 'off') setState('remoteImages', 'off');
      else cleanup?.();
      expect(requestSignal.aborted).toBe(true);
      finish(preview);
      await Promise.resolve();
      expect(container.querySelector('img')).toBeNull();
    }
  );

  it('shows an actionable failure and retries only on another click', async () => {
    bridge.apiCall.mockRejectedValueOnce(
      new Error('Image URLs must resolve only to public internet addresses')
    );
    setState('remoteImages', 'ask');
    mount();
    imageAction()?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('[role="status"]')?.textContent).toContain('public internet')
    );
    expect(imageAction()?.textContent).toBe('Retry image');
    expect(bridge.apiCall).toHaveBeenCalledOnce();
    imageAction()?.click();
    await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(bridge.apiCall).toHaveBeenCalledTimes(2);
  });

  it('rejects a host response containing a remote source', async () => {
    bridge.apiCall.mockResolvedValue({
      url: 'https://images.test/unsafe.png',
      hostname: 'images.test',
    });
    setState('remoteImages', 'ask');
    mount();
    imageAction()?.click();
    await vi.waitFor(() =>
      expect(container.textContent).toContain('Invalid image preview response')
    );
    expect(container.querySelector('img')).toBeNull();
  });

  it.each(['http://images.test/a.png', 'https://user:secret@images.test/a.png', 'file:///a.png'])(
    'never offers to load unsupported source %s',
    (source) => {
      setState('remoteImages', 'ask');
      mount(source);
      expect(container.textContent).toBe('Sales chart');
      expect(container.querySelector('button')).toBeNull();
    }
  );

  it('does not activate an enclosing Markdown link when loading', async () => {
    setState('remoteImages', 'ask');
    const clicked = vi.fn();
    const anchor = document.createElement('a');
    anchor.href = 'https://other.test/';
    anchor.addEventListener('click', clicked);
    container.append(anchor);
    cleanup = render(
      () => <RemoteMarkdownImage source="https://images.test/chart.png" alt="Chart" />,
      anchor
    );
    imageAction(anchor)?.click();
    expect(clicked).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(anchor.querySelector('img')).not.toBeNull());
  });

  it('loads automatically only after an on-mode image approaches the viewport', async () => {
    let intersect!: () => void;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class implements IntersectionObserver {
        readonly root = null;
        readonly rootMargin = '200px';
        readonly scrollMargin = '0px';
        readonly thresholds = [0];
        constructor(callback: IntersectionObserverCallback) {
          intersect = () =>
            callback(
              [
                {
                  isIntersecting: true,
                  target: container,
                  time: 0,
                  rootBounds: null,
                  boundingClientRect: container.getBoundingClientRect(),
                  intersectionRect: container.getBoundingClientRect(),
                  intersectionRatio: 1,
                },
              ],
              this
            );
        }
        observe() {}
        unobserve() {}
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
        disconnect = disconnect;
      }
    );
    setState('remoteImages', 'on');
    mount();
    expect(bridge.apiCall).not.toHaveBeenCalled();
    intersect();
    await vi.waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(bridge.apiCall).toHaveBeenCalledWith(
      'POST',
      '/varro/remote-image',
      { url: 'https://images.test/chart.png', automatic: true },
      expect.any(Object)
    );
    expect(disconnect).toHaveBeenCalled();
  });

  it('does not automatically retry a failed image in a loop', async () => {
    bridge.apiCall.mockRejectedValue(new Error('Image server returned HTTP 403'));
    setState('remoteImages', 'on');
    mount();
    await vi.waitFor(() => expect(container.textContent).toContain('HTTP 403'));
    await Promise.resolve();
    expect(bridge.apiCall).toHaveBeenCalledOnce();
    expect(imageAction()?.textContent).toBe('Retry image');
  });

  it('cancels an automatic request when returning to ask mode', async () => {
    let finish!: (value: RemoteImageResponse) => void;
    bridge.apiCall.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    setState('remoteImages', 'on');
    mount();
    await vi.waitFor(() => expect(bridge.apiCall).toHaveBeenCalledOnce());
    const requestSignal = bridge.apiCall.mock.calls[0]![3].signal;
    setState('remoteImages', 'ask');
    expect(requestSignal.aborted).toBe(true);
    finish(preview);
    await Promise.resolve();
    expect(container.querySelector('img')).toBeNull();
  });

  it('opens the full source URL exactly once without loading the image or activating an outer link', () => {
    setState('remoteImages', 'ask');
    const outerLink = document.createElement('a');
    const outerClick = vi.fn();
    outerLink.href = 'https://other.test/';
    outerLink.addEventListener('click', outerClick);
    container.append(outerLink);
    const source = 'https://images.test/chart.png?size=large';
    cleanup = render(() => <RemoteMarkdownImage source={source} alt="Chart" />, outerLink);
    const link = container.querySelector<HTMLAnchorElement>('.remote-markdown-image-url');
    expect(link?.textContent).toBe(source);
    expect(JSON.parse(link?.getAttribute('data-vscode-context') ?? '{}')).toMatchObject({
      varroLinkUrl: source,
      varroLinkText: source,
    });
    link?.click();
    expect(outerClick).not.toHaveBeenCalled();
    expect(bridge.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'vscode/open-external',
      payload: { url: source },
    });
    expect(bridge.apiCall).not.toHaveBeenCalled();
  });

  it('copies the full source URL without fetching or opening it', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    setState('remoteImages', 'ask');
    const source = 'https://images.test/a/long/path/chart.png?size=large';
    mount(source);
    container.querySelector<HTMLButtonElement>('.remote-markdown-image-copy-url')?.click();
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Image URL copied"]')).not.toBeNull()
    );
    expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
    expect(bridge.apiCall).not.toHaveBeenCalled();
    expect(bridge.postMessage).not.toHaveBeenCalled();
  });
});
