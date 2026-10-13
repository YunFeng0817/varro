import { expect, test } from '@playwright/test';

test('starter hints use two columns and share a left edge in a centered narrow group', async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const logo = page.locator('.chat-empty-logo');
  const grid = page.locator('.chat-empty-hint-grid');
  const hints = grid.locator('.chat-empty-hint');
  const newlineHint = hints.nth(4);
  const pasteHint = hints.nth(5);
  await expect(logo).toBeVisible();
  await expect(logo).toHaveCSS('opacity', '0.5');
  await expect(logo).toHaveCSS(
    'filter',
    'grayscale(1) brightness(1.1) drop-shadow(rgba(0, 0, 0, 0.28) 0px 1px 1px)'
  );
  await expect(hints).toHaveCount(6);
  await expect(newlineHint).toHaveText('ShiftEnter new line');
  const pasteModifier = await page.evaluate(() =>
    /Macintosh|Mac OS X/.test(navigator.userAgent) ? 'Cmd' : 'Ctrl'
  );
  await expect(pasteHint).toHaveText(`${pasteModifier}V paste images`);
  await expect(newlineHint).toHaveCSS('opacity', '1');
  const hintColor = await hints.first().evaluate((element) => getComputedStyle(element).color);
  await expect(newlineHint).toHaveCSS('color', hintColor);
  const keycaps = page.locator('.chat-empty-hint kbd');
  await expect(keycaps).toHaveCount(8);
  for (const keycap of await keycaps.all()) {
    await expect(keycap).toHaveCSS('height', '20px');
    await expect(keycap).toHaveCSS('border-radius', '3px');
    await expect(keycap).toHaveCSS('border-top-width', '1px');
    await expect(keycap).toHaveCSS('box-shadow', 'rgba(0, 0, 0, 0.36) 0px 1px 2px 0px');
  }

  const wideBoxes = await hints.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, bottom: box.bottom };
    })
  );
  expect(wideBoxes[0]!.y).toBe(wideBoxes[1]!.y);
  expect(wideBoxes[2]!.y).toBe(wideBoxes[3]!.y);
  expect(wideBoxes[4]!.y).toBe(wideBoxes[5]!.y);
  expect(wideBoxes[4]!.x).toBe(wideBoxes[0]!.x);
  expect(wideBoxes[5]!.x).toBe(wideBoxes[1]!.x);
  expect(wideBoxes[1]!.x).toBeGreaterThan(wideBoxes[0]!.x);
  expect(wideBoxes[2]!.y - wideBoxes[0]!.bottom).toBe(8);
  expect(wideBoxes[4]!.y - wideBoxes[2]!.bottom).toBe(8);

  const logoBox = await logo.boundingBox();
  const gridBox = await grid.boundingBox();
  expect(gridBox!.width).toBe(280);
  await expect(grid).toHaveCSS('column-gap', '12px');
  const messageAreaBox = await page.locator('.interactive-list-shell').boundingBox();
  expect(logoBox!.y + logoBox!.height / 2).toBeCloseTo(
    messageAreaBox!.y + messageAreaBox!.height / 2,
    0
  );
  expect(logoBox!.x + logoBox!.width / 2).toBeCloseTo(
    messageAreaBox!.x + messageAreaBox!.width / 2,
    0
  );
  const emptyStateBox = await page.locator('.chat-empty-state').boundingBox();
  expect(gridBox!.y + gridBox!.height).toBeCloseTo(emptyStateBox!.y + emptyStateBox!.height, 0);
  expect(gridBox!.y).toBeGreaterThan(logoBox!.y + logoBox!.height + 40);
  await expect(hints.nth(3)).toHaveCSS('opacity', '1');

  for (const width of [280, 240]) {
    await page.setViewportSize({ width, height: 800 });
    await expect
      .poll(() =>
        grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
      )
      .toBe(1);
    await expect
      .poll(async () => {
        const box = await logo.boundingBox();
        return box!.x + box!.width / 2;
      })
      .toBeCloseTo(width / 2, 0);
    const narrowEmptyStateBox = await page.locator('.chat-empty-state').boundingBox();
    const center = narrowEmptyStateBox!.x + narrowEmptyStateBox!.width / 2;
    const groupBox = await page.locator('.chat-empty-hints').boundingBox();
    expect(groupBox!.x + groupBox!.width / 2).toBeCloseTo(center, 0);
    const narrowBoxes = await hints.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        const keycap = element.querySelector('kbd')!.getBoundingClientRect();
        return { x: box.x, y: box.y, keycapX: keycap.x, right: box.right };
      })
    );
    for (let index = 0; index < narrowBoxes.length; index++) {
      const box = narrowBoxes[index]!;
      expect(box.keycapX).toBeCloseTo(groupBox!.x, 0);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);
      if (index > 0) expect(box.y).toBeGreaterThan(narrowBoxes[index - 1]!.y);
    }
    const narrowNewlineBox = await newlineHint.boundingBox();
    expect(narrowNewlineBox!.x).toBeCloseTo(groupBox!.x, 0);
    const shiftBox = await newlineHint.locator('kbd').first().boundingBox();
    expect(shiftBox!.x).toBeCloseTo(groupBox!.x, 0);
  }

  await page.setViewportSize({ width: 480, height: 800 });
  await expect
    .poll(() =>
      grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)
    )
    .toBe(2);
});

