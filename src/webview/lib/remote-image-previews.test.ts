import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRemoteImagePreviews,
  getRemoteImagePreview,
  rememberRemoteImagePreview,
} from './remote-image-previews';

afterEach(() => {
  clearRemoteImagePreviews();
  vi.useRealTimers();
});

const image = { url: 'data:image/webp;base64,AAAA', hostname: 'images.test' };

describe('approved remote image previews', () => {
  it('retains a thumbnail only for its workspace/session-scoped key', () => {
    rememberRemoteImagePreview('workspace-a\u0000session-a\u0000url', image);
    expect(getRemoteImagePreview('workspace-a\u0000session-a\u0000url')).toBe(image);
    expect(getRemoteImagePreview('workspace-b\u0000session-a\u0000url')).toBeNull();
    clearRemoteImagePreviews();
    expect(getRemoteImagePreview('workspace-a\u0000session-a\u0000url')).toBeNull();
  });

  it('expires approvals without triggering any work', () => {
    vi.useFakeTimers();
    rememberRemoteImagePreview('expired', image);
    vi.advanceTimersByTime(5 * 60_000);
    expect(getRemoteImagePreview('expired')).toBeNull();
  });

  it('bounds both cached preview count and bytes', () => {
    for (let index = 0; index < 65; index += 1) rememberRemoteImagePreview(String(index), image);
    expect(getRemoteImagePreview('0')).toBeNull();
    expect(getRemoteImagePreview('64')).toBe(image);
    rememberRemoteImagePreview('large', { ...image, url: 'A'.repeat(3 * 1024 * 1024) });
    expect(getRemoteImagePreview('large')).toBeNull();
    expect(getRemoteImagePreview('64')).toBeNull();
  });
});
