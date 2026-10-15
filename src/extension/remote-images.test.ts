/* oxlint-disable anti-slop/no-module-mocking -- The HTTPS boundary is mocked to verify request policy without contacting public or private servers. */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({
  request:
    vi.fn<
      (
        url: URL,
        options: RequestOptions,
        response: (message: IncomingMessage) => void
      ) => EventEmitter & { end: () => void }
    >(),
}));
vi.mock('node:https', () => ({ request: transport.request }));

import { RemoteImages, downloadRemoteImage, isPublicImageAddress } from './remote-images';

const thumbnail = 'data:image/webp;base64,AAAA';
const signal = () => new AbortController().signal;

function setup() {
  const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
  const download = vi.fn(async () => ({ bytes: new Uint8Array([1, 2]), format: 'png' as const }));
  const thumbnails = {
    peek: vi.fn<() => string | undefined>(() => undefined),
    getInput: vi.fn(async () => thumbnail),
    dispose: vi.fn(),
  };
  const images = new RemoteImages({ resolve, download, thumbnails });
  return { images, resolve, download, thumbnails };
}

afterEach(() => vi.clearAllMocks());

describe('public image addresses', () => {
  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'admits %s',
    (address) => expect(isPublicImageAddress(address)).toBe(true)
  );
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:8.8.8.8',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '64:ff9b::a00:1',
    '2002:a00:1::1',
    '2001::1',
    '2001:db8::1',
    '3fff::1',
    'not-an-address',
  ])('rejects %s', (address) => expect(isPublicImageAddress(address)).toBe(false));
});