test('starter hints are semitransparent until the group is hovered', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const hints = page.locator('.chat-empty-hints');
  await expect(hints).toBeVisible();
  await expect(hints).toHaveCSS('opacity', '0.5');
  const dismiss = page.getByRole('button', { name: 'Hide hints' });
  await expect(dismiss).toHaveCSS('opacity', '0');

  await hints.locator('.chat-empty-hint').first().hover();
  await expect(hints).toHaveCSS('opacity', '1');
  await expect(dismiss).toHaveCSS('opacity', '1');

  await hints.locator('.chat-empty-hint').last().hover();
  await expect(hints).toHaveCSS('opacity', '1');

  await page.mouse.move(0, 0);
  await expect(hints).toHaveCSS('opacity', '0.5');
  await expect(dismiss).toHaveCSS('opacity', '0');
});

test('starter hint close button appears when hovering above or beside the hints', async ({
  page,
}) => {
  await page.setViewportSize({ width: 515, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const hints = page.locator('.chat-empty-hints');
  const dismiss = page.getByRole('button', { name: 'Hide hints' });
  await expect(hints).toBeVisible();
  const hintsBox = await hints.boundingBox();
  const dismissBox = await dismiss.boundingBox();
  const positions = [
    { x: hintsBox!.x + hintsBox!.width / 2, y: hintsBox!.y - 16 },
    { x: hintsBox!.x + hintsBox!.width + 48, y: hintsBox!.y + hintsBox!.height / 2 },
    { x: dismissBox!.x + dismissBox!.width / 2, y: dismissBox!.y + dismissBox!.height / 2 },
  ];

  for (const position of positions) {
    await page.mouse.move(0, 0);
    await expect(dismiss).toHaveCSS('opacity', '0');
    await page.mouse.move(position.x, position.y);
    await expect(hints).toHaveCSS('opacity', '1');
    await expect(dismiss).toHaveCSS('opacity', '1');
  }

  await dismiss.click();
  await expect(hints).toBeHidden();
});

test('starter hints can be dismissed from their hover button and stay hidden after reload', async ({
  page,
}) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const hints = page.locator('.chat-empty-hints');
  const logo = page.locator('.chat-empty-logo');
  await expect(hints).toBeVisible();
  const logoBox = await logo.boundingBox();

  await hints.hover();
  const dismiss = page.getByRole('button', { name: 'Hide hints' });
  await expect(dismiss).toHaveCSS('opacity', '1');
  await dismiss.click();
  await expect(hints).toBeHidden();
  expect(await logo.boundingBox()).toEqual(logoBox);

  await page.reload();
  await expect(logo).toBeVisible();
  await expect(hints).toBeHidden();

  await page.goto('/e2e/harness/index.html?scenario=blank&next-chat=1');
  await expect(logo).toBeVisible();
  await expect(hints).toBeHidden();
});

test('starter hint dismissal is accessible by keyboard', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const dismiss = page.getByRole('button', { name: 'Hide hints' });
  await dismiss.focus();
  await expect(dismiss).toHaveCSS('opacity', '1');
  await expect(page.locator('.chat-empty-hints')).toHaveCSS('opacity', '1');

  await page.keyboard.press('Enter');
  await expect(page.locator('.chat-empty-hints')).toBeHidden();
});

