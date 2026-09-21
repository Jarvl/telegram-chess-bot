import { expect, test } from '@playwright/test';
import { dragMove, openApp, seed } from './support';

test('the opponent sees a move without refreshing', async ({ browser }) => {
  const world = await seed('fresh', { alice: { confirmMoves: false, closeAfterMove: false } });
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await openApp(bob, { user: world.users.bob.telegram, startParam: `g_${world.game!.publicId}` });
  await expect(bob.locator('.cg-wrap')).toBeVisible();
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, {
    user: world.users.alice.telegram,
    startParam: `g_${world.game!.publicId}`,
  });
  await dragMove(alice, 'e2', 'e4');
  await expect(bob.locator('.move-list [data-ply="1"]')).toHaveText('e4', { timeout: 10_000 });
  await expect(bob.locator('.player-bar[data-colour="black"] .clock')).toHaveClass(/active/);
  await aliceContext.close();
  await bobContext.close();
});

test('shows the latest position after the connection drops and comes back', async ({ browser }) => {
  const world = await seed('fresh', { alice: { confirmMoves: false, closeAfterMove: false } });
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await openApp(bob, { user: world.users.bob.telegram, startParam: `g_${world.game!.publicId}` });
  await expect(bob.locator('.cg-wrap')).toBeVisible();
  await bobContext.setOffline(true);
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, {
    user: world.users.alice.telegram,
    startParam: `g_${world.game!.publicId}`,
  });
  await dragMove(alice, 'e2', 'e4');
  await expect(alice.locator('.move-list [data-ply="1"]')).toHaveText('e4');
  await bob.waitForTimeout(1_000);
  await expect(bob.locator('.move-list [data-ply="1"]')).toHaveCount(0);
  await bobContext.setOffline(false);
  await expect(bob.locator('.move-list [data-ply="1"]')).toHaveText('e4', { timeout: 10_000 });
  await aliceContext.close();
  await bobContext.close();
});
