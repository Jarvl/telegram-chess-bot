import { describe, expect, it } from 'vitest';
import { Router } from '../src/router';
import { createTg } from '../src/tg/webapp';
import { installFakeWebApp } from './support/fakeWebApp';

const setup = () => {
  installFakeWebApp({ version: '8.0', initData: 'user=x&hash=y' });
  const tg = createTg(window.Telegram!.WebApp);
  return { router: new Router(tg), record: window.__tg! };
};

describe('Router', () => {
  it('pushes, replaces and pops routes and shows the back button below the root', () => {
    const { router, record } = setup();
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

  it('resets to a seeded stack so a deep launch can walk back up', () => {
    const { router, record } = setup();
    router.reset([
      { name: 'groups' },
      { name: 'lobby', groupId: 'GrOuPiDxYz' },
      { name: 'game', gameId: 'AbCdEfGhIj' },
    ]);
    expect(router.current.value).toEqual({ name: 'game', gameId: 'AbCdEfGhIj' });
    expect(record.backButton.visible).toBe(true);
    record.clickBack();
    expect(router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
    record.clickBack();
    expect(router.current.value).toEqual({ name: 'groups' });
    expect(record.backButton.visible).toBe(false);
  });

  it('leaves closing the app to Telegram rather than closing from the root', () => {
    const { router, record } = setup();
    router.reset({ name: 'game', gameId: 'AbCdEfGhIj' });
    expect(record.backButton.visible).toBe(false);
    expect(router.back()).toBe(false);
    expect(record.closed).toBe(false);
  });

  it('pops one level on the Telegram back button', () => {
    const { router, record } = setup();
    router.reset({ name: 'groups' });
    router.push({ name: 'settings' });
    record.clickBack();
    expect(router.current.value).toEqual({ name: 'groups' });
  });
});
