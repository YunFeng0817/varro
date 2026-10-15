import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { parseRemoteImageUrl } from '../shared/remote-images';
import type { RemoteImageResponse } from '../shared/remote-images';
import { ImageThumbnails } from './image-thumbnails';
import type { ThumbnailFormat } from './image-thumbnail-protocol';

const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_DOWNLOADS = 2;
const DOWNLOAD_TIMEOUT_MS = 15_000;

type DownloadResult =
  | { redirect: string }
  | { bytes: Uint8Array<ArrayBuffer>; format: ThumbnailFormat };

type RemoteImageDependencies = {
  resolve: (hostname: string) => Promise<LookupAddress[]>;
  download: (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<DownloadResult>;
  thumbnails: Pick<ImageThumbnails, 'peek' | 'getInput' | 'dispose'>;
};

/** Conservative public-unicast check, including IPv4-mapped and transition IPv6 exclusions. */
export function isPublicImageAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6 || address.includes('%')) return false;
  const [first = 0, second = 0] = address
    .split(':')
    .slice(0, 2)
    .map((part) => Number.parseInt(part || '0', 16));
  return (
    first >= 0x2000 &&
    first < 0x4000 &&
    first !== 0x2002 &&
    first !== 0x3fff &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
  );
}

function rasterFormat(contentType: string | undefined): ThumbnailFormat | null {
  switch (contentType?.split(';')[0]?.trim().toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpeg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/avif':
      return 'avif';
    default:
      return null;
  }
}

/** Connect to the checked address, retaining the original hostname for TLS and Host. */
export function downloadRemoteImage(
  url: URL,
  address: LookupAddress,
  signal: AbortSignal
): Promise<DownloadResult> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const req = request(
      url,
      {
        method: 'GET',
        agent: false,
        signal,
        rejectUnauthorized: true,
        family: address.family,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif,image/avif' },
      },
      (response) => {
        response.on('error', reject);
        const status = response.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const redirect = response.headers.location;
          response.destroy();
          if (!redirect) reject(new Error('Image redirect has no destination'));
          else resolve({ redirect });
          return;
        }
        const format = rasterFormat(response.headers['content-type']);
        if (status !== 200 || !format) {
          response.destroy();
          reject(
            new Error(
              status !== 200
                ? `Image server returned HTTP ${status}`
                : 'Only raster images are supported'
            )
          );
          return;
        }
        if (
          Number(response.headers['content-length']) > MAX_DOWNLOAD_BYTES ||
          (response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity')
        ) {
          response.destroy();
          reject(new Error('Image response exceeds the download policy'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_DOWNLOAD_BYTES) {
            response.destroy(new Error('Image is too large to download'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({ bytes: Uint8Array.from(Buffer.concat(chunks)), format })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** Downloads only after a manual request. No network request is needed for a cache hit. */
export class RemoteImages {
  private readonly dependencies: RemoteImageDependencies;
  private readonly pending = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<RemoteImageResponse>;
      users: number;
    }
  >();
  private disposed = false;

  constructor(dependencies?: RemoteImageDependencies) {
    this.dependencies = dependencies ?? {
      resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
      download: downloadRemoteImage,
      thumbnails: new ImageThumbnails(),
    };
  }

  async load(source: string, signal: AbortSignal): Promise<RemoteImageResponse> {
    signal.throwIfAborted();
    if (this.disposed) throw new Error('Remote image loader disposed');
    const url = parseRemoteImageUrl(source);
    if (!url)
      throw new Error('Only HTTPS image URLs without credentials on port 443 are supported');
    const key = createHash('sha256').update(url.href).digest('hex');
    const cached = this.dependencies.thumbnails.peek(key);
    if (cached) return { url: cached, hostname: url.hostname };
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= MAX_DOWNLOADS)
        throw new Error('Two images are already loading. Try again shortly.');
      const controller = new AbortController();
      pending = {
        controller,
        users: 0,
        promise: this.download(
          url,
          key,
          AbortSignal.any([controller.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
        ).finally(() => {
          if (this.pending.get(key)?.controller === controller) this.pending.delete(key);
        }),
      };
      this.pending.set(key, pending);
    }
    const entry = pending;
    entry.users += 1;
    try {
      return await new Promise<RemoteImageResponse>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        void entry.promise
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
    } finally {
      entry.users -= 1;
      if (!entry.users && this.pending.get(key) === entry) {
        this.pending.delete(key);
        entry.controller.abort();
      }
    }
  }

  cancel() {
    for (const entry of this.pending.values()) entry.controller.abort();
    this.pending.clear();
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.dependencies.thumbnails.dispose();
  }

  private resolveAddresses(hostname: string, signal: AbortSignal): Promise<LookupAddress[]> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      void this.dependencies
        .resolve(hostname)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private async download(url: URL, key: string, signal: AbortSignal): Promise<RemoteImageResponse> {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      signal.throwIfAborted();
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await this.resolveAddresses(hostname, signal);
      signal.throwIfAborted();
      if (!addresses.length || addresses.some(({ address }) => !isPublicImageAddress(address)))
        throw new Error('Image URLs must resolve only to public internet addresses');
      const address = addresses.find((candidate) => candidate.family === 4) ?? addresses[0]!;
      const result = await this.dependencies.download(url, address, signal);
      signal.throwIfAborted();
      if ('redirect' in result) {
        const destination = parseRemoteImageUrl(new URL(result.redirect, url).href);
        if (!destination) throw new Error('Image redirect is not an allowed HTTPS URL');
        url = destination;
        continue;
      }
      const thumbnail = await this.dependencies.thumbnails.getInput(
        key,
        result.bytes,
        result.format,
        signal
      );
      signal.throwIfAborted();
      if (!thumbnail) throw new Error('Image is invalid, unsupported, or exceeds the pixel limit');
      return { url: thumbnail, hostname: url.hostname };
    }
    throw new Error('Image has too many redirects');
  }
}
