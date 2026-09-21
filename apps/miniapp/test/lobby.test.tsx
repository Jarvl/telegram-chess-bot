import type { LobbyDto } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { Lobby } from '../src/ui/screens/Lobby';
import { gameDto } from './support/gameFixtures';
import { renderApp } from './support/render';

const ref = (id: string, name: string) => ({
  id,
  name,
  username: null,
  rating: 1500,
  provisional: true,
});
const summary = (id: string, yourTurn: boolean, status: 'active' | 'finished' = 'active') => ({
  id,
  white: ref('1', 'Alice'),
  black: ref('2', 'Bob'),
  status,
  timePerMove: 86400 as const,
  rated: true,
  plyCount: 3,
  sideToMove: 'black' as const,
  yourTurn,
  deadlineAt: null,
  lastMoveAt: null,
  startedAt: '2026-09-20T10:00:00.000Z',
  finishedAt: status === 'finished' ? '2026-09-20T12:00:00.000Z' : null,
  result: status === 'finished' ? ('1-0' as const) : null,
  endReason: status === 'finished' ? ('resignation' as const) : null,
  voided: false,
});

const lobby: LobbyDto = {
  group: { id: 'GrOuPiDxYz', title: 'Chess Club' },
  isAdmin: true,
  settings: { defaultTimePerMove: 86400, ratedDefault: true, allowOpenChallenges: true },
  active: [summary('GameAaaaaa', false), summary('GameBbbbbb', true)],
  finished: { items: [summary('GameCccccc', false, 'finished')], nextCursor: null },
  challenges: [
    {
      id: 'ChalAaaaaa',
      challenger: ref('2', 'Bob'),
      opponent: ref('1', 'Alice'),
      timePerMove: 86400,
      challengerColour: 'random',
      rated: true,
      status: 'pending',
      createdAt: '2026-09-20T10:00:00.000Z',
      expiresAt: '2026-09-21T10:00:00.000Z',
      viewer: { canAccept: true, canDecline: true, canCancel: false },
    },
  ],
  players: [{ ...ref('2', 'Bob'), gamesPlayed: 9, record: { wins: 5, draws: 1, losses: 3 } }],
};

describe('Lobby', () => {
  it('renders the lobby from the launch data with your-move games first and admin entry points', async () => {
    const r = renderApp(
      (app) => {
        app.prefetched.lobby = lobby;
        return <Lobby groupId="GrOuPiDxYz" />;
      },
      () => ({ status: 200, body: lobby }),
    );
    await r.flush();
    expect(r.calls).toHaveLength(0);
    const rows = [...r.root.querySelectorAll('[data-game]')].map((el) =>
      el.getAttribute('data-game'),
    );
    expect(rows).toEqual(['GameBbbbbb', 'GameAaaaaa']);
    expect(r.text()).toContain('Your move');
    expect(r.text()).toContain('Bob challenges Alice');
    expect(r.text()).toContain('Group settings');
    await r.click('[data-tab="finished"]');
    expect(
      [...r.root.querySelectorAll('[data-game]')].map((el) => el.getAttribute('data-game')),
    ).toEqual(['GameCccccc']);
    expect(r.text()).toContain('1-0');
    await r.click('[data-tab="players"]');
    expect(r.text()).toContain('5 W · 1 D · 3 L');
  });

  it('accepts a challenge through the API and opens the game', async () => {
    const r = renderApp(
      () => <Lobby groupId="GrOuPiDxYz" />,
      ({ path, method }) =>
        method === 'POST' && path === '/api/challenges/ChalAaaaaa/accept'
          ? { status: 200, body: gameDto({ id: 'GameNnnnnn' }) }
          : { status: 200, body: lobby },
    );
    await r.flush();
    expect(r.calls.map((c) => c.path)).toEqual(['/api/groups/GrOuPiDxYz']);
    await r.click('[data-accept="ChalAaaaaa"]');
    expect(r.calls.at(-1)?.path).toBe('/api/challenges/ChalAaaaaa/accept');
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'GameNnnnnn' });
    expect(r.app.prefetched.game?.id).toBe('GameNnnnnn');
  });

  it('opens a game row and the new game screen', async () => {
    const r = renderApp(
      () => <Lobby groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: lobby }),
    );
    await r.flush();
    await r.click('[data-game="GameAaaaaa"]');
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'GameAaaaaa' });
    r.app.router.back();
    await r.click('[data-action="new-game"]');
    expect(r.app.router.current.value).toMatchObject({ name: 'newGame', groupId: 'GrOuPiDxYz' });
  });
});
