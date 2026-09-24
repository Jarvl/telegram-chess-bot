import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { clickBack, openApp, seed } from './support';

// Review Focus 5: a long title or display name must never push the page sideways at phone width.
const LONG_TITLE = 'The Extremely Long Friday Evening Correspondence Chess Club of Manchester';
const LONG_NAME = 'Maximilian Alexander Constantine Wolfgang von Hohenzollern-Sigmaringen';
test.use({ viewport: { width: 390, height: 844 } });

async function fits(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const dir = process.env.SCREENS_DIR;
async function shot(page: Page, name: string): Promise<void> {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`every main screen fits at 390 px (${colorScheme})`, async ({ page }) => {
    const world = await seed('ranked', {}, { groupTitle: LONG_TITLE, bobName: LONG_NAME });
    await openApp(page, { user: world.users.alice.telegram, colorScheme });
    await expect(page.locator('.title')).toHaveText('Your games');
    await fits(page);
    await shot(page, `${colorScheme}-games`);

    await page.locator('[data-nav="groups"]').click();
    await expect(page.locator('[data-group]')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-groups`);

    await page.locator('[data-group]').click();
    await expect(page.locator('[data-action="new-game"]')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-lobby`);

    await page.locator('[data-action="leaderboard"]').click();
    await expect(page.locator('[data-player]')).toHaveCount(2);
    await fits(page);
    await shot(page, `${colorScheme}-leaderboard`);

    await page.locator('[data-player]').filter({ hasText: LONG_NAME }).click();
    await expect(page.locator('.title')).toHaveText(LONG_NAME);
    await fits(page);
    await shot(page, `${colorScheme}-player`);
    await clickBack(page);

    await page.locator('[data-nav="games"]').click();
    await page.locator('[data-game]').click();
    // Not `.cg-wrap`: the games list's own MiniBoard thumbnails carry that class too, so the
    // locator would still be ambiguous for an instant while the list screen unmounts.
    await expect(page.locator('cg-board')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-game`);

    await page.locator('[data-nav="settings"]').click();
    await expect(page.locator('[data-action="about"]')).toBeVisible();
    await expect(page.locator('[data-card="support"]')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-settings`);

    await page.locator('[data-action="tip-custom"]').click();
    await page.locator('[data-tip-input]').fill('12345');
    await expect(page.locator('.tip-hint.bad')).toBeVisible();
    await fits(page);
    await shot(page, `${colorScheme}-settings-tip`);
  });
}