test('starter logo centers in the initial message area and stays still while the composer grows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 515, height: 952 });
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const logo = page.locator('.chat-empty-logo');
  const hints = page.locator('.chat-empty-hints');
  const composer = page.locator('.interactive-input-part');
  await expect(logo).toBeVisible();

  for (const height of [952, 800]) {
    await composer.evaluate((element) => {
      element.style.minHeight = '';
    });
    await page.setViewportSize({ width: 515, height });
    const messageAreaBox = await page.locator('.interactive-list-shell').boundingBox();
    const centerY = messageAreaBox!.y + messageAreaBox!.height / 2;
    await expect
      .poll(async () => {
        const box = await logo.boundingBox();
        return box!.y + box!.height / 2;
      })
      .toBeCloseTo(centerY, 0);
    for (const composerHeight of ['160px', '240px']) {
      await composer.evaluate((element, minHeight) => {
        element.style.minHeight = minHeight;
      }, composerHeight);
      await expect
        .poll(async () => {
          const box = await logo.boundingBox();
          return box!.y + box!.height / 2;
        })
        .toBeCloseTo(centerY, 0);
      const logoBox = await logo.boundingBox();
      expect(logoBox!.x + logoBox!.width / 2).toBeCloseTo(515 / 2, 0);
      const hintsBox = await hints.boundingBox();
      const composerBox = await composer.boundingBox();
      expect(hintsBox!.y).toBeGreaterThan(logoBox!.y + logoBox!.height);
      expect(composerBox!.y - (hintsBox!.y + hintsBox!.height)).toBeGreaterThanOrEqual(24);
      expect(composerBox!.y - (hintsBox!.y + hintsBox!.height)).toBeLessThan(60);
    }
  }
});

test('starter hints hide on logo overlap and return when the composer shrinks', async ({
  page,
}) => {
  await page.setViewportSize({ width: 515, height: 637 });
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const logo = page.locator('.chat-empty-logo');
  const hints = page.locator('.chat-empty-hints');
  const composer = page.locator('.interactive-input-part');
  await expect(hints).toBeVisible();
  const logoBox = await logo.boundingBox();
  const hintsBox = await hints.boundingBox();
  const composerBox = await composer.boundingBox();
  const overlapHeight = composerBox!.height + hintsBox!.y - (logoBox!.y + logoBox!.height / 2);

  for (let cycle = 0; cycle < 2; cycle++) {
    await composer.evaluate((element, minHeight) => {
      element.style.minHeight = `${minHeight}px`;
    }, overlapHeight);
    await expect(hints).toBeHidden();
    await expect(hints).toHaveCSS('visibility', 'hidden');
    await expect(hints).toHaveCSS('pointer-events', 'none');
    expect(await logo.boundingBox()).toEqual(logoBox);
    const hiddenHintsBox = await hints.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { y: box.y, height: box.height, bottom: box.bottom };
    });
    expect(hiddenHintsBox.height).toBe(hintsBox!.height);
    expect(hiddenHintsBox.y).toBeLessThan(logoBox!.y + logoBox!.height);
    expect(hiddenHintsBox.bottom).toBeGreaterThan(logoBox!.y);

    await composer.evaluate((element) => {
      element.style.minHeight = '';
    });
    await expect(hints).toBeVisible();
    await expect(hints).toHaveCSS('opacity', '0.5');
    expect(await logo.boundingBox()).toEqual(logoBox);
  }
});

