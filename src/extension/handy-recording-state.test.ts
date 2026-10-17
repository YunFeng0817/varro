/* oxlint-disable anti-slop/no-module-mocking -- Exercise lifecycle observation with synthetic logs, never real recordings or installed apps. */
import { EventEmitter } from 'node:events';
import type { WatchOptions } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandyRecordingStateReader } from './handy-recording-state';

class TestWatcher extends EventEmitter {
  close = vi.fn();
}

const mocks = vi.hoisted(() => ({
  file: { content: '', ino: 1, mtimeMs: 1 },
  open: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
  watch:
    vi.fn<
      (
        path: string,
        options: WatchOptions,
        listener: (event: string, name: string | Buffer | null) => void
      ) => TestWatcher
    >(),
}));
vi.mock('node:fs', () => ({ watch: mocks.watch }));
vi.mock('node:fs/promises', () => ({ open: mocks.open }));

const prefix = '[2026-10-17][12:00:00]';
const recording = `${prefix}[handy_app_lib::tray][DEBUG] tray apply: icon=resources/tray_recording_dark.png menu=rebuilt busy=true took=1ms\n`;
const idle = `${prefix}[handy_app_lib::utils][INFO] Operation cancellation completed - returned to idle state\n`;
let reader: HandyRecordingStateReader;
let watcher: TestWatcher;

function append(text: string) {
  mocks.file.content += text;
  mocks.file.mtimeMs++;
}
function event(name: string | Buffer | null = 'handy.log') {
  mocks.watch.mock.calls.at(-1)?.[2]('change', name);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  mocks.file.content = recording;
  mocks.file.ino = 1;
  mocks.file.mtimeMs = 1;
  mocks.open.mockImplementation(async () => ({
    stat: async () => ({
      size: Buffer.byteLength(mocks.file.content),
      dev: 1,
      ino: mocks.file.ino,
      mtimeMs: mocks.file.mtimeMs,
    }),
    read: mocks.read,
    close: mocks.close,
  }));
  mocks.read.mockImplementation(
    async (buffer: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: Buffer.from(mocks.file.content).copy(buffer, offset, position, position + length),
      buffer,
    })
  );
  watcher = new TestWatcher();
  mocks.watch.mockReturnValue(watcher);
  reader = new HandyRecordingStateReader(() => '/handy/logs/handy.log');
});
afterEach(() => {
  reader.dispose();
  vi.useRealTimers();
});