describe('RemoteImages', () => {
  it('pins the approved address and converts bytes to a bounded thumbnail', async () => {
    const { images, download, thumbnails } = setup();
    expect(await images.load('https://images.test/a.png', signal())).toEqual({
      url: thumbnail,
      hostname: 'images.test',
    });
    expect(download).toHaveBeenCalledWith(
      new URL('https://images.test/a.png'),
      { address: '93.184.216.34', family: 4 },
      expect.any(AbortSignal)
    );
    expect(thumbnails.getInput).toHaveBeenCalledOnce();
    images.dispose();
  });

  it('refuses mixed public/private DNS answers before connecting', async () => {
    const { images, resolve, download } = setup();
    resolve.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]);
    await expect(images.load('https://images.test/a.png', signal())).rejects.toThrow(
      'public internet'
    );
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    'https://127.1/a.png',
    'https://2130706433/a.png',
    'https://[::1]/a.png',
    'https://[::ffff:7f00:1]/a.png',
  ])('blocks normalized private literals in %s', async (source) => {
    const { images, resolve, download } = setup();
    await expect(images.load(source, signal())).rejects.toThrow('public internet');
    expect(resolve).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('validates redirect targets before making their request', async () => {
    const { images, resolve, thumbnails } = setup();
    const download = vi.fn(async () => ({ redirect: 'https://127.0.0.1/private' }));
    const redirected = new RemoteImages({ resolve, download, thumbnails });
    await expect(redirected.load('https://images.test/a.png', signal())).rejects.toThrow(
      'public internet'
    );
    expect(download).toHaveBeenCalledOnce();
    images.dispose();
    redirected.dispose();
  });

  it.each([
    'http://images.test/a.png',
    'https://user:secret@images.test/a.png',
    'https://images.test:444/a.png',
  ])('rejects unsafe redirect %s', async (redirect) => {
    const { resolve, thumbnails } = setup();
    const download = vi.fn(async () => ({ redirect }));
    const images = new RemoteImages({ resolve, download, thumbnails });
    await expect(images.load('https://images.test/a.png', signal())).rejects.toThrow(
      'allowed HTTPS'
    );
    expect(download).toHaveBeenCalledOnce();
    images.dispose();
  });

  it('follows relative redirects with freshly checked DNS and caps redirect loops', async () => {
    const { resolve, thumbnails } = setup();
    const download = vi.fn(async () => ({ redirect: '/next.png' }));
    const images = new RemoteImages({ resolve, download, thumbnails });
    await expect(images.load('https://images.test/a.png', signal())).rejects.toThrow(
      'too many redirects'
    );
    expect(resolve).toHaveBeenCalledTimes(4);
    expect(download).toHaveBeenCalledTimes(4);
    images.dispose();
  });

  it('uses cached thumbnails without contacting the image server', async () => {
    const { images, download, resolve, thumbnails } = setup();
    thumbnails.peek.mockReturnValue(thumbnail);
    await images.load('https://images.test/a.png', signal());
    expect(resolve).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('deduplicates overlapping loads and keeps the other caller alive after cancellation', async () => {
    const { images, resolve, download } = setup();
    let finish!: (value: { address: string; family: number }[]) => void;
    resolve.mockReturnValue(
      new Promise((res) => {
        finish = res;
      })
    );
    const cancelled = new AbortController();
    const first = images.load('https://images.test/a.png', cancelled.signal);
    const failure = expect(first).rejects.toThrow();
    const second = images.load('https://images.test/a.png', signal());
    cancelled.abort();
    finish([{ address: '93.184.216.34', family: 4 }]);
    await failure;
    expect(await second).toEqual({ url: thumbnail, hostname: 'images.test' });
    expect(resolve).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledOnce();
  });

  it('limits distinct concurrent loads and aborts work on disposal', async () => {
    const { images, resolve, download } = setup();
    let finish!: (value: { address: string; family: number }[]) => void;
    const pending = new Promise<{ address: string; family: number }[]>((res) => {
      finish = res;
    });
    resolve.mockReturnValue(pending);
    const first = images.load('https://images.test/1.png', signal());
    const second = images.load('https://images.test/2.png', signal());
    const failures = Promise.all([
      expect(first).rejects.toThrow(),
      expect(second).rejects.toThrow(),
    ]);
    await expect(images.load('https://images.test/3.png', signal())).rejects.toThrow(
      'already loading'
    );
    images.dispose();
    finish([{ address: '93.184.216.34', family: 4 }]);
    await failures;
    expect(download).not.toHaveBeenCalled();
    await expect(images.load('https://images.test/4.png', signal())).rejects.toThrow('disposed');
  });

  it('rejects failed image decoding', async () => {
    const { resolve, download, thumbnails } = setup();
    const images = new RemoteImages({
      resolve,
      download,
      thumbnails: { ...thumbnails, getInput: vi.fn(async () => null) },
    });
    await expect(images.load('https://images.test/a.png', signal())).rejects.toThrow('pixel limit');
  });

  it('enforces the deadline even while DNS is unresolved', async () => {
    const { images, resolve, download } = setup();
    resolve.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const pending = images.load('https://images.test/a.png', signal());
    const failure = expect(pending).rejects.toThrow('deadline');
    expect(timeout).toHaveBeenCalledWith(15_000);
    controller.abort(new Error('Image load deadline'));
    await failure;
    expect(download).not.toHaveBeenCalled();
    timeout.mockRestore();
    images.dispose();
  });
});

function mockResponse(statusCode: number, headers: IncomingMessage['headers'], chunks: Buffer[]) {
  // SAFETY: The controlled stream supplies exactly the IncomingMessage fields used by the downloader.
  const response = Object.assign(new PassThrough(), { statusCode, headers });
  transport.request.mockImplementation((_url, _options, callback) => {
    const req = Object.assign(new EventEmitter(), {
      end: () => {
        // SAFETY: The mock only consumes the status, headers, and readable stream interface.
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- The mock provides a readable response stream without requiring a live socket.
        callback(response as unknown as IncomingMessage);
        for (const chunk of chunks) response.write(chunk);
        response.end();
      },
    });
    return req;
  });
  return response;
}

describe('HTTPS download boundary', () => {
  it('uses a pinned lookup and sends no ambient authentication or referrer', async () => {
    mockResponse(200, { 'content-type': 'image/png' }, [Buffer.from([1, 2])]);
    const result = await downloadRemoteImage(
      new URL('https://images.test/a.png'),
      { address: '8.8.8.8', family: 4 },
      signal()
    );
    expect(result).toEqual({ bytes: new Uint8Array([1, 2]), format: 'png' });
    const options = transport.request.mock.calls[0]![1];
    expect(options.agent).toBe(false);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.family).toBe(4);
    expect(options.headers).toEqual({
      Accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif',
    });
    const callback = vi.fn();
    options.lookup?.('images.test', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });

  it.each(['image/svg+xml', 'text/html', 'application/octet-stream'])(
    'rejects %s before reading its body',
    async (type) => {
      const response = mockResponse(200, { 'content-type': type }, []);
      await expect(
        downloadRemoteImage(
          new URL('https://images.test/a'),
          { address: '8.8.8.8', family: 4 },
          signal()
        )
      ).rejects.toThrow('raster');
      expect(response.destroyed).toBe(true);
    }
  );

  it('bounds response bytes even without Content-Length', async () => {
    mockResponse(200, { 'content-type': 'image/png' }, [
      Buffer.alloc(8 * 1024 * 1024),
      Buffer.alloc(1),
    ]);
    await expect(
      downloadRemoteImage(
        new URL('https://images.test/a'),
        { address: '8.8.8.8', family: 4 },
        signal()
      )
    ).rejects.toThrow('too large');
  });

  it.each([
    { 'content-type': 'image/png', 'content-length': String(9 * 1024 * 1024) },
    { 'content-type': 'image/png', 'content-encoding': 'gzip' },
  ])('rejects an oversized or encoded response', async (headers) => {
    mockResponse(200, headers, []);
    await expect(
      downloadRemoteImage(
        new URL('https://images.test/a'),
        { address: '8.8.8.8', family: 4 },
        signal()
      )
    ).rejects.toThrow('download policy');
  });
});
