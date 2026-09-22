import type { MeGamesDto } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { App } from '../src/ui/App';
import { Games } from '../src/ui/screens/Games';
import { renderApp } from './support/render';

const ref = (id: string, name: string) => ({
  id,
  name,
  username: null,
  rating: 1500,
  provisional: true,
});

const summary = (id: string, group: string, yourTurn: boolean) => ({
  id,
  white: ref('1', 'Alice'),
  black: ref('2', 'Bob'),
  status: 'active' as const,
  timePerMove: 86400 as const,
  rated: true,
  plyCount: 3,
  sideToMove: 'black' as const,
  yourTurn,
  deadlineAt: null,
  lastMoveAt: null,
  startedAt: '2026-09-20T10:00:00.000Z',
  finishedAt: null,
  result: null,
  endReason: null,
  voided: false,
  group: { id: group, title: group === 'GrOuPiDxYz' ? 'Chess Club' : 'Pub Team' },
});

const games: MeGamesDto = {
  items: [summary('GameBbbbbb', 'GrOuPiDxYz', true), summary('GameAaaaaa', 'OtHeRgRoUp', false)],
};

describe('Games', () => {
  it('lists your games across groups from the launch data, naming each one’s group', async () => {
    const r = renderApp(
      (app) => {
        app.prefetched.games = games;
        return <Games />;
      },
      () => ({ status: 200, body: games }),
    );
    await r.flush();
    expect(r.calls).toHaveLength(0);
    expect(
      [...r.root.querySelectorAll('[data-game]')].map((el) => el.getAttribute('data-game')),
    ).toEqual(['GameBbbbbb', 'GameAaaaaa']);
    expect(r.text()).toContain('Chess Club');
    expect(r.text()).toContain('Pub Team');
    expect(r.text()).toContain('Your move');
  });

  it('opens a game one level deep, so back returns to the list', async () => {
    const r = renderApp(
      (app) => {
        app.prefetched.games = games;
        app.router.land('games', { name: 'games' });
        return <Games />;
      },
      () => ({ status: 200, body: games }),
    );
    await r.flush();
    await r.click('[data-game="GameBbbbbb"]');
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'GameBbbbbb' });
    expect(r.app.router.back()).toBe(true);
    expect(r.app.router.current.value).toEqual({ name: 'games' });
  });

  it('points an empty home at the groups tab', async () => {
    const r = renderApp(
      (app) => {
        app.prefetched.games = { items: [] };
        app.router.land('games', { name: 'games' });
        return <Games />;
      },
      () => ({ status: 200, body: { items: [] } }),
    );
    await r.flush();
    await r.click('[data-action="browse-groups"]');
    expect(r.app.router.tab.value).toBe('groups');
    expect(r.app.router.current.value).toEqual({ name: 'groups' });
  });
});

describe('TabBar', () => {
  it('moves between sections without deepening the stack, and hides where no session exists', async () => {
    const r = renderApp(
      (app) => {
        app.prefetched.games = { items: [] };
        app.router.land('games', { name: 'games' });
        return <App />;
      },
      () => ({ status: 200, body: { groups: [] } }),
    );
    await r.flush();
    expect(r.root.querySelector('[data-nav="games"]')?.className).toContain('active');

    await r.click('[data-nav="settings"]');
    expect(r.app.router.tab.value).toBe('settings');
    expect(r.app.router.stack.value).toHaveLength(1);
    expect(r.tg.available).toBe(true);
    expect(window.__tg!.backButton.visible).toBe(false);

    r.app.router.land('groups', { name: 'locked', group: { id: 'GrOuPiDxYz', title: 'Club' } });
    await r.flush();
    expect(r.root.querySelector('[data-nav="games"]')).toBeNull();
  });
});
