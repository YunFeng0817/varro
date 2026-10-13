import { expect, test } from '@playwright/test';
import type { WebviewMessage } from '../../src/shared/protocol';

interface DictationHarnessWindow extends Window {
  dictationActions?: string[];
  __varroE2E?: { requests: Array<{ path: string }> };
}

for (const width of [360, 900]) {
  test(`Handy button precedes Attach and preserves composer focus at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/e2e/harness/index.html?scenario=blank');
    const composer = page.getByRole('textbox', { name: 'Message composer' }).first();
    await expect(composer).toBeVisible();
    await expect(page.locator('.toolbar-dictation-button')).toHaveCount(0);

    await page.evaluate(() => {
      // SAFETY: The isolated E2E harness installs the typed bridge and request ledger.
      const harness = window as DictationHarnessWindow;
      const originalSend = harness.__sendToExtension;
      harness.dictationActions = [];
      harness.__sendToExtension = (message) => {
        // SAFETY: The composer sends protocol messages through this isolated harness bridge.
        const request = message as WebviewMessage;
        if (request.type !== 'handy/request') return originalSend?.(message);
        harness.dictationActions?.push(request.payload.action);
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'handy/result',
              payload: { requestId: request.payload.requestId, available: true, running: true },
            },
          })
        );
      };
      window.dispatchEvent(new Event('focus'));
    });

    const mic = page.locator('.toolbar-dictation-button');
    const attach = page.getByRole('button', { name: 'Attach files' });
    await expect(mic).toBeEnabled();
    const micBox = await mic.boundingBox();
    const attachBox = await attach.boundingBox();
    expect(micBox).not.toBeNull();
    expect(attachBox).not.toBeNull();
    expect(micBox!.x + micBox!.width).toBeLessThanOrEqual(attachBox!.x);
    expect(Math.abs(micBox!.y - attachBox!.y)).toBeLessThan(1);

    const micIconBox = await mic.locator('.ui-icon').boundingBox();
    const attachIconBox = await attach.locator('.ui-icon').boundingBox();
    const sendBox = await page
      .getByRole('button', { name: 'Send (Enter)', exact: true })
      .boundingBox();
    expect(micIconBox).not.toBeNull();
    expect(attachIconBox).not.toBeNull();
    expect(sendBox).not.toBeNull();
    expect(attachBox!.x - micBox!.x - micBox!.width).toBeCloseTo(4, 1);
    expect(sendBox!.x - attachBox!.x - attachBox!.width).toBeCloseTo(8, 1);
    const micToAttachGap = attachIconBox!.x - micIconBox!.x - micIconBox!.width;
    const attachToSendGap = sendBox!.x - attachIconBox!.x - attachIconBox!.width;
    expect(micToAttachGap - attachToSendGap).toBeCloseTo(0.5, 1);

    await composer.fill('Existing draft. ');
    await mic.click();
    await expect(mic).toHaveAttribute('aria-pressed', 'true');
    await expect(composer).toBeFocused();
    await expect(composer).toHaveText('Existing draft.');
    await mic.click();
    await expect(mic).toHaveAttribute('aria-pressed', 'false');
    await expect(composer).toBeFocused();
    await page.keyboard.insertText('Dictated words');
    await expect(composer).toContainText('Dictated words');

    await mic.click();
    await mic.click({ button: 'right' });
    await expect(mic).toHaveAttribute('aria-pressed', 'false');
    const result = await page.evaluate(() => {
      // SAFETY: These ledgers belong to the isolated test page, not a live session.
      const harness = window as DictationHarnessWindow;
      return {
        actions: harness.dictationActions,
        sends: harness.__varroE2E?.requests.filter((request) =>
          request.path.includes('/prompt_async')
        ).length,
      };
    });
    expect(result.actions).toEqual(['status', 'toggle', 'toggle', 'toggle', 'cancel']);
    expect(result.sends).toBe(0);
  });
}
