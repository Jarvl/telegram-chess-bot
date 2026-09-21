import { expect, test } from '@playwright/test';
import { harnessGame, openApp, seed, tapMove, tgState } from './support';

test('a 6.0 client gets in-page cancel, no haptics and no swipe lock', async ({ page }) => {
  const world = await seed('fresh', { alice: { confirmMoves: true, closeAfterMove: false } });
  await openApp(page, {
    user: world.users.alice.telegram,
    startParam: `g_${world.game!.publicId}`,
    version: '6.0',
  });
  await tapMove(page, 'e2', 'e4');
  await expect(page.locator('[data-action="cancel-move"]')).toBeVisible();
  const state = await tgState(page);
  expect(state.calls).not.toContain('disableVerticalSwipes');
  expect(state.calls).not.toContain('requestWriteAccess');
  expect(state.haptics).toEqual([]);
  expect(state.secondaryButton).toBeNull();
  await page.locator('[data-action="cancel-move"]').click();
  await expect(page.locator('[data-action="cancel-move"]')).toHaveCount(0);
  expect((await harnessGame(world.game!.publicId)).plyCount).toBe(0);
});

test('a 7.0 client opens the PGN as a link instead of a download', async ({ page }) => {
  const world = await seed('finished');
  await openApp(page, {
    user: world.users.carol.telegram,
    startParam: `g_${world.game!.publicId}`,
    version: '7.0',
  });
  await page.locator('[data-action="pgn"]').click();
  const state = await tgState(page);
  expect(state.downloads).toEqual([]);
  expect(state.links[0]).toContain(`/api/games/${world.game!.publicId}/pgn?token=`);
});
