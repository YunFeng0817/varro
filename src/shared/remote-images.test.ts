import { describe, expect, it } from 'vitest';
import { parseRemoteImageMode, parseRemoteImageUrl } from './remote-images';

describe('remote image policy', () => {
  it('defaults to ask and admits off and on only explicitly', () => {
    expect(parseRemoteImageMode('ask')).toBe('ask');
    expect(parseRemoteImageMode('off')).toBe('off');
    expect(parseRemoteImageMode('on')).toBe('on');
    for (const value of [undefined, null, true, 'auto'])
      expect(parseRemoteImageMode(value)).toBe('ask');
  });

  it('normalizes HTTPS URLs and removes fragments', () => {
    expect(parseRemoteImageUrl('https://IMAGES.example:443/a.png?size=2#preview')?.href).toBe(
      'https://images.example/a.png?size=2'
    );
  });

  it('also bounds the normalized URL and DNS hostname', () => {
    expect(parseRemoteImageUrl('https://images.test/' + '日'.repeat(1000))).toBeNull();
    expect(parseRemoteImageUrl(`https://${'long.'.repeat(60)}test/a.png`)).toBeNull();
  });

  it.each([
    'http://example.com/a.png',
    'file:///a.png',
    'data:image/png;base64,AA==',
    'javascript:alert(1)',
    '//example.com/a.png',
    'https://user:secret@example.com/a.png',
    'https://example.com:444/a.png',
    'https://example.com/' + 'x'.repeat(4096),
  ])('rejects %s', (url) => {
    expect(parseRemoteImageUrl(url)).toBeNull();
  });
});