test('starter hints hide in a short narrow viewport and return after resizing taller', async ({
  page,
}) => {
  await page.setViewportSize({ width: 240, height: 400 });
  await page.goto('/e2e/harness/index.html?scenario=blank');

  const hints = page.locator('.chat-empty-hints');
  await expect(page.locator('.chat-empty-logo')).toBeVisible();
  await expect(hints).toBeHidden();

  await page.setViewportSize({ width: 240, height: 800 });
  await expect(hints).toBeVisible();
});

test('starter logo stays semitransparent and the same size on narrow and large screens', async ({
  page,
}) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const logo = page.locator('.chat-empty-logo');
  await expect(logo).toBeVisible();
  const logoHeight = await logo.evaluate((element) => getComputedStyle(element).height);

  for (const width of [480, 960, 1440, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(logo).toBeVisible();
    await expect(logo).toHaveCSS('width', '64px');
    await expect(logo).toHaveCSS('height', logoHeight);
    await expect(logo).toHaveCSS('opacity', '0.5');
  }
});

for (const lightTheme of ['vscode-light', 'vscode-high-contrast-light']) {
  test(`starter logo keeps original colors in ${lightTheme}`, async ({ page }) => {
    await page.goto('/e2e/harness/index.html?scenario=blank');
    const logo = page.locator('.chat-empty-logo');
    await expect(logo).toBeVisible();
    const originalSource = await logo.getAttribute('src');

    await page.locator('body').evaluate((element, theme) => {
      element.classList.remove('vscode-dark', 'vscode-high-contrast');
      element.classList.add(theme);
    }, lightTheme);
    await expect(logo).toHaveCSS('opacity', '0.5');
    await expect(logo).toHaveCSS('filter', 'drop-shadow(rgba(0, 0, 0, 0.28) 0px 1px 1px)');
    expect(await logo.getAttribute('src')).toBe(originalSource);

    await page.locator('body').evaluate((element, theme) => {
      element.classList.remove(theme);
      element.classList.add('vscode-dark');
    }, lightTheme);
    await expect(logo).toHaveCSS('opacity', '0.5');
    await expect(logo).toHaveCSS(
      'filter',
      'grayscale(1) brightness(1.1) drop-shadow(rgba(0, 0, 0, 0.28) 0px 1px 1px)'
    );
  });
}

test('starter keycaps and logo shadow follow VS Code keybinding theme colors', async ({ page }) => {
  await page.goto('/e2e/harness/index.html?scenario=blank');
  const emptyState = page.locator('.chat-empty-state');
  const hints = page.locator('.chat-empty-hints');
  await expect(hints).toBeVisible();

  for (const theme of [
    {
      background: 'rgb(51, 51, 51)',
      foreground: 'rgb(204, 204, 204)',
      border: 'rgb(85, 85, 85)',
      shadow: 'rgb(17, 17, 17)',
    },
    {
      background: 'rgb(238, 238, 238)',
      foreground: 'rgb(51, 51, 51)',
      border: 'rgb(204, 204, 204)',
      shadow: 'rgb(170, 170, 170)',
    },
  ]) {
    await emptyState.evaluate((element, colors) => {
      for (const [name, color] of Object.entries(colors)) {
        element.style.setProperty(`--vscode-keybindingLabel-${name}`, color);
      }
    }, theme);
    await expect(page.locator('.chat-empty-logo')).toHaveCSS(
      'filter',
      `grayscale(1) brightness(1.1) drop-shadow(${theme.shadow} 0px 1px 1px)`
    );
    const keycapStyles = await hints.locator('kbd').evaluateAll((elements) =>
      elements.map((element) => {
        const styles = getComputedStyle(element);
        return {
          background: styles.backgroundColor,
          foreground: styles.color,
          border: styles.borderColor,
          shadow: styles.boxShadow,
        };
      })
    );
    for (const styles of keycapStyles) {
      expect(styles).toEqual({
        background: theme.background,
        foreground: theme.foreground,
        border: theme.border,
        shadow: `${theme.shadow} 0px 1px 2px 0px`,
      });
    }
  }
});
