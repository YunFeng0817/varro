import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';

async function wavePixels(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext('2d');
    if (!context) throw new Error('Logo wave canvas has no 2D context');
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let coloredPixels = 0;
    let checksum = 0;
    const intensities = new Set<number>();
    let orangePixels = 0;
    let whitePixels = 0;
    let maxAlpha = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3]!;
      if (alpha < 24) continue;
      coloredPixels++;
      intensities.add(alpha);
      maxAlpha = Math.max(maxAlpha, alpha);
      checksum += (index + 1) * alpha;
      const red = pixels[index]!;
      const green = pixels[index + 1]!;
      const blue = pixels[index + 2]!;
      if (red > green && green > blue) orangePixels++;
      if (Math.min(red, green, blue) >= 252) whitePixels++;
    }
    return {
      coloredPixels,
      checksum,
      intensities: intensities.size,
      orangePixels,
      whitePixels,
      maxAlpha,
    };
  });
}

async function sampleFrames(canvas: Locator) {
  await canvas.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 0;
        const sample = () => {
          if (++frames >= 12) resolve();
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      })
  );
}

test('logo hover draws moving square waves masked to its graphics, with theme-specific colors', async ({
  page,
}) => {
  await page.setViewportSize({ width: 515, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const logo = page.locator('.chat-empty-logo');
  const canvas = page.locator('.chat-empty-logo-waves');
  await expect(logo).toBeVisible();
  const logoBox = await logo.boundingBox();
  expect(await canvas.boundingBox()).toEqual(logoBox);
  expect(
    await canvas.evaluate((element) => {
      const image = element.parentElement?.querySelector('img');
      return !!image && getComputedStyle(element).maskImage.includes(image.src);
    })
  ).toBe(true);
  await expect(canvas).toHaveCSS('mask-size', '100% 100%');
  await expect(canvas).toHaveCSS('pointer-events', 'none');
  expect((await wavePixels(canvas)).coloredPixels).toBe(0);

  await logo.hover({ position: { x: 16, y: 16 } });
  await expect.poll(async () => (await wavePixels(canvas)).intensities).toBeGreaterThan(1);
  const firstWave = await wavePixels(canvas);
  expect(firstWave.orangePixels).toBe(firstWave.coloredPixels);
  await expect.poll(async () => (await wavePixels(canvas)).checksum).not.toBe(firstWave.checksum);
  expect(await logo.boundingBox()).toEqual(logoBox);
  await test.info().attach('dark-logo-wave', {
    body: await page.locator('.chat-empty-logo-shell').screenshot({
      path: test.info().outputPath('dark-logo-wave.png'),
    }),
    contentType: 'image/png',
  });

  for (const [index, theme] of [
    'vscode-light',
    'vscode-high-contrast-light',
    'vscode-dark',
    'vscode-high-contrast',
  ].entries()) {
    await page.locator('body').evaluate((element, nextTheme) => {
      element.classList.remove(
        'vscode-dark',
        'vscode-light',
        'vscode-high-contrast',
        'vscode-high-contrast-light'
      );
      element.classList.add(nextTheme);
    }, theme);
    const light = theme === 'vscode-light' || theme === 'vscode-high-contrast-light';
    await expect(canvas).toHaveCSS('color', light ? 'rgb(255, 255, 255)' : 'rgb(232, 137, 54)');
    await logo.hover({ position: { x: index % 2 === 0 ? 48 : 16, y: 32 } });
    await expect
      .poll(async () => {
        const pixels = await wavePixels(canvas);
        return (
          pixels.coloredPixels > 0 &&
          (light ? pixels.whitePixels : pixels.orangePixels) === pixels.coloredPixels
        );
      })
      .toBe(true);
    if (theme === 'vscode-light') {
      await page.locator('.chat-empty-logo-shell').screenshot({
        path: test.info().outputPath('light-logo-wave.png'),
      });
    }
  }

  await page.mouse.move(0, 0);
  await expect.poll(async () => (await wavePixels(canvas)).coloredPixels).toBe(0);
});

test('logo waves stop for a still cursor, resume on movement, and do no per-frame DOM writes', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const canvas = page.locator('.chat-empty-logo-waves');
  await expect(page.locator('.chat-empty-logo')).toBeVisible();
  const sampler = await canvas.evaluateHandle((element: HTMLCanvasElement) => {
    const context = element.getContext('2d');
    if (!context) throw new Error('Logo wave canvas has no 2D context');
    const counts = { frames: 0, tiles: 0, mutations: 0 };
    const tileSizes = new Set<number>();
    const clear = context.clearRect.bind(context);
    const fill = context.fillRect.bind(context);
    context.clearRect = (...args) => {
      counts.frames++;
      clear(...args);
    };
    context.fillRect = (...args) => {
      counts.tiles++;
      tileSizes.add(args[2]);
      fill(...args);
    };
    const observer = new MutationObserver((records) => {
      counts.mutations += records.length;
    });
    observer.observe(element.parentElement!, { attributes: true, childList: true, subtree: true });
    return {
      counts,
      tileSizes,
      stop: () => {
        observer.disconnect();
        context.clearRect = clear;
        context.fillRect = fill;
      },
    };
  });

  try {
    await sampleFrames(canvas);
    expect(await sampler.evaluate((sample) => sample.counts)).toEqual({
      frames: 0,
      tiles: 0,
      mutations: 0,
    });
    await page.locator('.chat-empty-logo').hover();
    await sampleFrames(canvas);
    const active = await sampler.evaluate((sample) => sample.counts);
    expect(active.frames).toBeGreaterThan(0);
    expect(active.tiles).toBeGreaterThan(0);
    expect(active.mutations).toBe(0);

    await expect
      .poll(async () => {
        const before = await sampler.evaluate((sample) => sample.counts.frames);
        await sampleFrames(canvas);
        return (await sampler.evaluate((sample) => sample.counts.frames)) - before;
      })
      .toBe(0);
    expect((await wavePixels(canvas)).coloredPixels).toBe(0);
    const stationaryFrames = await sampler.evaluate((sample) => sample.counts.frames);

    await page.locator('.chat-empty-logo').hover({ position: { x: 16, y: 16 } });
    await sampleFrames(canvas);
    const moving = await sampler.evaluate((sample) => sample.counts);
    expect(moving.frames).toBeGreaterThan(stationaryFrames);
    expect(moving.mutations).toBe(0);
    const tileSizes = await sampler.evaluate((sample) => [...sample.tileSizes]);
    expect(tileSizes.length).toBeGreaterThan(1);
    for (const size of tileSizes) {
      expect(
        [1, 2, 3, 4].some((level) => Math.abs(size - (1.5 + level * 0.35) * 1.2) < 0.001)
      ).toBe(true);
    }

    await page.mouse.move(0, 0);
    await expect
      .poll(async () => {
        const before = await sampler.evaluate((sample) => sample.counts.frames);
        await sampleFrames(canvas);
        return (await sampler.evaluate((sample) => sample.counts.frames)) - before;
      })
      .toBe(0);
    expect((await wavePixels(canvas)).coloredPixels).toBe(0);
    await test.info().attach('logo-wave-work-counts', {
      body: JSON.stringify({
        environment: 'Chromium E2E harness',
        idle: { frames: 0, tiles: 0, mutations: 0 },
        hover: active,
        movement: moving,
        stationaryFrames: 0,
        settledFrames: 0,
      }),
      contentType: 'application/json',
    });
  } finally {
    await sampler.evaluate((sample) => sample.stop());
    await sampler.dispose();
  }
});

test('entry waves reach every visible logo tile without further cursor movement', async ({
  page,
}) => {
  await page.setViewportSize({ width: 515, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const logo = page.locator('.chat-empty-logo');
  const canvas = page.locator('.chat-empty-logo-waves');
  await expect(logo).toBeVisible();
  const box = await logo.boundingBox();
  const coverage = await canvas.evaluateHandle((element: HTMLCanvasElement) => {
    const image = element.parentElement?.querySelector('img');
    const context = element.getContext('2d');
    if (!image || !context) throw new Error('Logo image or wave context is missing');
    const mask = document.createElement('canvas');
    mask.width = element.width;
    mask.height = element.height;
    const maskContext = mask.getContext('2d');
    if (!maskContext) throw new Error('Logo coverage mask has no 2D context');
    maskContext.drawImage(image, 0, 0, mask.width, mask.height);
    const maskPixels = maskContext.getImageData(0, 0, mask.width, mask.height).data;
    const expected: number[] = [];
    for (let y = 2; y < mask.height; y += 4) {
      for (let x = 2; x < mask.width; x += 4) {
        const index = (y * mask.width + x) * 4 + 3;
        if (maskPixels[index]! >= 128) expected.push(index);
      }
    }
    const seen = new Set<number>();
    return {
      expected,
      seen,
      sample: () => {
        const pixels = context.getImageData(0, 0, element.width, element.height).data;
        for (const index of expected) {
          if (pixels[index]! >= 24) seen.add(index);
        }
      },
    };
  });
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  try {
    expect(await coverage.evaluate((sample) => sample.expected.length)).toBeGreaterThan(20);
    for (const entry of [
      { x: 2, y: 2 },
      { x: 61, y: 61 },
    ]) {
      await page.mouse.move(0, 0);
      await page.clock.runFor(1200);
      await coverage.evaluate((sample) => sample.seen.clear());
      await page.mouse.move(box!.x + entry.x, box!.y + entry.y);
      for (let frame = 0; frame < 70; frame++) {
        await page.clock.runFor(16);
        await coverage.evaluate((sample) => sample.sample());
      }
      const result = await coverage.evaluate((sample) => ({
        expected: sample.expected.length,
        reached: sample.seen.size,
      }));
      expect(result.reached).toBe(result.expected);
      expect((await wavePixels(canvas)).coloredPixels).toBe(0);
      expect(await logo.boundingBox()).toEqual(box);
    }
  } finally {
    await coverage.dispose();
  }
});

test('the logo entry sweep reaches all tiles during continued slow mouse movement', async ({
  page,
}) => {
  await page.setViewportSize({ width: 515, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const logo = page.locator('.chat-empty-logo');
  const canvas = page.locator('.chat-empty-logo-waves');
  await expect(logo).toBeVisible();
  const box = (await logo.boundingBox())!;
  const coverage = await canvas.evaluateHandle((element: HTMLCanvasElement) => {
    const context = element.getContext('2d')!;
    const fill = context.fillRect.bind(context);
    const seen = new Set<string>();
    context.fillRect = (x, y, width, height) => {
      seen.add(`${x + width / 2},${y + height / 2}`);
      fill(x, y, width, height);
    };
    return {
      seen,
      expected: Math.ceil(element.width / 4) * Math.ceil(element.height / 4),
      stop: () => {
        context.fillRect = fill;
      },
    };
  });
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  try {
    for (let frame = 0; frame < 75; frame++) {
      await page.mouse.move(box.x + 2 + Math.min(frame % 40, 40 - (frame % 40)) * 0.35, box.y + 2);
      await page.clock.runFor(16);
    }
    const result = await coverage.evaluate((sample) => ({
      reached: sample.seen.size,
      expected: sample.expected,
    }));
    expect(result.reached).toBe(result.expected);
    expect(await logo.boundingBox()).toEqual(box);
    await page.mouse.move(0, 0);
    await page.clock.runFor(1200);
    expect((await wavePixels(canvas)).coloredPixels).toBe(0);
  } finally {
    await coverage.evaluate((sample) => sample.stop());
    await coverage.dispose();
  }
});

test('faster cursor movement makes stronger waves without changing the logo geometry', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const logo = page.locator('.chat-empty-logo');
  const canvas = page.locator('.chat-empty-logo-waves');
  await expect(logo).toBeVisible();
  const box = await logo.boundingBox();
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);

  await page.mouse.move(box!.x + 8, box!.y + 16);
  await page.clock.runFor(1200);
  expect((await wavePixels(canvas)).coloredPixels).toBe(0);
  for (const x of [14, 20, 26, 32, 38]) {
    await page.clock.runFor(100);
    await page.mouse.move(box!.x + x, box!.y + 16);
    await page.clock.runFor(16);
  }
  let slowPeak = 0;
  for (let frame = 0; frame < 8; frame++) {
    await page.clock.runFor(16);
    slowPeak = Math.max(slowPeak, (await wavePixels(canvas)).maxAlpha);
  }
  expect(slowPeak).toBeGreaterThan(0);

  await page.mouse.move(0, 0);
  await page.clock.runFor(1200);
  await page.mouse.move(box!.x + 8, box!.y + 16);
  await page.clock.runFor(1200);
  await page.mouse.move(box!.x + 38, box!.y + 16);
  let fastPeak = 0;
  for (let frame = 0; frame < 8; frame++) {
    await page.clock.runFor(16);
    fastPeak = Math.max(fastPeak, (await wavePixels(canvas)).maxAlpha);
  }
  expect(fastPeak).toBeGreaterThan(slowPeak);
  expect(await logo.boundingBox()).toEqual(box);
  await test.info().attach('cursor-speed-comparison', {
    body: JSON.stringify({ slowPeak, fastPeak }),
    contentType: 'application/json',
  });
});

test('logo waves respect reduced motion, including changes during hover', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const logo = page.locator('.chat-empty-logo');
  const canvas = page.locator('.chat-empty-logo-waves');
  await logo.hover();
  await sampleFrames(canvas);
  await expect(canvas).toBeHidden();
  expect((await wavePixels(canvas)).coloredPixels).toBe(0);

  await page.mouse.move(0, 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await logo.hover();
  await expect.poll(async () => (await wavePixels(canvas)).coloredPixels).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(canvas).toBeHidden();
  await expect.poll(async () => (await wavePixels(canvas)).coloredPixels).toBe(0);
});
