import { describe, expect, it } from 'vitest';
import { Router } from '../src/router';
import { createTg } from '../src/tg/webapp';
import { installFakeWebApp } from './support/fakeWebApp';

const setup = (closeWhenEmpty: boolean) => {
  installFakeWebApp({ version: '8.0', initData: 'user=x&hash=y' });
  const tg = createTg(window.Telegram!.WebApp);
  return { router: new Router(tg, { closeWhenEmpty }), record: window.__tg! };
};

describe('Router', () => {
  it('pushes, replaces and pops routes and shows the back button below the root', () => {
    const { router, record } = setup(false);
    router.reset({ name: 'groups' });
    expect(router.current.value).toEqual({ name: 'groups' });
    expect(record.backButton.visible).toBe(false);
    router.push({ name: 'lobby', groupId: 'GrOuPiDxYz' });
    expect(record.backButton.visible).toBe(true);
    router.replace({ name: 'newGame', groupId: 'GrOuPiDxYz' });
    expect(router.stack.value).toHaveLength(2);
    expect(router.back()).toBe(true);
    expect(router.current.value).toEqual({ name: 'groups' });
    expect(record.backButton.visible).toBe(false);
    expect(router.back()).toBe(false);
    expect(record.closed).toBe(false);
  });

  it('closes the app from the root when it was opened from a game link', () => {
    const { router, record } = setup(true);
    router.reset({ name: 'game', gameId: 'AbCdEfGhIj' });
    expect(record.backButton.visible).toBe(true);
    record.clickBack();
    expect(record.closed).toBe(true);
  });

  it('pops one level on the Telegram back button', () => {
    const { router, record } = setup(false);
    router.reset({ name: 'groups' });
    router.push({ name: 'settings' });
    record.clickBack();
    expect(router.current.value).toEqual({ name: 'groups' });
  });
});
