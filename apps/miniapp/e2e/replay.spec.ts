import { expect, test } from '@playwright/test';
import { openApp, seed, tgState } from './support';

test('replays a finished game and reaches analysis and the PGN', async ({ page }) => {
  const world = await seed('finished');
  await openApp(page, {
    user: world.users.carol.telegram,
    startParam: `g_${world.game!.publicId}`,
  });
  // The result banner is now a title/detail pair (`.result-card`), not a single `.banner.result`.
  await expect(page.locator('.result-title')).toHaveText('Black won');
  await expect(page.locator('.result-detail')).toContainText('Checkmate');
  await expect(page.locator('.move-list [data-ply]')).toHaveCount(4);
  await page.locator('[data-ply="2"]').click();
  await expect(page.locator('[data-action="latest"]')).toBeVisible();
  await expect(page.locator('square.last-move')).toHaveCount(2);
  await page.locator('[data-action="next"]').click();
  await expect(page.locator('[data-ply="3"]')).toHaveAttribute('aria-current', 'true');
  await page.locator('[data-action="latest"]').click();
  await expect(page.locator('[data-action="latest"]')).toHaveCount(0);
  await page.locator('[data-action="analyse"]').click();
  expect((await tgState(page)).links[0]).toContain('lichess.org/analysis/pgn/');
  await page.locator('[data-action="pgn"]').click();
  await expect
    .poll(async () => (await tgState(page)).downloads[0]?.file_name)
    .toBe(`${world.game!.publicId}.pgn`);
});
