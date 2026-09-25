import { expect, test } from '@playwright/test';
import { dragMove, harnessGame, openApp, seed } from './support';

test('premoves queue without confirming, step, remove, and fire on the opponent’s move', async ({
  browser,
}) => {
  const world = await seed('fresh', {
    alice: { moveConfirmations: 'never' },
    bob: { moveConfirmations: 'always' },
  });
  const gameId = world.game!.publicId;
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await openApp(bob, { user: world.users.bob.telegram, startParam: `g_${gameId}` });
  await expect(bob.locator('.cg-wrap')).toBeVisible();

  await dragMove(bob, 'e7', 'e5', 'black');
  await expect(bob.locator('.move-list [data-premove="1"]')).toHaveText('e5');
  await dragMove(bob, 'g8', 'f6', 'black');
  await expect(bob.locator('.move-list [data-premove="2"]')).toHaveText('Nf6');
  await expect(bob.locator('[data-action="confirm-move"]')).toHaveCount(0);
  expect(await bob.evaluate(() => window.__tg!.calls)).not.toContain('MainButton.show');

  await expect(bob.locator('.premove-label')).toHaveText('Premove 2 of 2');
  await bob.locator('[data-action="premove-prev"]').click();
  await expect(bob.locator('.premove-label')).toHaveText('Premove 1 of 2');
  await bob.locator('[data-action="premove-next"]').click();
  await bob.locator('[data-action="premove-remove"]').click();
  await expect(bob.locator('.move-list [data-premove]')).toHaveCount(1);
  // Chips show before the save lands; Alice's move can only fire what the server already holds.
  await expect.poll(async () => (await harnessGame(gameId)).premoves).toEqual(['e7e5']);

  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, { user: world.users.alice.telegram, startParam: `g_${gameId}` });
  await dragMove(alice, 'e2', 'e4');
  await expect(alice.locator('.move-list [data-ply="2"]')).toHaveText('e5', { timeout: 10_000 });
  await expect(bob.locator('.move-list [data-ply="2"]')).toHaveText('e5', { timeout: 10_000 });
  await expect(bob.locator('.move-list [data-premove]')).toHaveCount(0);
  // Alice never saw the premove chips.
  await expect(alice.locator('.move-list [data-premove]')).toHaveCount(0);
  await aliceContext.close();
  await bobContext.close();
});

test('a cancelled chain shows a toast', async ({ browser }) => {
  const world = await seed('fresh', { alice: { moveConfirmations: 'never' } });
  const gameId = world.game!.publicId;
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await openApp(bob, { user: world.users.bob.telegram, startParam: `g_${gameId}` });
  // Qh4 through the e7 pawn: allowed as a premove, illegal when it fires.
  await dragMove(bob, 'd8', 'h4', 'black');
  await expect(bob.locator('.move-list [data-premove="1"]')).toHaveText('Qh4');
  await expect.poll(async () => (await harnessGame(gameId)).premoves).toEqual(['d8h4']);
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, { user: world.users.alice.telegram, startParam: `g_${gameId}` });
  await dragMove(alice, 'e2', 'e4');
  await expect(bob.locator('.toast')).toContainText('Premoves cancelled', { timeout: 10_000 });
  await expect(bob.locator('.move-list [data-premove]')).toHaveCount(0);
  await aliceContext.close();
  await bobContext.close();
});

test('the chain follows the player across two devices', async ({ browser }) => {
  const world = await seed('fresh');
  const gameId = world.game!.publicId;
  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await openApp(phone, { user: world.users.bob.telegram, startParam: `g_${gameId}` });
  const laptopContext = await browser.newContext();
  const laptop = await laptopContext.newPage();
  await openApp(laptop, { user: world.users.bob.telegram, startParam: `g_${gameId}` });
  await expect(laptop.locator('.cg-wrap')).toBeVisible();
  await dragMove(phone, 'e7', 'e5', 'black');
  await expect(laptop.locator('.move-list [data-premove="1"]')).toHaveText('e5', {
    timeout: 10_000,
  });
  await laptop.locator('[data-action="premove-remove"]').click();
  await expect(phone.locator('.move-list [data-premove]')).toHaveCount(0, { timeout: 10_000 });
  await phoneContext.close();
  await laptopContext.close();
});
