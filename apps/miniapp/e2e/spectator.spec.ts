import { expect, test } from '@playwright/test';
import { dragMove, harnessGame, openApp, seed } from './support';

test('a spectator cannot lift a piece, and can flip the board', async ({ page }) => {
  const world = await seed('fresh');
  await openApp(page, {
    user: world.users.carol.telegram,
    startParam: `g_${world.game!.publicId}`,
  });
  await expect(page.locator('.cg-wrap')).toBeVisible();
  await dragMove(page, 'e2', 'e4');
  await expect(page.locator('square.move-dest')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect((await harnessGame(world.game!.publicId)).plyCount).toBe(0);
  await expect(page.locator('[data-action="resign"]')).toHaveCount(0);
  await page.locator('[data-action="flip"]').click();
  await expect(page.locator('.cg-wrap.orientation-black')).toBeVisible();
});

test('the player who is not to move cannot lift a piece either', async ({ page }) => {
  const world = await seed('fresh');
  await openApp(page, { user: world.users.bob.telegram, startParam: `g_${world.game!.publicId}` });
  await expect(page.locator('.cg-wrap.orientation-black')).toBeVisible();
  await dragMove(page, 'e7', 'e5', 'black');
  await expect(page.locator('square.move-dest')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect((await harnessGame(world.game!.publicId)).plyCount).toBe(0);
  await expect(page.locator('.player-bar[data-colour="black"]')).toContainText('@bob');
});
