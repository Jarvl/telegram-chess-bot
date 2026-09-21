import { expect, test } from '@playwright/test';
import { clickMain, openApp, seed, telegramCalls } from './support';

test('a challenge made in the app is posted to the group and accepted from the lobby', async ({
  browser,
}) => {
  const world = await seed('none');
  const aliceContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  await openApp(alice, {
    user: world.users.alice.telegram,
    startParam: `l_${world.group.publicId}`,
  });
  await expect(alice.locator('.title')).toHaveText('Chess Club');
  await expect(alice.locator('[data-action="group-settings"]')).toBeVisible();
  await alice.locator('[data-action="new-game"]').click();
  await alice.locator('[data-opponent]').filter({ hasText: 'Bob' }).click();
  await alice.locator('[data-time="28800"]').click();
  await clickMain(alice);
  await expect(alice.locator('.toast')).toHaveText('Challenge posted to the group');
  await expect(alice.locator('[data-cancel]')).toBeVisible();
  await expect
    .poll(
      async () => (await telegramCalls()).filter((call) => call.method === 'sendMessage').length,
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  const card = (await telegramCalls()).find((call) => call.method === 'sendMessage');
  expect(String(card?.body.text)).toContain('Alice challenges');

  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await openApp(bob, { user: world.users.bob.telegram, startParam: `l_${world.group.publicId}` });
  await expect(bob.locator('[data-accept]')).toBeVisible();
  await bob.locator('[data-accept]').click();
  await expect(bob.locator('.cg-wrap')).toBeVisible();
  await expect(
    bob.locator('.player-bar[data-colour="white"], .player-bar[data-colour="black"]').first(),
  ).toContainText(/Alice|Bob/);
  await aliceContext.close();
  await bobContext.close();
});

test('the groups screen lists the user’s groups from a profile launch', async ({ page }) => {
  const world = await seed('fresh');
  await openApp(page, { user: world.users.alice.telegram });
  await expect(page.locator('[data-group]')).toHaveText(/Chess Club/);
  await page.locator('[data-group]').click();
  await expect(page.locator('[data-game]')).toHaveCount(1);
});
