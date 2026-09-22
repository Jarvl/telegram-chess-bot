import { describe, expect, it } from 'vitest';
import { Router } from '../src/router';
import { createTg } from '../src/tg/webapp';
import { installFakeWebApp } from './support/fakeWebApp';

const setup = (closeFromRoot = false) => {
  installFakeWebApp({ version: '8.0', initData: 'user=x&hash=y' });
  const tg = createTg(window.Telegram!.WebApp);
  return { router: new Router(tg, { closeFromRoot }), record: window.__tg! };
};

describe('Router', () => {
  it('pushes, replaces and pops within a tab, showing the back button below the root', () => {
    const { router, record } = setup();
    router.select('groups');
    expect(router.current.value).toEqual({ name: 'groups' });
    expect(record.backButton.visible).toBe(false);

    router.push({ name: 'lobby', groupId: 'GrOuPiDxYz' });
    expect(record.backButton.visible).toBe(true);
    router.replace({ name: 'newGame', groupId: 'GrOuPiDxYz' });
    expect(router.current.value).toEqual({ name: 'newGame', groupId: 'GrOuPiDxYz' });

    expect(router.back()).toBe(true);
    expect(router.current.value).toEqual({ name: 'groups' });
    expect(record.backButton.visible).toBe(false);
    expect(record.closed).toBe(false);
  });

  it('starts on the games tab with a loading screen until a launch lands', () => {
    const { router, record } = setup();
    expect(router.tab.value).toBe('games');
    expect(router.current.value).toEqual({ name: 'loading' });
    expect(record.backButton.visible).toBe(false);
  });

  it('lands a launch one screen deep so the back button is free to close', () => {
    const { router, record } = setup(true);
    router.land('games', { name: 'game', gameId: 'AbCdEfGhIj' });
    expect(router.tab.value).toBe('games');
    expect(router.stack.value).toEqual([{ name: 'game', gameId: 'AbCdEfGhIj' }]);
    expect(record.backButton.visible).toBe(true);
    record.clickBack();
    expect(record.closed).toBe(true);
  });

  it('leaves closing to Telegram at the root of a profile launch', () => {
    const { router, record } = setup(false);
    router.land('games', { name: 'games' });
    expect(record.backButton.visible).toBe(false);
    expect(router.back()).toBe(false);
    expect(record.closed).toBe(false);
  });

  it('sends a deep-launched game home when its own tab is tapped', () => {
    const { router } = setup(true);
    router.land('games', { name: 'game', gameId: 'AbCdEfGhIj' });
    router.select('games');
    expect(router.current.value).toEqual({ name: 'games' });
  });

  it('keeps a stack per tab and resumes it on the way back', () => {
    const { router, record } = setup();
    router.land('groups', { name: 'groups' });
    router.push({ name: 'lobby', groupId: 'GrOuPiDxYz' });
    router.push({ name: 'game', gameId: 'AbCdEfGhIj' });

    router.select('games');
    expect(router.current.value).toEqual({ name: 'games' });
    expect(record.backButton.visible).toBe(false);

    router.select('groups');
    expect(router.current.value).toEqual({ name: 'game', gameId: 'AbCdEfGhIj' });
    expect(record.backButton.visible).toBe(true);
    record.clickBack();
    expect(router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
  });

  it('seeds a tab at its root the first time it is selected', () => {
    const { router } = setup();
    router.select('settings');
    expect(router.tab.value).toBe('settings');
    expect(router.stack.value).toEqual([{ name: 'settings' }]);
  });

  it('hides the tab bar on the screens that exist without a session', () => {
    const { router } = setup();
    expect(router.showTabs.value).toBe(false); // loading
    router.land('groups', { name: 'locked', group: { id: 'GrOuPiDxYz', title: 'Club' } });
    expect(router.showTabs.value).toBe(false);
    router.land('games', { name: 'error' });
    expect(router.showTabs.value).toBe(false);
    router.land('games', { name: 'games' });
    expect(router.showTabs.value).toBe(true);
  });

  it('pops one level on the Telegram back button', () => {
    const { router, record } = setup();
    router.land('groups', { name: 'groups' });
    router.push({ name: 'settings' });
    record.clickBack();
    expect(router.current.value).toEqual({ name: 'groups' });
  });
});
