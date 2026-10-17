import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import type { ServerEvent } from '../../src/shared/protocol';
import { waitForHarnessStartup } from './helpers';

async function attachmentGap(attach: Locator, action: Locator): Promise<number> {
  const attachBox = await attach.boundingBox();
  const actionBox = await action.boundingBox();
  if (!attachBox || !actionBox) throw new Error('Composer buttons must be visible');
  return actionBox.x - attachBox.x - attachBox.width;
}

for (const width of [360, 900]) {
  test(`keeps attachment spacing identical for send and stop at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    // A completed assistant intentionally ignores a trailing busy status. Start
    // with a genuinely unfinished reply, then exercise draft and idle controls.
    await page.goto('/e2e/harness/index.html?scenario=busy-stop-send');
    await waitForHarnessStartup(page);
    const attach = page.getByRole('button', { name: 'Attach files', exact: true });
    const send = page.locator('.chat-send-button');
    const stop = page.getByRole('button', { name: 'Stop', exact: true });
    await expect(stop).toBeVisible();
    const stopGap = await attachmentGap(attach, stop);
    expect(stopGap).toBeCloseTo(9, 1);

    const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
    await composer.fill('Follow-up draft');
    await expect(send).toBeVisible();
    expect(await attachmentGap(attach, send)).toBeCloseTo(stopGap, 2);
    await composer.fill('');
    await expect(stop).toBeVisible();
    expect(await attachmentGap(attach, stop)).toBeCloseTo(stopGap, 2);

    await page.evaluate(() => {
      // SAFETY: This transport and session belong to the isolated E2E fixture.
      const harness = (
        window as typeof window & {
          __varroE2E: { replayServerEvent: (event: ServerEvent) => void };
        }
      ).__varroE2E;
      harness.replayServerEvent({
        type: 'session.status',
        properties: { sessionID: 'session-busy-stop-send', status: { type: 'idle' } },
      });
    });
    await expect(send).toBeVisible();
    expect(await attachmentGap(attach, send)).toBeCloseTo(stopGap, 2);
  });
}