describe('HandyRecordingStateReader', () => {
  it('does no work before an explicit read and creates no idle polling', async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.watch).not.toHaveBeenCalled();
    expect(await reader.read()).toBe('recording');
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });

  it('notifies external cancellation, closes the watcher, and does no further idle reads', async () => {
    await reader.read();
    const notify = vi.fn();
    reader.watch(notify);
    append(idle);
    event();
    await vi.advanceTimersByTimeAsync(100);
    expect(notify).toHaveBeenCalledExactlyOnceWith('idle');
    expect(watcher.close).toHaveBeenCalledTimes(1);
    const reads = mocks.open.mock.calls.length;
    event();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.open).toHaveBeenCalledTimes(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces event bursts and reads only newly appended bytes', async () => {
    await reader.read();
    const notify = vi.fn();
    reader.watch(notify);
    append('ordinary log data\n');
    for (let index = 0; index < 1_000; index++) event();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(mocks.read.mock.calls[1]?.[2]).toBe(Buffer.byteLength('ordinary log data\n'));
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.open).toHaveBeenCalledTimes(2);
  });

  it('bounds initial reads and ignores control-like words inside unrelated log messages', async () => {
    mocks.file.content = `${'noise\n'.repeat(20_000)}${recording}${prefix}[handy_app_lib::actions][DEBUG] Transcription result: ${idle}`;
    expect(await reader.read()).toBe('recording');
    expect(mocks.read.mock.calls[0]?.[2]).toBe(64 * 1024);
  });

  it('handles partial lines and Windows line endings without premature state changes', async () => {
    mocks.file.content = recording + idle.trimEnd();
    expect(await reader.read()).toBe('recording');
    append('\r\n');
    expect(await reader.read()).toBe('idle');
  });

  it('survives rotation and truncation rather than retaining an old recording state', async () => {
    await reader.read();
    mocks.file.content = idle;
    mocks.file.ino++;
    expect(await reader.read()).toBe('idle');
    mocks.file.content = 'new log\n';
    mocks.file.mtimeMs++;
    expect(await reader.read()).toBe('unknown');
  });

  it('does not replay old idle lines over requested-state fallback when logging is disabled', async () => {
    mocks.file.content = idle;
    await reader.read();
    reader.assume('recording');
    expect(await reader.read()).toBe('recording');
    append('ordinary log data\n');
    expect(await reader.read()).toBe('recording');
    append(idle);
    expect(await reader.read()).toBe('idle');
  });

  it('recognises completed text insertion even when Handy omits the final idle tray event', async () => {
    await reader.read();
    const notify = vi.fn();
    reader.watch(notify);
    append(
      `${prefix}[handy_app_lib::actions][DEBUG] TranscribeAction::stop called for binding: transcribe\n`
    );
    event();
    await vi.advanceTimersByTimeAsync(100);
    expect(notify).toHaveBeenLastCalledWith('processing');
    append(`${prefix}[handy_app_lib::actions][DEBUG] Text pasted successfully in 12ms\n`);
    event();
    await vi.advanceTimersByTimeAsync(100);
    expect(notify).toHaveBeenLastCalledWith('idle');
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips missing optional logs and handles watcher failures without throwing', async () => {
    mocks.open.mockRejectedValueOnce(new Error('ENOENT'));
    expect(await reader.read()).toBe('unknown');
    expect(reader.watch(vi.fn())).toBe(false);
    expect(mocks.watch).not.toHaveBeenCalled();
    await reader.read();
    const notify = vi.fn();
    reader.watch(notify);
    watcher.emit('error', new Error('watch unavailable'));
    expect(notify).toHaveBeenCalledWith('unknown');
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores unrelated directory events and accepts buffer or absent file names', async () => {
    await reader.read();
    reader.watch(vi.fn());
    await vi.advanceTimersByTimeAsync(100);
    mocks.open.mockClear();
    event('other.log');
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.open).not.toHaveBeenCalled();
    append('ordinary log data\n');
    event(Buffer.from('handy.log'));
    event(null);
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.open).toHaveBeenCalledTimes(1);
  });

  it('drops in-flight notifications when the host is disposed', async () => {
    await reader.read();
    const notify = vi.fn();
    reader.watch(notify);
    append(idle);
    let release: (() => void) | undefined;
    mocks.read.mockImplementationOnce(
      async (buffer: Buffer, offset: number, length: number, position: number) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          bytesRead: Buffer.from(mocks.file.content).copy(
            buffer,
            offset,
            position,
            position + length
          ),
          buffer,
        };
      }
    );
    event();
    await vi.advanceTimersByTimeAsync(100);
    expect(release).toBeTypeOf('function');
    reader.dispose();
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(notify).not.toHaveBeenCalled();
    expect(watcher.close).toHaveBeenCalledTimes(1);
    expect(reader.state).toBe('unknown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['resources/recording.png', 'recording'],
    ['resources/transcribing.png', 'processing'],
    ['resources/handy.png', 'idle'],
    ['resources/tray_recording.png', 'recording'],
    ['resources/tray_transcribing_dark.png', 'processing'],
  ])('recognises platform-specific tray icon %s', async (icon, state) => {
    mocks.file.content = `${prefix}[handy_app_lib::tray][DEBUG] tray apply: icon=${icon} menu=rebuilt busy=true took=1ms\n`;
    expect(await reader.read()).toBe(state);
  });
});
