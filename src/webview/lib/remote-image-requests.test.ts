import { describe, expect, it, vi } from 'vitest';
import type { RemoteImageResponse } from '../../shared/remote-images';
import { RemoteImageRequests } from './remote-image-requests';

const image = { url: 'data:image/webp;base64,AAAA', hostname: 'images.test' };
const signal = () => new AbortController().signal;

describe('remote image request queue', () => {
  it('starts no more than two requests and continues through the remaining images', async () => {
    const finish: Array<(image: RemoteImageResponse) => void> = [];
    const request = vi.fn(
      () => new Promise<RemoteImageResponse>((resolve) => finish.push(resolve))
    );
    const queue = new RemoteImageRequests(request);
    const first = queue.load('https://images.test/1.png', signal());
    const second = queue.load('https://images.test/2.png', signal());
    const third = queue.load('https://images.test/3.png', signal());
    expect(request).toHaveBeenCalledTimes(2);
    finish[0]!(image);
    await first;
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    finish[1]!(image);
    finish[2]!(image);
    await Promise.all([second, third]);
  });

  it('removes canceled queued work without contacting the host', async () => {
    const finish: Array<(image: RemoteImageResponse) => void> = [];
    const request = vi.fn(
      () => new Promise<RemoteImageResponse>((resolve) => finish.push(resolve))
    );
    const queue = new RemoteImageRequests(request);
    const first = queue.load('https://images.test/1.png', signal());
    const second = queue.load('https://images.test/2.png', signal());
    const controller = new AbortController();
    const third = queue.load('https://images.test/3.png', controller.signal);
    const canceled = expect(third).rejects.toThrow();
    controller.abort();
    await canceled;
    finish[0]!(image);
    finish[1]!(image);
    await Promise.all([first, second]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not stop the queue after an image fails', async () => {
    const request = vi.fn(async () => image).mockRejectedValueOnce(new Error('HTTP 403'));
    const queue = new RemoteImageRequests(request);
    const first = expect(queue.load('https://images.test/1.png', signal())).rejects.toThrow('403');
    const second = queue.load('https://images.test/2.png', signal());
    const third = queue.load('https://images.test/3.png', signal(), true);
    await first;
    await Promise.all([second, third]);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
