import { describe, expect, it } from 'vitest';
import { session } from '../src/state/session';
import { Player } from '../src/ui/screens/Player';
import { renderApp } from './support/render';
import { gameSummary, playerRef } from './support/summaryFixtures';

const page = {
  player: {
    ...playerRef('2', '@bob', { rating: 1520, provisional: false }),
    gamesPlayed: 9,
    record: { wins: 5, draws: 1, losses: 3 },
  },
  headToHead: { wins: 2, draws: 0, losses: 1 },
  recentGames: [gameSummary({ id: 'GameRrrrrr' })],
};

describe('Player', () => {
  it('heads the page with the avatar and record and lists recent games as cards', async () => {
    const r = renderApp(
      () => <Player groupId="GrOuPiDxYz" userId="2" />,
      () => ({ status: 200, body: page }),
    );
    await r.flush();
    expect(r.root.querySelector('.player-head .avatar')?.textContent).toBe('B');
    expect(r.root.querySelector('.title')?.textContent).toBe('@bob');
    expect(r.text()).toContain('5 W · 1 D · 3 L');
    expect(r.text()).toContain('Against you: 2 W · 0 D · 1 L');
    expect(r.root.querySelector('.game-card[data-game="GameRrrrrr"]')).not.toBeNull();
  });

  it('opens New game with this player picked from the Challenge button', async () => {
    const r = renderApp(
      () => <Player groupId="GrOuPiDxYz" userId="2" />,
      () => ({ status: 200, body: page }),
    );
    await r.flush();
    await r.click('[data-action="challenge"]');
    expect(r.app.router.current.value).toEqual({
      name: 'newGame',
      groupId: 'GrOuPiDxYz',
      opponentId: '2',
    });
  });

  it('offers no Challenge button on your own page', async () => {
    const r = renderApp(
      () => <Player groupId="GrOuPiDxYz" userId="2" />,
      () => ({ status: 200, body: page }),
    );
    session.value = { ...session.value!, user: { id: '2', name: '@bob', username: 'bob' } };
    await r.flush();
    expect(r.root.querySelector('[data-action="challenge"]')).toBeNull();
  });
});
