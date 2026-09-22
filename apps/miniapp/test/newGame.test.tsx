import { ENGINE_LEVELS, type GameDto } from '@group-chess/shared';
import { describe, expect, it } from 'vitest';
import { NewGame } from '../src/ui/screens/NewGame';
import { gameDto } from './support/gameFixtures';
import { renderApp } from './support/render';

const players = {
  players: [{ id: '2', name: 'Bob', username: 'bob', rating: 1520, provisional: false }],
  bot: null,
};

const withBot = { players: [], bot: { levels: [...ENGINE_LEVELS] } };

const withBotAndPlayers = {
  players: [{ id: '2', name: 'Bob', username: 'bob', rating: 1520, provisional: false }],
  bot: { levels: [...ENGINE_LEVELS] },
};

const engineGame: GameDto = gameDto({ id: 'EnGiNeGam1', engineLevel: 'strong' });

/** Opponent rows (human, open-challenge or bot) currently showing `aria-pressed="true"`. */
function pressedOpponentRows(root: HTMLElement): Element[] {
  return [...root.querySelectorAll('[data-opponent], [data-testid="opponent-bot"]')].filter(
    (el) => el.getAttribute('aria-pressed') === 'true',
  );
}
const challenge = {
  id: 'ChalAaaaaa',
  challenger: { id: '1', name: 'Alice', username: 'alice', rating: 1500, provisional: true },
  opponent: null,
  timePerMove: 28800,
  challengerColour: 'white',
  rated: false,
  status: 'pending',
  createdAt: '2026-09-20T10:00:00.000Z',
  expiresAt: '2026-09-21T10:00:00.000Z',
  viewer: { canAccept: false, canDecline: false, canCancel: true },
};

describe('NewGame', () => {
  it('posts the challenge with the chosen opponent, time, colour and rated flag', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      ({ method }) =>
        method === 'POST' ? { status: 200, body: challenge } : { status: 200, body: players },
    );
    await r.flush();
    expect(r.text()).toContain('Bob');
    await r.click('[data-opponent="2"]');
    await r.click('[data-time="28800"]');
    await r.click('[data-colour="white"]');
    await r.click('[data-rated]');
    window.__tg!.clickMain();
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/groups/GrOuPiDxYz/challenges');
    expect(post?.body).toEqual({
      opponentId: '2',
      timePerMove: 28800,
      colour: 'white',
      rated: false,
    });
    expect(r.app.router.current.value).toEqual({ name: 'lobby', groupId: 'GrOuPiDxYz' });
  });

  it('sends an open challenge with a null opponent and the group defaults', async () => {
    const r = renderApp(
      () => (
        <NewGame
          groupId="GrOuPiDxYz"
          defaults={{ defaultTimePerMove: 259200, ratedDefault: true, allowOpenChallenges: true }}
        />
      ),
      ({ method }) =>
        method === 'POST' ? { status: 200, body: challenge } : { status: 200, body: players },
    );
    await r.flush();
    await r.click('[data-opponent="open"]');
    window.__tg!.clickMain();
    await r.flush();
    expect(r.calls.find((c) => c.method === 'POST')?.body).toEqual({
      opponentId: null,
      timePerMove: 259200,
      colour: 'random',
      rated: true,
    });
  });

  it('explains an empty picker', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: { players: [], bot: null } }),
    );
    await r.flush();
    expect(r.text()).toContain('Reply to their message with /play');
  });

  it('shows the bot row, and its levels once selected, when the picker offers one', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: withBot }),
    );
    await r.flush();
    expect(r.text()).toContain('Play the bot');
    expect(r.text()).not.toContain('Club');
    await r.click('[data-testid="opponent-bot"]');
    expect(r.text()).toContain('Club');
  });

  it('shows no bot row when the picker offers none', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: players }),
    );
    await r.flush();
    expect(r.text()).not.toContain('Play the bot');
  });

  it('forces rated off and disables the switch once the bot is selected', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: withBot }),
    );
    await r.flush();
    await r.click('[data-testid="opponent-bot"]');
    const rated = r.root.querySelector('[data-rated]') as HTMLButtonElement;
    expect(rated.getAttribute('aria-checked')).toBe('false');
    expect(rated.disabled).toBe(true);
  });

  it('shows no rating number anywhere in the level control', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      () => ({ status: 200, body: withBot }),
    );
    await r.flush();
    await r.click('[data-testid="opponent-bot"]');
    expect(r.text()).toContain('Club');
    expect(r.text()).not.toMatch(/\b\d{3,4}\b/);
  });

  it('posts to the engine-games endpoint with the chosen level', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      ({ method }) =>
        method === 'POST' ? { status: 200, body: engineGame } : { status: 200, body: withBot },
    );
    await r.flush();
    await r.click('[data-testid="opponent-bot"]');
    await r.click('[data-testid="bot-level-strong"]');
    window.__tg!.clickMain();
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/groups/GrOuPiDxYz/engine-games');
    expect(post?.body).toEqual({ level: 'strong', colour: 'random', timePerMove: 86400 });
    expect(r.app.router.current.value).toEqual({ name: 'game', gameId: 'EnGiNeGam1' });
  });

  it('picking the bot after a human clears the human and submits an engine game', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      ({ method }) =>
        method === 'POST'
          ? { status: 200, body: engineGame }
          : { status: 200, body: withBotAndPlayers },
    );
    await r.flush();
    await r.click('[data-opponent="2"]');
    await r.click('[data-testid="opponent-bot"]');
    expect(r.root.querySelector('[data-opponent="2"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(r.root.querySelector('[data-testid="opponent-bot"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(pressedOpponentRows(r.root)).toHaveLength(1);
    window.__tg!.clickMain();
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/groups/GrOuPiDxYz/engine-games');
  });

  it('picking a human after the bot clears the bot and submits a challenge', async () => {
    const r = renderApp(
      () => <NewGame groupId="GrOuPiDxYz" />,
      ({ method }) =>
        method === 'POST'
          ? { status: 200, body: challenge }
          : { status: 200, body: withBotAndPlayers },
    );
    await r.flush();
    await r.click('[data-testid="opponent-bot"]');
    await r.click('[data-opponent="2"]');
    expect(r.root.querySelector('[data-testid="opponent-bot"]')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(r.root.querySelector('[data-opponent="2"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(pressedOpponentRows(r.root)).toHaveLength(1);
    // The level list is bot-only UI: once a human is picked it must not still be showing.
    expect(r.text()).not.toContain('Club');
    window.__tg!.clickMain();
    await r.flush();
    const post = r.calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/api/groups/GrOuPiDxYz/challenges');
    expect(post?.body).toMatchObject({ opponentId: '2' });
  });
});
