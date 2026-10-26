import { expect, test } from '@playwright/test';

for (const width of [360, 1024]) {
  test(`only toggles Explored from its label and chevron at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await page.goto('/e2e/harness/index.html?scenario=tool-cards');

    const summary = page.locator('button.assistant-activity-summary').first();
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');

    const group = summary.locator('..');
    const clickBlankRow = async () => {
      const groupBox = await group.boundingBox();
      const summaryBox = await summary.boundingBox();
      if (!groupBox || !summaryBox) throw new Error('Explored row bounds are missing');
      await page.mouse.click(groupBox.x + groupBox.width - 4, summaryBox.y + summaryBox.height / 2);
    };

    await clickBlankRow();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');

    await summary.locator('.assistant-activity-summary-text').click();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');

    await clickBlankRow();
    await expect(summary).toHaveAttribute('aria-expanded', 'true');

    await summary.locator('.assistant-activity-chevron').click();
    await expect(summary).toHaveAttribute('aria-expanded', 'false');

    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(summary).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Space');
    await expect(summary).toHaveAttribute('aria-expanded', 'false');
  });
}
