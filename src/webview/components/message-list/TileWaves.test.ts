import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTileWaveProfile, TileWaves } from './TileWaves';

describe('TileWaves', () => {
  let now: number;
  let canvas: HTMLCanvasElement;
  let waves: TileWaves | undefined;
  let motion: EventTarget & { matches: boolean };
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn<(x: number, y: number, width: number, height: number) => void>(),
    fillStyle: '',
    globalAlpha: 0,
  };

  function advance(milliseconds: number) {
    now += milliseconds;
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(now);
  }

  beforeEach(() => {
    now = 0;
    nextFrame = 0;
    frames = new Map();
    motion = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => motion)
    );
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 112;
    Object.defineProperty(canvas, 'getContext', { value: () => context });
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 160,
      bottom: 112,
      width: 160,
      height: 112,
      toJSON: () => ({}),
    });
    context.clearRect.mockClear();
    context.fillRect.mockReset();
  });

  afterEach(() => {
    waves?.dispose();
    waves = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('only fills tiles inside the supplied bars and does no idle work', () => {
    waves = new TileWaves(canvas, { containsTile: (x, y) => x < 12 && y < 40 });
    expect(frames.size).toBe(0);
    expect(context.clearRect).not.toHaveBeenCalled();
    waves.enter(2, 2);
    for (let index = 0; index < 60; index++) advance(20);
    expect(context.fillRect).toHaveBeenCalled();
    for (const [x, y, width, height] of context.fillRect.mock.calls) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThan(12);
      expect(y + height).toBeLessThan(40);
    }
    expect(frames.size).toBe(0);
    expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 160, 112);
    const draws = context.clearRect.mock.calls.length;
    advance(200);
    expect(context.clearRect).toHaveBeenCalledTimes(draws);
  });

  it('resumes from movement after stopping and cancels pending work on disposal', () => {
    waves = new TileWaves(canvas);
    waves.enter(10, 10);
    advance(20);
    waves.stop();
    expect(frames.size).toBe(0);
    waves.move(30, 10);
    expect(frames.size).toBe(1);
    waves.dispose();
    expect(frames.size).toBe(0);
  });

  it('clips custom wave highlights to the current histogram tiles as bars resize', () => {
    let height = 20;
    let highlight = false;
    const tileIntensity = vi.fn(() => (highlight ? 1 : 0));
    waves = new TileWaves(canvas, {
      baseOpacity: 0.22,
      baseColor: 'rgb(128 128 128)',
      containsTile: (x, y) => x < 12 && y < height,
      tileIntensity,
    });
    waves.redraw();
    advance(20);
    const initial = [...context.fillRect.mock.calls];
    expect(initial).toHaveLength(15);
    expect(frames.size).toBe(0);

    height = 4;
    highlight = true;
    context.fillRect.mockClear();
    tileIntensity.mockClear();
    waves.redraw(now + 100);
    advance(20);
    expect(context.fillRect.mock.calls).toHaveLength(3);
    expect(tileIntensity).toHaveBeenCalledTimes(3);
    expect(
      context.fillRect.mock.calls.every(([, y, , size]) => {
        const centerY = y + size / 2;
        return centerY < height;
      })
    ).toBe(true);

    height = 20;
    highlight = false;
    context.fillRect.mockClear();
    advance(100);
    expect(context.fillRect.mock.calls).toEqual(initial);
    expect(frames.size).toBe(0);
    const draws = context.clearRect.mock.calls.length;
    advance(100);
    expect(context.clearRect).toHaveBeenCalledTimes(draws);
  });

  it('coalesces rapid pointer movement into one scheduled frame', () => {
    waves = new TileWaves(canvas);
    waves.enter(10, 10);
    for (let x = 11; x < 150; x++) waves.move(x, 10);
    expect(frames.size).toBe(1);
    advance(40);
    expect(frames.size).toBe(1);
  });

  it('lets the logo entry wave reach every tile while the mouse keeps moving slowly', () => {
    canvas.width = 64;
    canvas.height = 64;
    vi.mocked(canvas.getBoundingClientRect).mockReturnValue(new DOMRect(0, 0, 64, 64));
    waves = new TileWaves(canvas);
    waves.enter(2, 2);
    const reached = new Set<string>();
    for (let frame = 0; frame < 75; frame++) {
      context.fillRect.mockClear();
      waves.move(2 + Math.min(frame % 40, 40 - (frame % 40)) * 0.35, 2);
      advance(16);
      for (const [x, y, width, height] of context.fillRect.mock.calls) {
        reached.add(`${x + width / 2},${y + height / 2}`);
      }
    }
    expect(reached.size).toBe(256);
    waves.leave();
    for (let frame = 0; frame < 75; frame++) advance(16);
    expect(frames.size).toBe(0);
  });

  it('stops immediately when reduced motion is enabled and does not restart', () => {
    waves = new TileWaves(canvas);
    waves.enter(10, 10);
    advance(20);
    motion.matches = true;
    motion.dispatchEvent(new Event('change'));
    expect(frames.size).toBe(0);
    waves.enter(20, 10);
    waves.move(30, 10);
    expect(frames.size).toBe(0);
  });

  it('waits for a free slot on rapid reentry instead of replacing a running sweep', () => {
    waves = new TileWaves(canvas);
    for (let entry = 0; entry < 5; entry++) {
      waves.leave();
      waves.enter(10, 10);
    }
    expect(frames.size).toBe(1);
    advance(1000);
    expect(frames.size).toBe(1);
    advance(1000);
    expect(frames.size).toBe(0);
  });

  it('clears and stops when the document becomes hidden', () => {
    waves = new TileWaves(canvas);
    waves.enter(10, 10);
    advance(20);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    expect(context.clearRect).toHaveBeenLastCalledWith(0, 0, 160, 112);
    waves.move(30, 10);
    expect(frames.size).toBe(0);
  });

  it('paints persistent tiles once at rest and animates a changing shape only for the requested duration', () => {
    let height = 20;
    waves = new TileWaves(canvas, {
      baseOpacity: 0.22,
      containsTile: (x, y) => x < 12 && y < height,
    });
    waves.redraw();
    advance(20);
    expect(context.fillRect).toHaveBeenCalled();
    expect(frames.size).toBe(0);
    const initialTiles = context.fillRect.mock.calls.length;
    context.fillRect.mockClear();
    height = 40;
    waves.redraw(now + 100);
    advance(20);
    expect(context.fillRect.mock.calls.length).toBeGreaterThan(initialTiles);
    expect(frames.size).toBe(1);
    advance(100);
    expect(frames.size).toBe(0);
  });

  it('keeps custom animations on one frame loop and stops when they become inactive', () => {
    let active = false;
    const styles = vi.spyOn(window, 'getComputedStyle');
    waves = new TileWaves(canvas, { baseOpacity: 0.22, isAnimating: () => active });
    waves.redraw();
    advance(16);
    expect(frames.size).toBe(0);
    active = true;
    waves.redraw();
    const styleReads = styles.mock.calls.length;
    for (let frame = 0; frame < 20; frame++) {
      advance(16);
      expect(frames.size).toBe(1);
    }
    expect(styles).toHaveBeenCalledTimes(styleReads);
    active = false;
    advance(16);
    expect(frames.size).toBe(0);
    active = true;
    motion.matches = true;
    waves.redraw();
    advance(16);
    expect(frames.size).toBe(0);
  });

  it('applies the logo tile strengths and opacity levels to custom highlights', () => {
    const alphas: number[] = [];
    context.fillRect.mockImplementation(() => {
      alphas.push(context.globalAlpha);
    });
    waves = new TileWaves(canvas, { tileIntensity: () => 1 });
    waves.redraw(100);
    advance(20);

    expect(alphas[0]).toBe(0.12);
    expect(new Set(alphas)).toEqual(new Set([0.12, 0.24, 0.42, 0.66]));
    context.fillRect.mockReset();
  });

  it.each([0, 0.5, 1])('shares the logo wave profile at pointer speed %s', (speed) => {
    const local = getTileWaveProfile(speed);
    expect(local.duration).toBe(1050 - speed * 450);
    expect(local.amplitude).toBeCloseTo(0.55 + speed);
    expect(local.spread).toBeCloseTo((5 + speed * 6) * 1.2);
    const sweep = getTileWaveProfile(speed, true);
    expect(sweep.duration).toBe(1000);
    expect(sweep.amplitude).toBe(1.1);
    expect(sweep.spread).toBe(local.spread);
    expect(sweep.fadeStart).toBe(0.8);
  });

  it('renders identical highlight tile sizes and alpha with or without a dim gray base', () => {
    const capture = (baseOpacity: number) => {
      waves?.dispose();
      const tiles: number[][] = [];
      context.fillRect.mockImplementation((x, y, width, height) => {
        tiles.push([x, y, width, height, context.globalAlpha]);
      });
      waves = new TileWaves(canvas, {
        baseOpacity,
        baseColor: 'rgb(128 128 128)',
        tileIntensity: () => 0.6,
      });
      waves.redraw(100);
      advance(16);
      return tiles;
    };
    const logo = capture(0);
    const histogram = capture(0.22);
    expect(histogram).toEqual(logo);
    expect(new Set(histogram.map((tile) => tile[4]))).toEqual(new Set([0.12, 0.24, 0.42]));
  });
});
